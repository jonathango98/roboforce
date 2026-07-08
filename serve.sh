#!/usr/bin/env bash
set -e

DIRECTORY="$(cd "$(dirname "$0")" && pwd)"
PORT=8080

cleanup() {
  echo ""
  echo "Stopping server..."
  kill "$SERVER_PID" 2>/dev/null
  wait "$SERVER_PID" 2>/dev/null
  exit 0
}

trap cleanup INT TERM

python3 "$DIRECTORY/server.py" &
SERVER_PID=$!

sleep 0.5
open "http://localhost:$PORT"

echo "Serving $DIRECTORY on http://localhost:$PORT (PID $SERVER_PID)"
echo "Press Ctrl+C to stop."

wait "$SERVER_PID"
