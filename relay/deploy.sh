#!/usr/bin/env bash
# Ship this directory to the relay host and (re)build the container there. Idempotent, and it never
# touches the host's `.env` once it exists — the join code and admin token are set on the box, not here.
#
#   ./deploy.sh                      # defaults below (the Sprogbroen Hetzner box)
#   OFFICE_RELAY_HOST=deploy@1.2.3.4 ./deploy.sh
set -euo pipefail

HOST="${OFFICE_RELAY_HOST:-deploy@77.42.40.176}"
KEY="${OFFICE_RELAY_KEY:-$HOME/.ssh/sprogbroen_ci}"
# Under the deploy user's home, not /opt: `deploy` has no sudo on the Sprogbroen box (root put
# /opt/sprogbroen there), and the relay needs nothing outside its own directory and the docker socket.
# Expanded on the REMOTE side, so every remote command below quotes it with double quotes.
DIR="${OFFICE_RELAY_DIR:-\$HOME/gg-office-relay}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ssh_do() { ssh -i "$KEY" -o BatchMode=yes "$HOST" "$@"; }

echo "→ ${HOST}:${DIR}"
ssh_do "mkdir -p \"$DIR\""

# Source only — node_modules, dist and .env stay on their respective sides.
tar -C "$here" -czf - package.json package-lock.json tsconfig.json Dockerfile docker-compose.yml .env.example src \
  | ssh_do "tar -C \"$DIR\" -xzf -"

ssh_do "cd \"$DIR\" && [ -f .env ] || { cp .env.example .env; echo '!! .env created from the example — set JOIN_CODE before anyone can join.'; }"
ssh_do "cd \"$DIR\" && docker compose up -d --build"
ssh_do "cd \"$DIR\" && docker compose ps"

# The container publishes no host port (Caddy reaches it over the shared network), so the health read
# happens inside it.
echo "→ health:"
ssh_do "docker exec gg-office-relay node -e \"fetch('http://127.0.0.1:8787/api/health').then(r=>r.text()).then(console.log)\""
