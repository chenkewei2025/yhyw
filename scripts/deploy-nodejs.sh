#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

usage() {
  cat <<'USAGE'
Usage:
  scripts/deploy-nodejs.sh [ubuntu@SERVER_HOST] [branch]

Default flow:
  1. Check local git worktree.
  2. Push current branch to GitHub.
  3. SSH to the Ubuntu host.
  4. Pull GitHub code into the Docker volume source path.
  5. Run npm install inside the nodejs container app path.
  6. Restart the 3051 site process/container and health-check it.

Environment overrides:
  REMOTE=ubuntu@124.221.88.94
  BRANCH=main
  REMOTE_APP_DIR=/var/lib/docker/volumes/ubuntu_nodejs_data/_data/model-card-portal
  CONTAINER_APP_DIR=/usr/src/app/model-card-portal
  COMPOSE_DIR=/home/ubuntu
  SERVICE=nodejs
  CONTAINER=nodejs
  APP_USER=node:node
  HEALTH_URL=https://yh.ccyinghe.com/health
  SSH_OPTS="-i ~/.ssh/model-card-deploy"
  YES=1
  SKIP_PUSH=1
  INSTALL_CMD="npm install --omit=dev"
  RESTART_CMD="docker compose restart nodejs"

Examples:
  scripts/deploy-nodejs.sh
  YES=1 scripts/deploy-nodejs.sh ubuntu@124.221.88.94 main
  SSH_OPTS="-i ~/.ssh/model-card-deploy" YES=1 npm run deploy
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" || $# -gt 2 ]]; then
  usage
  exit 0
fi

remote="${1:-${REMOTE:-ubuntu@124.221.88.94}}"
branch="${2:-${BRANCH:-$(git branch --show-current)}}"
remote_app_dir="${REMOTE_APP_DIR:-/var/lib/docker/volumes/ubuntu_nodejs_data/_data/model-card-portal}"
container_app_dir="${CONTAINER_APP_DIR:-/usr/src/app/model-card-portal}"
compose_dir="${COMPOSE_DIR:-/home/ubuntu}"
service="${SERVICE:-nodejs}"
container="${CONTAINER:-$service}"
app_user="${APP_USER:-node:node}"
health_url="${HEALTH_URL:-https://yh.ccyinghe.com/health}"
ssh_opts="${SSH_OPTS:-}"
install_cmd="${INSTALL_CMD:-npm install --omit=dev}"
restart_cmd="${RESTART_CMD:-docker compose restart $service}"

if [[ -z "$branch" ]]; then
  echo "Error: cannot determine git branch. Pass it explicitly: scripts/deploy-nodejs.sh $remote main" >&2
  exit 1
fi

if [[ -n "$(git status --porcelain)" && "${SKIP_PUSH:-}" != "1" ]]; then
  echo "Local worktree has uncommitted changes:" >&2
  git status --short >&2
  echo >&2
  echo "Commit or stash changes before publishing to GitHub." >&2
  exit 1
elif [[ -n "$(git status --porcelain)" ]]; then
  echo "Local worktree has uncommitted changes; continuing because SKIP_PUSH=1." >&2
fi

current_branch="$(git branch --show-current)"
if [[ "$current_branch" != "$branch" ]]; then
  echo "Error: current branch is '$current_branch', requested deploy branch is '$branch'." >&2
  exit 1
fi

local_head="$(git rev-parse HEAD)"
upstream="origin/$branch"

echo "Deploy branch:      $branch"
echo "Local commit:       $local_head"
echo "Remote host:        $remote"
echo "Host app path:      $remote_app_dir"
echo "Container app path: $container_app_dir"
echo "Health URL:         $health_url"
echo

if [[ "${SKIP_PUSH:-}" != "1" ]]; then
  echo "Fetching origin..."
  git fetch origin "$branch"
  if git rev-parse --verify "$upstream" >/dev/null 2>&1; then
    if ! git merge-base --is-ancestor "$upstream" HEAD; then
      echo "Error: local $branch is behind or diverged from $upstream. Pull/rebase first." >&2
      exit 1
    fi
  fi

  echo "Pushing local code to GitHub..."
  git push origin "$branch"
else
  echo "Skipping git push because SKIP_PUSH=1."
fi

if [[ "${YES:-}" != "1" ]]; then
  echo
  read -r -p "Continue remote pull and nodejs restart? [y/N] " answer
  case "$answer" in
    y|Y|yes|YES) ;;
    *) echo "Canceled."; exit 0 ;;
  esac
