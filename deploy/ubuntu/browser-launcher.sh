#!/bin/sh
# Run one Chromium in a fresh, loopback-only network namespace.
# Native browser launch. Extra fd 3/4 are preserved only for explicit headless self-tests.
set -eu

: "${DARIO_BROWSER_GATEWAY:?Dario must supply the loopback gateway URL}"
: "${DARIO_BROWSER_GATEWAY_SOCKET:?Dario must supply its Unix gateway socket}"
test -S "$DARIO_BROWSER_GATEWAY_SOCKET"
unshare_bin=${DARIO_UNSHARE_EXECUTABLE:-/usr/bin/unshare}
test -x "$unshare_bin"
for tool in ip socat setpriv; do
  command -v "$tool" >/dev/null || { echo "Missing launcher dependency: $tool" >&2; exit 1; }
done

# Map the existing non-root UID rather than root: Chromium retains its own sandbox.
exec "$unshare_bin" --user --map-current-user --keep-caps --net -- /bin/sh -eu -c '
  ip link set lo up
  # The new namespace has no veth, external interface, default route or DNS path.
  test "$(ip -o link show | wc -l)" -eq 1
  test -z "$(ip route show default)"
  test -z "$(ip -6 route show default)"
  port=${DARIO_BROWSER_GATEWAY##*:}
  case "$port" in ""|*[!0-9]*) exit 1 ;; esac
  # This is the only bridge across the network boundary. It cannot open a remote connection.
  socat "TCP4-LISTEN:$port,bind=127.0.0.1,reuseaddr,fork" "UNIX-CONNECT:$DARIO_BROWSER_GATEWAY_SOCKET" 3>&- 4>&- &
  relay_pid=$!
  chrome_pid=
  cleanup() {
    test -z "$chrome_pid" || kill "$chrome_pid" 2>/dev/null || true
    test -z "$chrome_pid" || wait "$chrome_pid" 2>/dev/null || true
    kill "$relay_pid" 2>/dev/null || true
  }
  trap cleanup EXIT
  trap "exit 143" TERM
  trap "exit 130" INT
  attempts=0
  until socat -u OPEN:/dev/null "TCP4:127.0.0.1:$port,connect-timeout=1" 3>&- 4>&- >/dev/null 2>&1; do
    kill -0 "$relay_pid" || exit 1
    attempts=$((attempts + 1)); test "$attempts" -lt 50 || exit 1
    sleep 0.1
  done
  # Drop namespace setup capabilities before Chrome starts. Chromium can create its own child sandbox.
  setpriv --inh-caps=-all --ambient-caps=-all -- "$@" &
  chrome_pid=$!
  wait "$chrome_pid"
' dario-browser "$@"
