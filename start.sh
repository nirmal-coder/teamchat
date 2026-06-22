#!/bin/bash
set -e

# Start MongoDB + Redis if not already running
if command -v docker &>/dev/null && [ -f docker-compose.yml ]; then
  echo "Starting MongoDB + Redis via docker-compose..."
  docker compose up -d
  sleep 2
fi

# Start server in background
echo "Starting server (HTTP :3000, WS :8090)..."
cd "nde-syncengine-v3-pkg 2"
node server.js &
SERVER_PID=$!
cd ..

# Start frontend dev server
echo "Starting frontend dev server..."
cd frontend
npm run dev &
FRONTEND_PID=$!
cd ..

echo ""
echo "  Server PID: $SERVER_PID"
echo "  Frontend PID: $FRONTEND_PID"
echo ""
echo "  Open: http://localhost:5173"
echo ""
echo "Press Ctrl+C to stop all."

trap "kill $SERVER_PID $FRONTEND_PID 2>/dev/null; exit" INT TERM
wait
