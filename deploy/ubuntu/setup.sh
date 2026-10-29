#!/usr/bin/env bash
# Prepare a fresh Ubuntu 24.04 server. Preserve existing profiles, secrets and Keychain equivalents.
set -Eeuo pipefail
umask 077
trap 'printf "\nSetup failed at line %s. Services were not declared ready. Fix the error and rerun; profiles and secrets are preserved.\n" "$LINENO" >&2' ERR

[[ $EUID -eq 0 ]] || { echo 'Run with sudo bash deploy/ubuntu/setup.sh'; exit 1; }
source /etc/os-release
[[ $ID == ubuntu && $VERSION_ID == 24.04 ]] || { echo 'This installer supports Ubuntu 24.04.'; exit 1; }
case $(uname -m) in
  x86_64) node_arch=x64 ;;
  aarch64|arm64) node_arch=arm64 ;;
  *) echo 'Unsupported architecture; expected x86_64 or arm64.'; exit 1 ;;
esac
skip_services=0
case ${1:-} in
  --skip-services) skip_services=1 ;; # For disposable Linux-container verification only.
  '') ;;
  *) echo 'Usage: setup.sh [--skip-services]'; exit 1 ;;
esac
repo_url=${DARIO_REPO_URL:-https://github.com/DarkTwistter/dario.git}
repo_ref=${DARIO_REPO_REF:-feat/account-proxy-profiles}
repo_dir=/opt/dario
state_dir=/var/lib/dario
node_dir=/opt/dario-node
browser_installer=/opt/dario-browser-installer
export DEBIAN_FRONTEND=noninteractive

echo "Preparing Ubuntu 24.04 / $node_arch"
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl git unzip xz-utils openssl \
  python3 python3-venv xvfb openbox x11vnc novnc websockify x11-utils xauth dbus-x11 \
  iproute2 socat util-linux apparmor apparmor-utils fonts-dejavu-core fonts-liberation \
  fonts-noto-core fonts-noto-color-emoji

if ! id dario >/dev/null 2>&1; then
  useradd --system --user-group --create-home --home-dir "$state_dir" --shell /bin/bash dario
fi
[[ $(getent passwd dario | cut -d: -f6) == "$state_dir" ]] || { echo 'Existing dario user has a different home; refusing to overwrite it.'; exit 1; }
install -d -o dario -g dario -m 0700 "$state_dir" "$state_dir/.dario" "$state_dir/.vnc"
install -d -o root -g dario -m 0750 /etc/dario /usr/local/libexec/dario

# Use the latest maintained Node 22 build from nodejs.org, verifying its published SHA256.
work=$(mktemp -d /tmp/dario-setup.XXXXXX)
curl --fail --silent --show-error --location https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt -o "$work/SHASUMS256.txt"
node_archive=$(awk -v arch="$node_arch" '$2 ~ ("^node-v22\\.[0-9]+\\.[0-9]+-linux-" arch "\\.tar\\.xz$") { print $2; exit }' "$work/SHASUMS256.txt")
[[ -n $node_archive ]] || { echo 'Could not find the official Node archive for this architecture.'; exit 1; }
curl --fail --silent --show-error --location "https://nodejs.org/dist/latest-v22.x/$node_archive" -o "$work/$node_archive"
awk -v file="$node_archive" '$2 == file' "$work/SHASUMS256.txt" > "$work/node.sha256"
(cd "$work" && sha256sum --check node.sha256)
install -d -m 0755 "$node_dir"
tar -xJf "$work/$node_archive" -C "$node_dir" --strip-components=1
export PATH="$node_dir/bin:$state_dir/.bun/bin:$PATH"

if [[ ! -x $state_dir/.bun/bin/bun ]]; then
  curl --fail --silent --show-error --location https://bun.sh/install -o "$work/install-bun.sh"
  chmod 0755 "$work" "$work/install-bun.sh"
  runuser -u dario -- env HOME="$state_dir" BUN_INSTALL="$state_dir/.bun" bash "$work/install-bun.sh" bun-v1.4.4
fi

if [[ ! -d $repo_dir/.git ]]; then
  [[ ! -e $repo_dir ]] || { echo '/opt/dario already exists and is not a Git checkout.'; exit 1; }
  git clone --branch "$repo_ref" --single-branch "$repo_url" "$repo_dir"
else
  # Do not discard local edits or unexpectedly replace a checked-out revision on reruns.
  echo 'Using the existing /opt/dario checkout; update it explicitly when upgrading.'
fi
cd "$repo_dir"
npm ci
npm run build
chmod 0755 deploy/ubuntu/browser-launcher.sh deploy/ubuntu/desktop.sh deploy/ubuntu/setup.sh

# Download an architecture-matched standalone Chromium; no Ubuntu Snap nesting.
# Playwright is only the installer and is not added to Dario's runtime dependencies.
export PLAYWRIGHT_BROWSERS_PATH=/opt/dario-browsers
install -d -m 0755 "$browser_installer" "$PLAYWRIGHT_BROWSERS_PATH"
npm install --prefix "$browser_installer" --no-audit --no-fund playwright@latest
"$browser_installer/node_modules/.bin/playwright" install --with-deps chromium
browser_binary=$(node -e 'process.stdout.write(require("/opt/dario-browser-installer/node_modules/playwright").chromium.executablePath())')
[[ -x $browser_binary ]] || { echo 'Downloaded Chromium executable is missing.'; exit 1; }
# The default root umask is private; browser executable/dependencies must be readable by the service user.
chmod -R a+rX "$node_dir" "$repo_dir" "$browser_installer" "$PLAYWRIGHT_BROWSERS_PATH"
ln -sfn "$browser_binary" /usr/local/libexec/dario/chromium

# Dedicated, root-owned executable for a narrowly scoped AppArmor user-namespace permission.
install -o root -g dario -m 0750 /usr/bin/unshare /usr/local/libexec/dario/unshare
cat > /etc/apparmor.d/dario-browser-userns <<EOF
abi <abi/4.0>,
include <tunables/global>
/usr/local/libexec/dario/unshare flags=(default_allow) {
  userns,
}
"$browser_binary" flags=(default_allow) {
  userns,
}
EOF
if [[ -d /sys/kernel/security/apparmor ]]; then
  apparmor_parser --replace /etc/apparmor.d/dario-browser-userns
fi

if [[ ! -e /etc/dario/dario.env ]]; then
  api_key=$(openssl rand -hex 32)
  admin_token=$(openssl rand -hex 32)
  cat > /etc/dario/dario.env <<EOF
DARIO_HOST=127.0.0.1
DARIO_PORT=3456
DARIO_API_KEY=$api_key
DARIO_ADMIN=1
DARIO_ADMIN_TOKEN=$admin_token
DARIO_REQUIRE_ACCOUNT_PROXY=1
DARIO_IGNORE_CC_CREDENTIALS=1
DARIO_BROWSER_EXECUTABLE=/usr/local/libexec/dario/chromium
DARIO_BROWSER_LAUNCHER=/opt/dario/deploy/ubuntu/browser-launcher.sh
DARIO_UNSHARE_EXECUTABLE=/usr/local/libexec/dario/unshare
DARIO_BROWSER_CHECK_TIMEOUT_MINUTES=30
EOF
  chown root:dario /etc/dario/dario.env
  chmod 0640 /etc/dario/dario.env
fi
if [[ ! -e $state_dir/.vnc/passwd ]]; then
  vnc_password=$(openssl rand -hex 4)
  x11vnc -storepasswd "$vnc_password" "$state_dir/.vnc/passwd" >/dev/null
  printf '%s\n' "$vnc_password" > /etc/dario/vnc-password
  chown dario:dario "$state_dir/.vnc/passwd"
  chmod 0600 "$state_dir/.vnc/passwd" /etc/dario/vnc-password
fi

echo 'Testing the real browser, its isolated network, DNS and WebRTC before starting services...'
runuser -u dario -- env HOME="$state_dir" PATH="$PATH" \
  DARIO_BROWSER_EXECUTABLE=/usr/local/libexec/dario/chromium \
  DARIO_BROWSER_LAUNCHER="$repo_dir/deploy/ubuntu/browser-launcher.sh" \
  DARIO_UNSHARE_EXECUTABLE=/usr/local/libexec/dario/unshare \
  "$state_dir/.bun/bin/bun" scripts/test-profile-browser-privacy.mjs
runuser -u dario -- env HOME="$state_dir" PATH="$PATH" \
  "$state_dir/.bun/bin/bun" scripts/test-profile-bun-transport.mjs

install -m 0644 deploy/ubuntu/dario.service /etc/systemd/system/dario.service
install -m 0644 deploy/ubuntu/dario-desktop.service /etc/systemd/system/dario-desktop.service
install -o root -g root -m 0755 deploy/ubuntu/darioctl /usr/local/bin/darioctl
if [[ $skip_services == 0 ]]; then
  systemctl daemon-reload
  systemctl enable --now dario-desktop.service
  systemctl enable --now dario.service
  for _ in {1..40}; do
    # Empty account pool intentionally reports 503; TCP/HTTP reachability is the startup check.
    if curl --silent --output /dev/null http://127.0.0.1:3456/health; then break; fi
    sleep 0.5
  done
  systemctl is-active --quiet dario.service
  systemctl is-active --quiet dario-desktop.service
  curl --silent --show-error --output /dev/null http://127.0.0.1:3456/health
  for _ in {1..40}; do
    if curl --fail --silent --output /dev/null http://127.0.0.1:6080/vnc.html; then break; fi
    sleep 0.5
  done
  curl --fail --silent --show-error --output /dev/null http://127.0.0.1:6080/vnc.html
fi
printf 'Node: %s\nBun: %s\nPlaywright installer: %s\nGit: %s\n' \
  "$(node --version)" "$("$state_dir/.bun/bin/bun" --version)" \
  "$("$browser_installer/node_modules/.bin/playwright" --version)" "$(git rev-parse HEAD)" > /etc/dario/install-manifest
echo
echo 'Dario prepared. One Dario process, one isolated browser per open profile.'
echo 'On your computer: ssh -N -L 3456:127.0.0.1:3456 -L 6080:127.0.0.1:6080 USER@SERVER'
echo 'Then open: http://127.0.0.1:6080/vnc.html'
echo 'Manage accounts: http://127.0.0.1:3456/profiles/ui'
echo 'Dashboard: http://127.0.0.1:3456/analytics/ui'
echo 'VNC password: sudo cat /etc/dario/vnc-password'
echo 'API/admin secrets: sudo cat /etc/dario/dario.env'
echo 'First profile: see /opt/dario/docs/ubuntu-server.md'
