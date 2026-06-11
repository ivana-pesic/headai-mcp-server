#!/usr/bin/env bash
set -euo pipefail

# ─── Colors ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log()  { echo -e "${BLUE}[local_mcp]${NC} $*"; }
ok()   { echo -e "${GREEN}[ok]${NC} $*"; }
warn() { echo -e "${YELLOW}[warn]${NC} $*"; }
err()  { echo -e "${RED}[error]${NC} $*"; }

# ─── Working directory ────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ─── Config ───────────────────────────────────────────────────────────────────
MCP_PORT="${MCP_PORT:-3001}"
MCP_HOST="${MCP_HOST:-127.0.0.1}"
HEALTH_URL="http://${MCP_HOST}:${MCP_PORT}/health"
MCP_URL="http://${MCP_HOST}:${MCP_PORT}/mcp"

# ─── --stop ───────────────────────────────────────────────────────────────────
if [[ "${1:-}" == "--stop" ]]; then
  log "Stopping all local MCP processes..."
  KILLED=false

  # Kill anything on the port
  PORT_PIDS=$(lsof -ti tcp:"$MCP_PORT" 2>/dev/null || true)
  if [[ -n "$PORT_PIDS" ]]; then
    warn "Found on port $MCP_PORT:"
    while IFS= read -r pid; do
      cmd=$(ps -p "$pid" -o pid=,command= 2>/dev/null || echo "$pid  <already gone>")
      warn "  kill -9 $cmd"
      kill -9 "$pid" 2>/dev/null || true
    done <<< "$PORT_PIDS"
    ok "Port $MCP_PORT cleared"
    KILLED=true
  fi

  # Kill any tsx/node processes running this project's index.ts
  TSX_PIDS=$(pgrep -f "tsx.*headai-mcp-server" 2>/dev/null || true)
  if [[ -n "$TSX_PIDS" ]]; then
    warn "Found tsx processes:"
    while IFS= read -r pid; do
      cmd=$(ps -p "$pid" -o pid=,command= 2>/dev/null || echo "$pid  <already gone>")
      warn "  kill -9 $cmd"
      kill -9 "$pid" 2>/dev/null || true
    done <<< "$TSX_PIDS"
    ok "tsx processes killed"
    KILLED=true
  fi

  NODE_PIDS=$(pgrep -f "node.*headai-mcp-server" 2>/dev/null || true)
  if [[ -n "$NODE_PIDS" ]]; then
    warn "Found node processes:"
    while IFS= read -r pid; do
      cmd=$(ps -p "$pid" -o pid=,command= 2>/dev/null || echo "$pid  <already gone>")
      warn "  kill -9 $cmd"
      kill -9 "$pid" 2>/dev/null || true
    done <<< "$NODE_PIDS"
    ok "node processes killed"
    KILLED=true
  fi

  # Clean up log
  rm -f /tmp/local_mcp.log

  if [[ "$KILLED" == "true" ]]; then
    ok "All clear."
  else
    log "Nothing was running."
  fi
  exit 0
fi

# ─── Mode ─────────────────────────────────────────────────────────────────────
DAEMON_MODE=false
[[ "${1:-}" == "--daemon" ]] && DAEMON_MODE=true

# ─── Cleanup ──────────────────────────────────────────────────────────────────
MCP_PID=""
TAIL_PID=""
CLEANED_UP=false
cleanup() {
  [[ "$CLEANED_UP" == "true" ]] && return
  CLEANED_UP=true
  echo ""
  log "Shutting down..."
  [[ -n "$TAIL_PID" ]] && kill "$TAIL_PID" 2>/dev/null || true
  if [[ -n "$MCP_PID" ]]; then
    # Kill child processes (tsx/node) then the parent (npx)
    pkill -P "$MCP_PID" 2>/dev/null || true
    kill "$MCP_PID" 2>/dev/null || true
  fi
  wait 2>/dev/null || true
  ok "MCP server stopped."
}
trap cleanup EXIT INT TERM

# ─── 1. Check Node ────────────────────────────────────────────────────────────
if ! command -v node &>/dev/null; then
  err "node not found. Install via: brew install node"
  exit 1
fi
ok "node $(node --version)"

# ─── 2. Install deps if needed ───────────────────────────────────────────────
if [[ ! -f node_modules/.package-lock.json ]] && [[ ! -f node_modules/.modules.yaml ]]; then
  log "Dependencies not installed — running npm install..."
  npm install
