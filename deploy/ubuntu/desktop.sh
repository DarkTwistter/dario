#!/usr/bin/env bash
set -eu
export DISPLAY=:99
Xvfb :99 -screen 0 1440x1000x24 -nolisten tcp &
x_pid=$!
wm_pid=
vnc_pid=
web_pid=
cleanup() {
  for pid in "$web_pid" "$vnc_pid" "$wm_pid" "$x_pid"; do
    test -z "$pid" || kill "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
# Wait for the display rather than racing Openbox against Xvfb.
i=0
until xdpyinfo -display :99 >/dev/null 2>&1; do
  i=$((i + 1)); test "$i" -lt 100 || exit 1
  sleep 0.1
done
openbox &
wm_pid=$!
x11vnc -display :99 -localhost -rfbport 5900 -forever -shared -rfbauth /var/lib/dario/.vnc/passwd &
vnc_pid=$!
websockify --web=/usr/share/novnc 127.0.0.1:6080 127.0.0.1:5900 &
web_pid=$!
wait -n "$x_pid" "$wm_pid" "$vnc_pid" "$web_pid" || true
exit 1
