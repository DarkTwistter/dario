# Profile implementation validation

Local validation on macOS, 2026-10-29:

- `npm run build`: passed.
- `npm audit --omit=dev --audit-level=high`: zero vulnerabilities.
- Latest full `npm test`: 285/287 passed. The unchanged `rebake-open-pr.mjs` requires GNU `date -d` and fails on macOS (also reproduced at upstream `8155f62`). `relaunch-signals.mjs` hit the existing 3-second stand-in Bun startup timeout during the concurrent run; its immediate standalone rerun passed all 10 assertions. All account-profile and lock tests passed.
- New account-policy, admin API and HTTP/CONNECT/Unix gateway tests passed.
- Real headless Chrome UI interaction test passed: wrong/correct admin token, profile creation, encoded proxy credentials, sign-in action with stubbed OAuth, disable, metadata edit without revealing/changing the stored proxy password, and disconnect. No real account was used.
- Real Bun transport integration passed: concurrent per-account proxies, Basic authentication, HTTPS CONNECT, upstream hostname forwarding, proxy outage and no direct fallback.
- Installed Chrome privacy integration passed with a temporary browser profile and mock Keychain: zero WebRTC candidates, zero STUN packets to the direct test listener, zero direct HTTP hits and zero local DNS transactions for the test hostname. Locale and timezone matched the configured profile.
- Native-launch lifecycle test passed using an executable fixture: the ordinary browser receives its OAuth URL directly, no debugging/automation/headless or automation-masking flags, and its own `TZ`. Page evaluation is unavailable. The actual browser privacy/UI tests explicitly opt into headless test control; they do not measure a native window's `navigator.webdriver` or prove a CleanIP score.
- POSIX lock tests passed: recovery from old empty lock files, two concurrent claimants, active Chromium singleton protection, dead singleton handling, holder death, killed-parent recovery, and rejection of lock symlinks without modifying their target. Native-browser shutdown on lock loss and actual headless Chrome startup/shutdown with the advisory lock also passed.
- Ubuntu installer, launcher, desktop and CLI wrapper passed shell syntax checks.
- Ordinary Stable migration: build and shell/Python syntax checks passed; compatible browser data preserved, newer/unknown data archived without changing profile/proxy files, active advisory/singleton locks and unsafe lock symlinks refused. Installer helpers accept amd64/arm64 and reject Chrome for Testing version strings. Signed APT installation itself has not been executed locally.
- Updated native fixture test passed with two simultaneous profiles: different user-data directories, local gateways and timezones, independent locks and shutdown. Browser gateway and installed-Chrome privacy tests passed again after the Stable switch.

The complete Ubuntu installation, AppArmor policy, Linux namespace launcher and systemd services have **not** been run on the target server. The installer runs browser and transport integration checks on that server before starting the services. A kernel/user-namespace restriction is a hard failure, with no unisolated fallback.

No real Claude account or customer proxy was available for a live OAuth test. CleanIP scores have not been measured for the user's proxy. A proxy provider may rotate egress IPs between connections even when both clients use the same configured proxy URL.

The browser's network namespace is a kernel boundary on Linux. Dario's per-account egress enforcement is application-level; a separate systemd/firewall allowlist of proxy IPs is required for an additional kernel boundary around the Dario process itself.
