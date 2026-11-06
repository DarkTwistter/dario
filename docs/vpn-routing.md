# VPN routing

For users who want their dario traffic — `api.anthropic.com` requests, OAuth flows, OpenAI-compat backend forwarding — routed through a VPN without putting the entire host on a system VPN. Three approaches, ordered by friction:

## Option A — System VPN (zero config, covers everyone)

The simplest approach. Run a system-level VPN client and **all** outbound from your machine — including dario's calls — goes through the tunnel.

```bash
# 1. Install your provider's client (ProtonVPN, Mullvad, AirVPN, Tailscale, raw WireGuard…)
# 2. Connect.
# 3. Verify your egress IP changed:
curl ifconfig.me
# 4. Run dario normally:
dario proxy
```

This covers every dario use case. No flags needed. The tradeoff is that *all* traffic from the machine is now tunneled — fine if you wanted that anyway, less ideal if you only want dario egress to be private.

## Option B — Per-process via `--upstream-proxy=` (v3.35.0+)

Routes only dario's outbound through an HTTP/HTTPS proxy. The rest of your system stays on the default route.

```bash
# Mullvad's HTTP proxy endpoint (Mullvad SOCKS5 also exists; see notes below)
dario proxy --upstream-proxy=http://10.64.0.1:80

# Or with credentials embedded:
dario proxy --upstream-proxy=http://user:pass@proxy.example.com:8080

# Or via env var:
DARIO_UPSTREAM_PROXY=http://127.0.0.1:8118 dario proxy

# Short alias is also supported:
dario proxy --via=http://127.0.0.1:8118
```

dario's startup banner confirms when it's active:

```
[dario] Outbound proxy: http://10.64.0.1:80/ (all upstream fetches routed; localhost bypasses)
```

`dario doctor` surfaces the same:

```
[INFO]  Outbound proxy   DARIO_UPSTREAM_PROXY=http://10.64.0.1:80/. Upstream fetches routed via this proxy; localhost calls bypass.
```

### Provider matrix

| Provider | HTTP proxy | Notes |
|---|---|---|
| **Mullvad** | `http://10.64.0.1:80` (default) | SOCKS5 also at `:1080`; use HTTP for dario |
| **AirVPN** | `http://nl.airvpn.org:443` (varies by region) | HTTP available on all gateways |
| **ProtonVPN** | (no native HTTP proxy) | Use Option A (system VPN) instead |
| **Privoxy / Polipo** | `http://127.0.0.1:8118` | Local; useful with Tor (`forward-socks5 / 127.0.0.1:9050`) |
| **Cloudflare WARP** | `http://127.0.0.1:40000` | Native HTTP proxy mode in `warp-cli set-mode proxy` |
| **Corporate proxy** | `http://proxy.corp:8080` | Standard org pattern |
| **Squid (self-hosted)** | `http://your-squid:3128` | Run a squid instance in a desired jurisdiction |

### Constraints

