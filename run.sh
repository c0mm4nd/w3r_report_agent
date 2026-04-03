#!/usr/bin/env bash
# run.sh — Cron-safe entry point for the Web3 Research Report Agent
#
# Cron example (runs daily at 08:00 UTC):
#   0 8 * * * /path/to/web3research/report_agent/run.sh >> /var/log/web3r-agent.log 2>&1
#
# Environment variables can also be set in a .env file in this directory.

set -euo pipefail

# ── Paths ───────────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="${LOG_DIR:-/var/log/web3r-agent}"
LOG_FILE="${LOG_DIR}/agent-$(date +%Y%m%d).log"
LOCK_FILE="/tmp/web3r-agent.lock"

# ── Pre-flight ──────────────────────────────────────────────────────────────────
# Prevent concurrent runs
if [ -f "$LOCK_FILE" ]; then
  LOCK_PID=$(cat "$LOCK_FILE" 2>/dev/null || echo "unknown")
  if kill -0 "$LOCK_PID" 2>/dev/null; then
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Already running (PID $LOCK_PID) — exiting"
    exit 0
  else
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Stale lock removed"
    rm -f "$LOCK_FILE"
  fi
fi
echo $$ > "$LOCK_FILE"
trap 'rm -f "$LOCK_FILE"' EXIT

# ── Logging ─────────────────────────────────────────────────────────────────────
mkdir -p "$LOG_DIR"
exec > >(tee -a "$LOG_FILE") 2>&1

echo ""
echo "══════════════════════════════════════════════════"
echo "  Web3 Research Agent — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "══════════════════════════════════════════════════"

# ── Load .env ───────────────────────────────────────────────────────────────────
if [ -f "$SCRIPT_DIR/.env" ]; then
  set -o allexport
  # shellcheck disable=SC1091
  source "$SCRIPT_DIR/.env"
  set +o allexport
  echo "Loaded .env from $SCRIPT_DIR/.env"
fi

# ── Check required env vars ─────────────────────────────────────────────────────
: "${ANTHROPIC_API_KEY:?ANTHROPIC_API_KEY must be set}"
: "${PRIVATE_KEY:?PRIVATE_KEY must be set}"

# ── Node.js version check ───────────────────────────────────────────────────────
NODE_VERSION=$(node --version 2>/dev/null || echo "none")
echo "Node.js: $NODE_VERSION"
if [[ "$NODE_VERSION" == "none" ]]; then
  echo "ERROR: node not found in PATH"
  exit 1
fi

# ── Run agent ───────────────────────────────────────────────────────────────────
cd "$SCRIPT_DIR"

# Auto-install deps if node_modules missing
if [ ! -d "node_modules" ]; then
  echo "Installing dependencies..."
  npm install --silent
  npx playwright install chromium --with-deps
fi

echo "Starting agent..."
node agent.mjs
EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ]; then
  echo "Agent completed successfully"
else
  echo "Agent exited with code $EXIT_CODE"
fi

exit $EXIT_CODE
