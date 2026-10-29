#!/usr/bin/env bash
# Install the signed, ordinary Google Chrome Stable package and activate it for Dario.
# --prepare-only is used by setup.sh, which runs checks and starts services afterwards.

dario_chrome_arch() {
  case "$1" in
    x86_64|amd64) printf '%s\n' amd64 ;;
    aarch64|arm64) printf '%s\n' arm64 ;;
    *) echo 'Google Chrome installation supports only amd64 and arm64.' >&2; return 1 ;;
  esac
}

dario_chrome_version() {
  local text=$1
  if [[ $text =~ ^Google\ Chrome\ ([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)([[:space:]]|$) ]] && [[ $text != *Testing* && $text != *Chromium* ]]; then
    printf '%s\n' "${BASH_REMATCH[1]}"
  else
    echo 'Expected ordinary Google Chrome Stable, not Chromium or Chrome for Testing.' >&2
    return 1
  fi
}

dario_stable_browser_main() {
  set -Eeuo pipefail
  umask 077
  [[ $EUID -eq 0 ]] || { echo 'Run this script with sudo bash.' >&2; return 1; }
  source /etc/os-release
  [[ $ID == ubuntu && $VERSION_ID == 24.04 ]] || { echo 'Ubuntu 24.04 is required.' >&2; return 1; }
  local prepare_only=0
  case ${1:-} in --prepare-only) prepare_only=1 ;; '') ;; *) echo 'Usage: install-stable-browser.sh [--prepare-only]' >&2; return 1 ;; esac
  local arch
  arch=$(dario_chrome_arch "$(dpkg --print-architecture)")
  local script_dir
  script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
  local repo_dir
  repo_dir=$(cd "$script_dir/../.." && pwd)
  id dario >/dev/null
  if [[ $prepare_only == 0 ]]; then
    [[ -f /etc/dario/dario.env && -f $repo_dir/dist/cli.js && -x /var/lib/dario/.bun/bin/bun ]] || {
      echo 'An existing Dario installation and a current npm run build are required. For a new server run setup.sh.' >&2; return 1;
    }
  fi

  local work
  work=$(mktemp -d /tmp/dario-chrome-stable.XXXXXX)
  # All content here is public package material. Private profile/environment backups live elsewhere.
  chmod 0755 "$work"
  # Capture the private temporary path now; function locals are gone at process exit.
  trap "rm -rf -- '$work'" EXIT
  trap 'echo "Chrome setup failed. If Dario was stopped, it remains stopped; no testing-browser fallback was activated." >&2' ERR
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y --no-install-recommends ca-certificates curl gnupg python3 socat iproute2 util-linux apparmor apparmor-utils
  install -d -m 0700 "$work/gnupg"
  export GNUPGHOME="$work/gnupg"
  curl --fail --silent --show-error --location https://dl.google.com/linux/linux_signing_key.pub -o "$work/google.pub"
  # Google's active primary key, published at https://www.google.com/linuxrepositories/.
  gpg --batch --show-keys --with-colons "$work/google.pub" | awk -F: '
    $1 == "fpr" && $10 == "EB4C1BFD4F042F6DDDCCEC917721F63BD38B4796" { found=1 }
    END { exit !found }
  '
  gpg --batch --yes --dearmor --output "$work/google.gpg" "$work/google.pub"
  chmod 0644 "$work/google.gpg"
  printf 'deb [arch=%s signed-by=%s] https://dl.google.com/linux/chrome/deb/ stable main\n' "$arch" "$work/google.gpg" > "$work/google.list"
  chmod 0644 "$work/google.list"
  install -d -m 0755 "$work/lists" "$work/packages"
  chown _apt:root "$work/packages"
  local chrome_apt=(-o "Dir::Etc::sourcelist=$work/google.list" -o Dir::Etc::sourceparts=- -o "Dir::State::lists=$work/lists")
  # Use private APT metadata so neither Ubuntu's sources nor Google's package-managed source is replaced.
  apt-get "${chrome_apt[@]}" update
  (cd "$work/packages" && apt-get "${chrome_apt[@]}" download "google-chrome-stable:$arch")
  local packages=("$work/packages"/google-chrome-stable_*_"$arch".deb)
  [[ ${#packages[@]} -eq 1 && -f ${packages[0]} ]] || { echo 'Could not obtain the signed Stable package for this architecture.' >&2; return 1; }
  apt-get install -y --no-install-recommends "${packages[0]}"

  local browser_binary=/opt/google/chrome/chrome
  [[ -x $browser_binary ]] || { echo 'Installed Google Chrome executable is missing.' >&2; return 1; }
  local browser_version
  browser_version=$(dario_chrome_version "$("$browser_binary" --version)")

  # Do not switch executables beneath open profile windows.
  if systemctl is-active --quiet dario.service; then systemctl stop dario.service; fi
  install -d -o root -g dario -m 0750 /usr/local/libexec/dario
  install -o root -g dario -m 0750 /usr/bin/unshare /usr/local/libexec/dario/unshare
  # Chrome's normal package uses its standard Ubuntu AppArmor profile. Only our namespace helper needs a custom rule.
  cat > /etc/apparmor.d/dario-browser-userns <<EOF
abi <abi/4.0>,
include <tunables/global>
/usr/local/libexec/dario/unshare flags=(default_allow) {
  userns,
}
EOF
  if [[ -d /sys/kernel/security/apparmor ]]; then apparmor_parser --replace /etc/apparmor.d/dario-browser-userns; fi

  if [[ $prepare_only == 0 ]]; then
    echo 'Checking ordinary Chrome with the same proxy gateway and network namespace...'
    runuser -u dario -- env HOME=/var/lib/dario PATH=/opt/dario-node/bin:/var/lib/dario/.bun/bin:/usr/bin:/bin \
      DARIO_BROWSER_EXECUTABLE="$browser_binary" DARIO_BROWSER_LAUNCHER="$repo_dir/deploy/ubuntu/browser-launcher.sh" \
      DARIO_UNSHARE_EXECUTABLE=/usr/local/libexec/dario/unshare \
      /var/lib/dario/.bun/bin/bun "$repo_dir/scripts/test-profile-browser-privacy.mjs"
  fi
  python3 "$script_dir/prepare-stable-profiles.py" /var/lib/dario/.dario/profiles "$browser_version"
  ln -sfn "$browser_binary" /usr/local/libexec/dario/chrome
  ln -sfn "$browser_binary" /usr/local/libexec/dario/chromium # Compatibility with old environment files.
  if [[ -f /etc/dario/dario.env ]]; then
    local backup="/etc/dario/dario.env.before-stable.$(date -u +%Y%m%dT%H%M%S).$$"
    install -o root -g root -m 0600 /etc/dario/dario.env "$backup"
    python3 - <<'PY'
from pathlib import Path
import os, tempfile
path = Path('/etc/dario/dario.env')
info = path.stat()
lines = [line for line in path.read_text().splitlines() if not line.startswith('DARIO_BROWSER_EXECUTABLE=')]
lines.append('DARIO_BROWSER_EXECUTABLE=/usr/local/libexec/dario/chrome')
fd, temporary = tempfile.mkstemp(prefix='.dario.env.', dir=str(path.parent))
with os.fdopen(fd, 'w') as file:
    file.write('\n'.join(lines) + '\n')
    file.flush()
    os.fsync(file.fileno())
os.chmod(temporary, info.st_mode & 0o777)
os.chown(temporary, info.st_uid, info.st_gid)
os.replace(temporary, path)
PY
    printf 'Environment backup: %s\n' "$backup"
  fi
  printf 'Google Chrome Stable: %s (%s)\n' "$browser_version" "$arch"
  if [[ -d /etc/dario ]]; then
    printf 'Browser: Google Chrome Stable %s\nBrowser executable: %s\n' "$browser_version" "$browser_binary" >> /etc/dario/install-manifest
  fi
  if [[ $prepare_only == 0 ]]; then
    systemctl restart dario.service
    systemctl is-active --quiet dario.service
    echo 'Dario now uses ordinary Google Chrome Stable. Account profiles, proxies and network namespaces remain separate.'
  fi
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then dario_stable_browser_main "$@"; fi
