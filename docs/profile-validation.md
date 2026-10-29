# Profile implementation validation

Local validation on macOS, 2026-10-29:

- `npm run build`: passed.
- `npm audit --omit=dev --audit-level=high`: zero vulnerabilities.
- `npm test`: 284/285 passed after the native browser launch change. The unchanged `rebake-open-pr.mjs` requires GNU `date -d` and fails on macOS. Reproduced against the original upstream checkout at `8155f62`.
- New account-policy, admin API and HTTP/CONNECT/Unix gateway tests passed.
- Real headless Chrome UI interaction test passed: wrong/correct admin token, profile creation, encoded proxy credentials, sign-in action with stubbed OAuth, disable, metadata edit without revealing/changing the stored proxy password, and disconnect. No real account was used.
- Real Bun transport integration passed: concurrent per-account proxies, Basic authentication, HTTPS CONNECT, upstream hostname forwarding, proxy outage and no direct fallback.
- Installed Chrome privacy integration passed with a temporary browser profile and mock Keychain: zero WebRTC candidates, zero STUN packets to the direct test listener, zero direct HTTP hits and zero local DNS transactions for the test hostname. Locale and timezone matched the configured profile.
- Native-launch lifecycle test passed using an executable fixture: the ordinary browser receives its OAuth URL directly, no debugging/automation/headless or automation-masking flags, and its own `TZ`. Page evaluation is unavailable. The actual browser privacy/UI tests explicitly opt into headless test control; they do not measure a native window's `navigator.webdriver` or prove a CleanIP score.
- Ubuntu installer, launcher, desktop and CLI wrapper passed shell syntax checks.

The complete Ubuntu installation, AppArmor policy, Linux namespace launcher and systemd services have **not** been run on the target server. The installer runs browser and transport integration checks on that server before starting the services. A kernel/user-namespace restriction is a hard failure, with no unisolated fallback.

No real Claude account or customer proxy was available for a live OAuth test. CleanIP scores have not been measured for the user's proxy. A proxy provider may rotate egress IPs between connections even when both clients use the same configured proxy URL.

The browser's network namespace is a kernel boundary on Linux. Dario's per-account egress enforcement is application-level; a separate systemd/firewall allowlist of proxy IPs is required for an additional kernel boundary around the Dario process itself.
