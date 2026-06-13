#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/deploy-nodejs.sh [ubuntu@SERVER_HOST]

Environment overrides:
  REMOTE_DIR=/var/lib/docker/volumes/ubuntu_nodejs_data/_data/model-card-portal
  APP_CONTAINER_DIR=/usr/src/app/model-card-portal
  COMPOSE_DIR=/home/ubuntu
  SERVICE=nodejs
  HEALTH_URL=https://yh.ccyinghe.com/health
  SSH_OPTS="-i ~/.ssh/model-card-deploy"
  BUILD=0
  NO_CACHE=1
  YES=1

Examples:
  scripts/deploy-nodejs.sh
  scripts/deploy-nodejs.sh ubuntu@1.2.3.4
  YES=1 scripts/deploy-nodejs.sh ubuntu@124.221.88.94
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" || $# -gt 1 ]]; then
  usage
  exit 1
fi

remote="${1:-${REMOTE:-ubuntu@124.221.88.94}}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_dir="$(cd "$script_dir/.." && pwd)"
remote_dir="${REMOTE_DIR:-/var/lib/docker/volumes/ubuntu_nodejs_data/_data/model-card-portal}"
app_container_dir="${APP_CONTAINER_DIR:-/usr/src/app/model-card-portal}"
compose_dir="${COMPOSE_DIR:-/home/ubuntu}"
service="${SERVICE:-nodejs}"
health_url="${HEALTH_URL:-https://yh.ccyinghe.com/health}"
ssh_opts="${SSH_OPTS:-}"
rsync_ssh=()
if [[ -n "$ssh_opts" ]]; then
  rsync_ssh=(-e "ssh $ssh_opts")
fi

rsync_excludes=(
  --exclude node_modules
  --exclude .git
  --exclude .env
  --exclude ".env.*"
  --exclude .DS_Store
  --exclude npm-debug.log
)

echo "Local:  $project_dir"
echo "Remote: $remote:$remote_dir"
echo "App in container: $app_container_dir"
echo

echo "Previewing files to sync..."
if [[ -n "$ssh_opts" ]]; then
  rsync --rsync-path="sudo rsync" -avzn "${rsync_ssh[@]}" "${rsync_excludes[@]}" "$project_dir/" "$remote:$remote_dir/"
else
  rsync --rsync-path="sudo rsync" -avzn "${rsync_excludes[@]}" "$project_dir/" "$remote:$remote_dir/"
fi

if [[ "${YES:-}" != "1" ]]; then
  echo
  read -r -p "Continue with upload and restart? [y/N] " answer
  case "$answer" in
    y|Y|yes|YES) ;;
    *) echo "Canceled."; exit 0 ;;
  esac
fi

echo
echo "Uploading files..."
if [[ -n "$ssh_opts" ]]; then
  rsync --rsync-path="sudo rsync" -avz "${rsync_ssh[@]}" "${rsync_excludes[@]}" "$project_dir/" "$remote:$remote_dir/"
else
  rsync --rsync-path="sudo rsync" -avz "${rsync_excludes[@]}" "$project_dir/" "$remote:$remote_dir/"
fi

remote_cmd=$'set -e\n'
remote_cmd+="cd \"$compose_dir\""$'\n'

if [[ "${BUILD:-0}" == "1" ]]; then
  build_cmd="docker compose build"
  if [[ "${NO_CACHE:-}" == "1" ]]; then
    build_cmd="$build_cmd --no-cache"
  fi
  remote_cmd+="$build_cmd \"$service\""$'\n'
fi
remote_cmd+="docker compose up -d --no-build \"$service\""$'\n'
remote_cmd+="docker compose restart \"$service\""$'\n'
remote_cmd+="docker compose exec -T \"$service\" sh -lc 'grep -n \"login-name-display-name-20260608\" \"$app_container_dir/public/admin.html\"; grep -n \"login-name-display-name-20260608\" \"$app_container_dir/server/index.js\"; grep -n \"openUserDialogBtn\" \"$app_container_dir/public/admin.html\"'"$'\n'
remote_cmd+="for i in \$(seq 1 15); do curl -fsS \"$health_url\" && break; if [ \"\$i\" -eq 15 ]; then exit 1; fi; sleep 2; done"$'\n'
remote_cmd+="echo"$'\n'

echo
echo "Building and restarting remote service..."
echo "$remote_cmd" | ssh $ssh_opts "$remote" sudo bash

echo
echo "Deploy complete."
