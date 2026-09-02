#!/bin/zsh

set -u

PROJECT_DIR="${0:A:h:h}"
DATA_DIR="$PROJECT_DIR/data"
PID_FILE="$DATA_DIR/hn-jobs.pid"
LOG_FILE="$DATA_DIR/hn-jobs.log"
SERVER_FILE="$PROJECT_DIR/src/server.ts"
APP_URL="http://127.0.0.1:3000"

notify() {
  /usr/bin/osascript -e "display notification \"$1\" with title \"HN Job Fetcher\"" >/dev/null 2>&1 || true
}

is_expected_process() {
  local project_pid="$1"
  if ! /bin/kill -0 "$project_pid" 2>/dev/null; then
    return 1
  fi
  local process_command
  process_command="$(/bin/ps -p "$project_pid" -o command= 2>/dev/null)"
  [[ "$process_command" == *"$SERVER_FILE"* ]]
}

/bin/mkdir -p "$DATA_DIR"

if [[ -f "$PID_FILE" ]]; then
  project_pid="$(<"$PID_FILE")"
  if [[ "$project_pid" =~ '^[0-9]+$' ]] && is_expected_process "$project_pid"; then
    print "HN Job Fetcher is already running (PID $project_pid)."
    notify "Already running"
    /usr/bin/open "$APP_URL"
    exit 0
  fi
  /bin/rm -f "$PID_FILE"
fi

if /usr/sbin/lsof -nP -iTCP:3000 -sTCP:LISTEN >/dev/null 2>&1; then
  print -u2 "Port 3000 is already used by another process. HN Job Fetcher was not started."
  notify "Could not start: port 3000 is already in use"
  exit 1
fi

NODE_BIN="$(command -v node 2>/dev/null || true)"
if [[ -z "$NODE_BIN" && -x /opt/homebrew/bin/node ]]; then
  NODE_BIN=/opt/homebrew/bin/node
fi
if [[ -z "$NODE_BIN" ]]; then
  print -u2 "Node.js was not found. Install Node.js 24 or newer first."
  notify "Could not start: Node.js was not found"
  exit 1
fi

cd "$PROJECT_DIR" || exit 1
PORT=3000 nohup "$NODE_BIN" "$SERVER_FILE" >>"$LOG_FILE" 2>&1 </dev/null &
project_pid=$!
print "$project_pid" >"$PID_FILE"

for attempt in {1..30}; do
  if /usr/bin/curl -fsS "$APP_URL/api/settings" >/dev/null 2>&1; then
    print "HN Job Fetcher started (PID $project_pid)."
    print "Log: $LOG_FILE"
    notify "Started on 127.0.0.1:3000"
    /usr/bin/open "$APP_URL"
    exit 0
  fi
  if ! is_expected_process "$project_pid"; then
    break
  fi
  /bin/sleep 1
done

print -u2 "HN Job Fetcher failed to start. Recent log output:"
/usr/bin/tail -n 20 "$LOG_FILE" 2>/dev/null || true
if is_expected_process "$project_pid"; then
  /bin/kill "$project_pid" 2>/dev/null || true
fi
/bin/rm -f "$PID_FILE"
notify "Failed to start; check the project log"
exit 1