fi

remote_cmd=$(cat <<REMOTE_SCRIPT
set -euo pipefail
IFS=\$'\\n\\t'

branch="$branch"
remote_app_dir="$remote_app_dir"
container_app_dir="$container_app_dir"
compose_dir="$compose_dir"
container="$container"
app_user="$app_user"
health_url="$health_url"
install_cmd="$install_cmd"
restart_cmd="$restart_cmd"
expected_head="$local_head"
git_remote_url="$(git config --get remote.origin.url)"

mkdir -p "\$remote_app_dir"
cd "\$remote_app_dir"

if [ ! -d .git ]; then
  echo "Bootstrapping git repository in \$remote_app_dir..."
  parent_dir="\$(dirname "\$remote_app_dir")"
  backup_dir="\${remote_app_dir}.pre-git.\$(date +%Y%m%d%H%M%S)"
  if [ -n "\$(find "\$remote_app_dir" -mindepth 1 -maxdepth 1 2>/dev/null | head -n 1)" ]; then
    echo "Backing up existing non-git directory to \$backup_dir"
    mv "\$remote_app_dir" "\$backup_dir"
    mkdir -p "\$remote_app_dir"
  fi
  git clone --branch "\$branch" --single-branch "\$git_remote_url" "\$remote_app_dir"
  for env_file in .env .env.local .env.production; do
    if [ -f "\$backup_dir/\$env_file" ] && [ ! -f "\$remote_app_dir/\$env_file" ]; then
      cp "\$backup_dir/\$env_file" "\$remote_app_dir/\$env_file"
    fi
  done
  cd "\$remote_app_dir"
fi

if [ -n "\$(git status --porcelain)" ]; then
  echo "Error: remote repository has local changes:" >&2
  git status --short >&2
  exit 1
fi

previous_head="\$(git rev-parse HEAD)"
backup_ref="refs/heads/deploy-backup-\$previous_head"
git update-ref "\$backup_ref" "\$previous_head"

rollback() {
  status=\$?
  if [ "\$status" -ne 0 ]; then
    echo "Deployment failed. Rolling back source tree to \$previous_head..." >&2
    cd "\$remote_app_dir"
    git reset --hard "\$previous_head" || true
    echo "Rollback ref kept: \${backup_ref##refs/heads/}" >&2
  else
    git update-ref -d "\$backup_ref" >/dev/null 2>&1 || true
  fi
  exit "\$status"
}
trap rollback EXIT

echo "Pulling GitHub code on host..."
git fetch origin "\$branch" --prune
if git rev-parse --verify "\$branch" >/dev/null 2>&1; then
  git checkout "\$branch"
else
  git checkout -B "\$branch" "origin/\$branch"
fi
git reset --hard "origin/\$branch"
actual_head="\$(git rev-parse HEAD)"
if [ "\$actual_head" != "\$expected_head" ]; then
  echo "Error: remote pulled \$actual_head, expected \$expected_head." >&2
  exit 1
fi

echo "Fixing app directory permissions inside container..."
docker exec -u root "\$container" sh -lc "mkdir -p \"\$container_app_dir\" && chown -R \"\$app_user\" \"\$container_app_dir\""

echo "Installing dependencies inside container..."
docker exec "\$container" sh -lc "cd \"\$container_app_dir\" && \$install_cmd"

if docker exec "\$container" sh -lc "cd \"\$container_app_dir\" && npm run | grep -qE '(^| )build($| )'"; then
  echo "Running build inside container..."
  docker exec "\$container" sh -lc "cd \"\$container_app_dir\" && npm run build"
fi

echo "Restarting nodejs service..."
cd "\$compose_dir"
bash -lc "\$restart_cmd"

echo "Checking health..."
for i in \$(seq 1 20); do
  if curl -fsS "\$health_url"; then
    echo
    echo "Remote deployment finished successfully."
    exit 0
  fi
  sleep 2
  if [ "\$i" -eq 20 ]; then
    echo "Health check failed: \$health_url" >&2
    exit 1
  fi
done
REMOTE_SCRIPT
)

echo
echo "Running remote deployment..."
# shellcheck disable=SC2086
echo "$remote_cmd" | ssh $ssh_opts "$remote" sudo bash

echo
echo "Deploy complete: $branch@$local_head"
