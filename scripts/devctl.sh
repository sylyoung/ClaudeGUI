#!/bin/bash
# Helper for driving the dev app through its debug HTTP endpoint (CLAUDEGUI_DEBUG=1).
#   scripts/devctl.sh start            # launch `electron-vite dev` in the background (data dir: sandbox/userdata)
#   scripts/devctl.sh stop
#   scripts/devctl.sh state
#   scripts/devctl.sh host             # session host status (pid, version, live sessions)
#   scripts/devctl.sh update           # updater state
#   scripts/devctl.sh stop-gui         # stop only the window process (the session host keeps running)
#   scripts/devctl.sh capture out.png
#   scripts/devctl.sh eval 'window.api.app.info()'
#   scripts/devctl.sh send <sessionId> "text"
#   scripts/devctl.sh history <sessionId>
PORT=${CLAUDEGUI_DEBUG_PORT:-45123}
BASE="http://127.0.0.1:$PORT"
cd "$(dirname "$0")/.."
# Kill the dev window process (and electron-vite) but never the detached session host (host.mjs).
kill_gui() {
  pkill -f "electron-vite dev" 2>/dev/null
  for pid in $(pgrep -f "ClaudeGUI/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" 2>/dev/null); do
    ps -o command= -p "$pid" | grep -q "out/main/host.mjs" || kill "$pid" 2>/dev/null
  done
}
case "$1" in
  start)
    # Stop a previous dev window but keep a running dev session host (sessions survive, like a real restart).
    kill_gui; sleep 1
    # The dev instance keeps its own settings/sessions so it never collides with an installed ClaudeGUI.
    DATA_DIR=${CLAUDEGUI_USER_DATA:-$PWD/sandbox/userdata}; mkdir -p "$DATA_DIR"
    (CLAUDEGUI_DEBUG=1 CLAUDEGUI_USER_DATA="$DATA_DIR" nohup npx electron-vite dev > /tmp/claudegui-dev.log 2>&1 &)
    for i in $(seq 1 60); do curl -s -m 2 "$BASE/state" >/dev/null 2>&1 && { echo "up after ${i}s"; exit 0; }; sleep 1; done
    echo "failed to start"; tail -20 /tmp/claudegui-dev.log; exit 1;;
  stop) kill_gui; pkill -f "out/main/host.mjs" 2>/dev/null; echo "stopped (gui + session host)";;
  state) curl -s "$BASE/state";;
  host) curl -s "$BASE/host";;
  update) curl -s "$BASE/update";;
  stop-gui) kill_gui; echo "gui stopped (session host left running)";;
  capture) curl -s "$BASE/capture?out=${2:-/tmp/claudegui.png}";;
  eval) curl -s -X POST --data-binary "$2" "$BASE/eval";;
  send) curl -s -X POST --data-binary "$3" "$BASE/send?id=$2";;
  history) curl -s "$BASE/history?id=$2";;
  *) echo "unknown command"; exit 1;;
esac
