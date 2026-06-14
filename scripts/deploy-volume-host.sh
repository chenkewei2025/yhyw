#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

usage() {
  cat <<'USAGE'
Usage:
  sudo bash scripts/deploy-volume-host.sh [branch]
  sudo bash scripts/deploy-volume-host.sh /var/lib/docker/volumes/ubuntu_nodejs_data/_data/model-card-portal nodejs [branch]

Environment overrides:
  REMOTE_APP_DIR=/var/lib/docker/volumes/ubuntu_nodejs_data/_data/model-card-portal
  CONTAINER=nodejs
  CONTAINER_APP_DIR=/usr/src/app/model-card-portal
  COMPOSE_DIR=/home/ubuntu
  SERVICE=nodejs
  HEALTH_URL=https://yh.ccyinghe.com/health
  INSTALL_CMD="npm install --omit=dev"
  RESTART_CMD="docker compose restart nodejs"
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ $# -ge 2 ]]; then
  remote_app_dir="${1:-}"
  container="${2:-}"
  branch="${3:-${BRANCH:-main}}"
else
  remote_app_dir="${REMOTE_APP_DIR:-/var/lib/docker/volumes/ubuntu_nodejs_data/_data/model-card-portal}"
  container="${CONTAINER:-nodejs}"
  branch="${1:-${BRANCH:-main}}"
fi

container_app_dir="${CONTAINER_APP_DIR:-/usr/src/app/model-card-portal}"
compose_dir="${COMPOSE_DIR:-/home/ubuntu}"
service="${SERVICE:-nodejs}"
health_url="${HEALTH_URL:-https://yh.ccyinghe.com/health}"
install_cmd="${INSTALL_CMD:-npm install --omit=dev}"
restart_cmd="${RESTART_CMD:-docker compose restart $service}"

if [[ ! -d "$remote_app_dir/.git" ]]; then
  echo "Error: $remote_app_dir is not a git repository." >&2
  exit 1
fi

cd "$remote_app_dir"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Error: repository has local changes:" >&2
  git status --short >&2
  exit 1
fi

previous_head="$(git rev-parse HEAD)"
backup_ref="refs/heads/deploy-backup-$previous_head"
git update-ref "$backup_ref" "$previous_head"

rollback() {
  status=$?
  if [[ "$status" -ne 0 ]]; then
    echo "Deployment failed. Rolling back source tree to $previous_head..." >&2
    cd "$remote_app_dir"
    git reset --hard "$previous_head" || true
    echo "Rollback ref kept: ${backup_ref##refs/heads/}" >&2
  else
    git update-ref -d "$backup_ref" >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap rollback EXIT

echo "Pulling origin/$branch into $remote_app_dir..."
git fetch origin "$branch" --prune
if git rev-parse --verify "$branch" >/dev/null 2>&1; then
  git checkout "$branch"
else
  git checkout -B "$branch" "origin/$branch"
fi
git reset --hard "origin/$branch"

echo "Installing dependencies inside $container:$container_app_dir..."
docker exec "$container" sh -lc "cd \"$container_app_dir\" && $install_cmd"

if docker exec "$container" sh -lc "cd \"$container_app_dir\" && npm run | grep -qE '(^| )build($| )'"; then
  echo "Running build inside container..."
  docker exec "$container" sh -lc "cd \"$container_app_dir\" && npm run build"
fi

echo "Restarting service..."
cd "$compose_dir"
$restart_cmd

echo "Checking health: $health_url"
for i in $(seq 1 20); do
  if curl -fsS "$health_url"; then
    echo
    echo "Deployment finished successfully."
    exit 0
  fi
  sleep 2
  if [[ "$i" -eq 20 ]]; then
    echo "Health check failed: $health_url" >&2
    exit 1
  fi
done
