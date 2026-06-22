#!/usr/bin/env bash
# Start the in-memory engine + frontend dev server together.
# Ctrl-C stops both.

ENGINE_DIR="nde-syncengine-v3-pkg 2"
FRONTEND_DIR="frontend"

# Kill anything already on these ports
lsof -ti:8090 | xargs kill -9 2>/dev/null
lsof -ti:5173 | xargs kill -9 2>/dev/null

# Trap Ctrl-C and kill both child processes
trap 'echo ""; echo "Shutting down…"; kill $ENGINE_PID $FRONTEND_PID 2>/dev/null; exit 0' INT TERM

echo ""
echo "Starting NDE SyncEngine dev server…"
node "$ENGINE_DIR/devServer.js" &
ENGINE_PID=$!

sleep 1

echo "Starting frontend dev server…"
cd "$FRONTEND_DIR" && npm run dev -- --host &
FRONTEND_PID=$!

echo ""
echo "────────────────────────────────────────"
echo "  Engine  →  ws://localhost:8090"
echo "  App     →  http://localhost:5173"
echo "  Press Ctrl-C to stop both"
echo "────────────────────────────────────────"
echo ""

wait
