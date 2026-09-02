#!/bin/zsh

set -u

PROJECT_DIR="${0:A:h:h}"
DATA_DIR="$PROJECT_DIR/data"
PID_FILE="$DATA_DIR/hn-jobs.pid"
SERVER_FILE="$PROJECT_DIR/src/server.ts"

notify() {
  /usr/bin/osascript -e "display notification \"$1\" with title \"HN Job Fetcher\"" >/dev/null 2>&1 || true
}

if [[ ! -f "$PID_FILE" ]]; then
  print "HN Job Fetcher is not running from the desktop shortcut."
  notify "Already stopped"
  exit 0
fi

project_pid="$(<"$PID_FILE")"
if [[ ! "$project_pid" =~ '^[0-9]+$' ]]; then
  print -u2 "The saved process ID is invalid; no process was stopped."
  /bin/rm -f "$PID_FILE"
  notify "Invalid saved process ID was cleared"
  exit 1
fi

if ! /bin/kill -0 "$project_pid" 2>/dev/null; then
  /bin/rm -f "$PID_FILE"
  print "HN Job Fetcher was already stopped."
  notify "Already stopped"
  exit 0
fi

process_command="$(/bin/ps -p "$project_pid" -o command= 2>/dev/null)"
if [[ "$process_command" != *"$SERVER_FILE"* ]]; then
  print -u2 "The saved PID belongs to another process; nothing was stopped."
  /bin/rm -f "$PID_FILE"
  notify "Stale process ID cleared; no process stopped"
  exit 1
fi

/bin/kill -TERM "$project_pid"
for attempt in {1..20}; do
  if ! /bin/kill -0 "$project_pid" 2>/dev/null; then
    break
  fi
  /bin/sleep 0.25
done

if /bin/kill -0 "$project_pid" 2>/dev/null; then
  /bin/kill -KILL "$project_pid"
fi
/bin/rm -f "$PID_FILE"
print "HN Job Fetcher stopped."
notify "Stopped"
