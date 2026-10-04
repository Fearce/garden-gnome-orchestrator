#!/usr/bin/env bash
# Ship this directory to the relay host and (re)build the container there. Idempotent, and it never
# overwrites the host's `.env` once it exists — the join code and admin token are set on the box, not here.
#
#   ./deploy.sh                      # host, key and proxy network from deploy.env (see deploy.env.example)
#   OFFICE_RELAY_HOST=deploy@203.0.113.10 OFFICE_RELAY_NETWORK=caddy_default ./deploy.sh
#   OFFICE_RELAY_RECEIVER=1 OFFICE_RELAY_KEY=~/.ssh/id_ed25519 ./deploy.sh   # relay-only key (README)
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The host is one operator's server, so it lives in the gitignored deploy.env, never in this public file.
# shellcheck source=/dev/null
if [ -f "$here/deploy.env" ]; then . "$here/deploy.env"; fi

HOST="${OFFICE_RELAY_HOST:?set OFFICE_RELAY_HOST (user@host) in relay/deploy.env or the environment; see deploy.env.example}"
KEY="${OFFICE_RELAY_KEY:-$HOME/.ssh/id_ed25519}"
NETWORK="${OFFICE_RELAY_NETWORK:-}"
# Under the deploy user's home, not /opt: a deploy user usually has no sudo, and the relay needs
# nothing outside its own directory and the docker socket.
# Expanded on the REMOTE side, so every remote command below quotes it with double quotes.
DIR="${OFFICE_RELAY_DIR:-\$HOME/gg-office-relay}"

ssh_do() { ssh -i "$KEY" -o BatchMode=yes "$HOST" "$@"; }

# A relay-only key (README "Relay-only deploy keys") runs deploy-receiver.py whatever command is sent, so
# it gets the source in one call and the box's pinned Dockerfile, compose file and .env do the rest.
if [ "${OFFICE_RELAY_RECEIVER:-0}" = 1 ]; then
  echo "→ ${HOST} (relay-only key)"
  tar -C "$here" -czf - package.json package-lock.json tsconfig.json src | ssh_do deploy
  exit
fi

echo "→ ${HOST}:${DIR}"
ssh_do "mkdir -p \"$DIR\""

# Source only — node_modules, dist and .env stay on their respective sides.
tar -C "$here" -czf - package.json package-lock.json tsconfig.json Dockerfile docker-compose.yml .env.example src \
  | ssh_do "tar -C \"$DIR\" -xzf -"

# A fresh host has no .env. Seed it, but do NOT go on to start the stack: the example carries no join
# code, and starting an office whose code came out of a public repository is the one failure that cannot
# be undone by fixing it afterwards. The operator sets the code and re-runs.
if ! ssh_do "cd \"$DIR\" && [ -f .env ]"; then
  ssh_do "cd \"$DIR\" && cp .env.example .env"
  cat <<EOF

!! .env created from the example on ${HOST}, and nothing was started.
   Set JOIN_CODE (20+ random characters) and ADMIN_TOKEN, then run this script again:

     ssh -i "$KEY" $HOST 'cd $DIR && nano .env'

EOF
  exit 1
fi

# docker-compose.yml joins the reverse proxy's network named by RELAY_PROXY_NETWORK, which compose reads
# from the host's .env (so the relay-only receiver sees it too). Add the key only when it is missing.
if [ -n "$NETWORK" ]; then
  ssh_do "cd \"$DIR\" && { grep -q '^RELAY_PROXY_NETWORK=' .env || printf '\nRELAY_PROXY_NETWORK=%s\n' '$NETWORK' >> .env; }"
fi
if ! ssh_do "cd \"$DIR\" && grep -q '^RELAY_PROXY_NETWORK=.' .env"; then
  echo "!! ${HOST}:${DIR}/.env has no RELAY_PROXY_NETWORK. Set OFFICE_RELAY_NETWORK in deploy.env to the" >&2
  echo "   docker network your reverse proxy is on, then run this script again." >&2
  exit 1
fi

ssh_do "cd \"$DIR\" && docker compose up -d --build"
ssh_do "cd \"$DIR\" && docker compose ps"

# The container publishes no host port (Caddy reaches it over the shared network), so the health read
# happens inside it.
echo "→ health:"
ssh_do "docker exec gg-office-relay node -e \"fetch('http://127.0.0.1:8787/api/health').then(r=>r.text()).then(console.log)\""