- **Bun runtime required.** Bun's fetch implements the `proxy` option natively. Node's built-in fetch ignores it silently — to avoid a false-success failure mode where the flag appears to work while requests actually go direct, dario refuses to start with `--upstream-proxy` unless running under Bun. dario auto-relaunches under Bun when available; `bun run dario proxy --upstream-proxy=...` works directly.
- **HTTP/HTTPS schemes only.** SOCKS5 is not currently supported by Bun 1.3.x's fetch (`UnsupportedProxyProtocol`). If your VPN provider only exposes SOCKS5, run a local SOCKS-to-HTTP bridge such as `privoxy` with `forward-socks5 / 127.0.0.1:1080` and point dario at the privoxy HTTP side.
- **TLS terminates end-to-end at Anthropic.** The proxy sees only the destination hostname (via SNI) and byte timing in CONNECT mode — not your request bodies. Your `bun-match` BoringSSL ClientHello is preserved.
- **Localhost calls bypass the proxy.** Anything dario fetches at `localhost`, `127.0.0.1`, `::1`, or any `*.localhost` host goes direct (so self-tests and inbound aren't accidentally tunneled).

## Option C — Tailscale exit nodes (zero dario config, ideal for teams)

If you already run Tailscale, you can route through any peer node:

```bash
# 1. Designate an exit node on a peer (e.g., a Tailscale-routed node in a desired region)
# 2. From your machine:
sudo tailscale up --exit-node=<peer-name-or-IP>
# 3. Run dario normally — egress is now via the Tailscale exit
dario proxy
```

This is the cleanest pattern for teams: one peer runs in a known jurisdiction, every team member's dario egresses through it, audit trail lives at the peer. The hosted dario Pro tier can ship managed exit nodes as a turnkey feature.

## What this does NOT do

- **Doesn't change CC's wire fingerprint.** TLS ClientHello is still Bun's BoringSSL (or Node's OpenSSL if you're on Node — see `dario doctor`'s Runtime/TLS row). The proxy is at L4 transport; the L7 TLS fingerprint is end-to-end.
- **Doesn't hide your usage from Anthropic.** Anthropic still sees an authenticated OAuth subscription session billed against your account. Egress IP varies; the account does not.
- **Doesn't proxy CC's own traffic during live capture.** dario spawns the installed `claude` binary to capture its outbound — that subprocess uses the host's normal network. If you also want CC's capture traffic tunneled, run dario under Option A or C.

## Verifying it's working

The most direct check: hit a request-and-response endpoint that echoes your egress IP:

```bash
# With dario running:
DARIO_UPSTREAM_PROXY=http://your-proxy:port dario proxy --verbose &

# Then in another terminal, force a request through dario:
curl http://localhost:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-haiku-4-5","max_tokens":50,"messages":[{"role":"user","content":"hi"}]}'

# In the dario verbose log, the upstream connection will show as routed
# via the proxy. Provider-side logs (Mullvad / AirVPN / squid) will show
# a CONNECT to api.anthropic.com:443 from your dario process.
```

If your VPN provider's status page or dashboard shows the connection, the routing is working. If it doesn't, double-check that dario relaunched under Bun (`dario doctor`'s Runtime/TLS row should say `bun-match`).

## Account profiles on the deployed server

Create a profile before logging in. Each `(provider, alias)` has a private,
immutable HTTP/HTTPS proxy URL. Profiles live in `~/.dario/proxy-profiles/`;
proxy credentials have file mode 600 and are omitted from admin responses.

Use the setup page or the authenticated `POST /admin/profiles` endpoint:

```json
{"provider":"claude","alias":"work","proxy_url":"http://user:password@proxy.example:8080"}
```

Then start and complete login using the same alias. `provider` is `claude` or
`codex`. `POST /admin/profiles/test` with `{provider,alias}` checks the provider
connection through the saved proxy. Missing profiles, proxy authentication
failures and unreachable proxies never fall back to a direct request.

The container defaults to `DARIO_REQUIRE_ACCOUNT_PROXY=1`. It requires Bun;
Node fetch is rejected because it ignores Bun's proxy option. Profile routing
takes precedence over the optional shared `DARIO_UPSTREAM_PROXY`. Tokens are
resolved to their own profile even for background model and usage requests;
parallel accounts do not share mutable proxy settings. Failover to another
account uses that account's own proxy.

On the other device, configure the browser to use the SAME proxy before opening
the authorization link. Dario cannot control that device's network settings.
The server-side code exchange, identity lookup, refresh and API traffic use the
saved profile proxy. Background CLI captures are disabled in the container.

Validation: `node test/account-proxy.mjs`, `node test/admin-profiles.mjs`, and
`bun test/integration/profile-proxy-network.mjs` (isolated local TLS provider,
HTTP/HTTPS CONNECT proxies, including redirects, streaming and failed proxies).
