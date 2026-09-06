#!/bin/bash
# Helper for driving the dev app through its debug HTTP endpoint (CLAUDEGUI_DEBUG=1).
#   scripts/devctl.sh start            # launch `electron-vite dev` in the background
#   scripts/devctl.sh stop
#   scripts/devctl.sh state
#   scripts/devctl.sh capture out.png
#   scripts/devctl.sh eval 'window.api.app.info()'
#   scripts/devctl.sh send <sessionId> "text"
#   scripts/devctl.sh history <sessionId>
PORT=${CLAUDEGUI_DEBUG_PORT:-45123}
BASE="http://127.0.0.1:$PORT"
cd "$(dirname "$0")/.."
case "$1" in
  start)
    pkill -f "electron-vite dev" 2>/dev/null; pkill -f "ClaudeGUI/node_modules/electron/dist/Electron.app" 2>/dev/null; sleep 1
    (CLAUDEGUI_DEBUG=1 nohup npx electron-vite dev > /tmp/claudegui-dev.log 2>&1 &)
    for i in $(seq 1 60); do curl -s -m 2 "$BASE/state" >/dev/null 2>&1 && { echo "up after ${i}s"; exit 0; }; sleep 1; done
    echo "failed to start"; tail -20 /tmp/claudegui-dev.log; exit 1;;
  stop) pkill -f "electron-vite dev" 2>/dev/null; pkill -f "ClaudeGUI/node_modules/electron/dist/Electron.app" 2>/dev/null; echo stopped;;
  state) curl -s "$BASE/state";;
  capture) curl -s "$BASE/capture?out=${2:-/tmp/claudegui.png}";;
  eval) curl -s -X POST --data-binary "$2" "$BASE/eval";;
  send) curl -s -X POST --data-binary "$3" "$BASE/send?id=$2";;
  history) curl -s "$BASE/history?id=$2";;
  *) echo "unknown command"; exit 1;;
esac