elif ! node -e "require.resolve('ioredis')" 2>/dev/null; then
  log "Some dependencies missing — running npm install..."
  npm install
fi

# ─── 3. Load .env.local if present ───────────────────────────────────────────
if [[ -f ".env.local" ]]; then
  set -a; source ".env.local"; set +a
  ok ".env.local loaded"
fi

# ─── 4. Require HEADAI_API_KEY ────────────────────────────────────────────────
if [[ -z "${HEADAI_API_KEY:-}" ]]; then
  err "HEADAI_API_KEY is not set."
  err "Add it to ${SCRIPT_DIR}/.env.local or export it before running this script."
  exit 1
fi
ok "HEADAI_API_KEY present (${#HEADAI_API_KEY} chars)"

# ─── 5. Kill anything already on the port or running this project ────────────
EXISTING_PORT=$(lsof -ti tcp:"$MCP_PORT" 2>/dev/null || true)
EXISTING_TSX=$(pgrep -f "tsx.*headai-mcp-server" 2>/dev/null || true)
EXISTING_NODE=$(pgrep -f "node.*headai-mcp-server" 2>/dev/null || true)
EXISTING_ALL=$(sort -u <(echo "$EXISTING_PORT") <(echo "$EXISTING_TSX") <(echo "$EXISTING_NODE") | grep -v '^$' || true)

if [[ -n "$EXISTING_ALL" ]]; then
  warn "Cleaning up before start:"
  while IFS= read -r pid; do
    cmd=$(ps -p "$pid" -o pid=,command= 2>/dev/null || echo "$pid  <already gone>")
    warn "  kill -9 $cmd"
    kill -9 "$pid" 2>/dev/null || true
  done <<< "$EXISTING_ALL"
  sleep 0.5
  ok "Clean slate"
else
  ok "Nothing to clean up"
fi

# ─── 6. Start MCP server ─────────────────────────────────────────────────────
log "Starting MCP server on ${MCP_HOST}:${MCP_PORT}..."

HEADAI_LOCAL_DEV=true \
MCP_TRANSPORT=http \
MCP_ALLOWED_HOSTS="localhost,127.0.0.1,host.docker.internal" \
PORT="$MCP_PORT" \
MCP_HOST="$MCP_HOST" \
MCP_SERVER_BASE_URL="http://${MCP_HOST}:${MCP_PORT}" \
HEADAI_API_KEY="$HEADAI_API_KEY" \
HEADAI_API_URL="${HEADAI_API_URL:-https://megatron.headai.com}" \
  npx tsx src/index.ts &> /tmp/local_mcp.log &

MCP_PID=$!
log "MCP server PID: $MCP_PID"

# ─── 7. Wait for health ───────────────────────────────────────────────────────
log "Waiting for health check at ${HEALTH_URL}..."
MAX_WAIT=30
ELAPSED=0
until curl -sf "$HEALTH_URL" &>/dev/null; do
  if ! kill -0 "$MCP_PID" 2>/dev/null; then
    err "MCP server process died. Last logs:"
    tail -20 /tmp/local_mcp.log
    exit 1
  fi
  if [[ $ELAPSED -ge $MAX_WAIT ]]; then
    err "MCP server did not start within ${MAX_WAIT}s. Last logs:"
    tail -20 /tmp/local_mcp.log
    exit 1
  fi
  sleep 1
  (( ELAPSED++ ))
done

# ─── 8. Ready ─────────────────────────────────────────────────────────────────
echo "$MCP_PID" > /tmp/local_mcp.pid

if [[ "$DAEMON_MODE" == "true" ]]; then
  # Daemon mode: just report and exit — caller owns the process
  ok "MCP server ready (PID $MCP_PID) → ${MCP_URL}"
  trap - EXIT INT TERM  # disown — let the server keep running
  exit 0
fi

echo ""
ok "────────────────────────────────────────"
ok "  MCP server ready"
ok "  Endpoint : ${MCP_URL}"
ok "  Health   : ${HEALTH_URL}"
ok "  Logs     : /tmp/local_mcp.log"
ok "────────────────────────────────────────"
echo ""
log "Press Ctrl+C to stop."

# ─── 9. Keep alive + stream logs ─────────────────────────────────────────────
tail -f /tmp/local_mcp.log &
TAIL_PID=$!
wait "$MCP_PID" || true
