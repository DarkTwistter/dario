# VPS deployment

Run from this directory. The proxy stores accounts in the `dario-data` Docker
volume. Both services restart automatically. Port 3456 is available only on
server loopback; the public endpoint uses HTTPS on port 443.

Create `.env` with mode 600:

```dotenv
DARIO_API_KEY=<random proxy key>
DARIO_ADMIN=1
DARIO_ADMIN_TOKEN=<different random admin key>
DARIO_IGNORE_CC_CREDENTIALS=1
DARIO_REQUIRE_ACCOUNT_PROXY=1
```

Provide `tls/server.crt` and `tls/server.key`, then run:

```sh
docker compose up -d --build
```

The VPS uses a publicly trusted Let's Encrypt IP certificate. The initial
certificate can be obtained without interrupting HTTPS (port 80 must be free):

```sh
docker run --rm -p 80:80 -v "$PWD/letsencrypt:/etc/letsencrypt" \
  certbot/certbot:v5.4.0 certonly --standalone --preferred-profile shortlived \
  --ip-address 2.58.127.13 --cert-name dario-ip --non-interactive \
  --agree-tos --register-unsafely-without-email
sh renew-tls.sh
```

`renew-tls.sh` renews when necessary, copies the certificate into `tls/`, and
reloads nginx. Install the provided service and timer into `/etc/systemd/system/`
and run `systemctl daemon-reload && systemctl enable --now dario-tls-renew.timer`.
The timer checks renewal twice daily; IP certificates are short-lived. Keep port
80 available for validation. Check `systemctl status dario-tls-renew.timer` and
`journalctl -u dario-tls-renew.service` when troubleshooting.

The root URL serves the setup page. Enter `DARIO_ADMIN_TOKEN`, create a profile
with its own authenticated HTTP/HTTPS proxy, select that profile, generate a
link, authorize on another device using the SAME proxy, and paste the code.
Profile bindings are immutable; the proxy URL (including credentials) is stored
with mode 600 in the config volume and is never returned by list endpoints.
The server cannot configure the network of the other device's browser.

`DARIO_REQUIRE_ACCOUNT_PROXY=1` is the container default and is required for this
deployment. Account code exchange, identity, refresh, model discovery, usage
polls and inference go through the selected profile proxy. Missing profiles or
failed proxies block requests; there is no direct fallback. Accounts created
before profiles were introduced need a profile with their existing provider and
alias before they can serve. A proxy cannot be edited while a login is pending:
create a new profile with a different alias for a new binding.

Admin endpoints: `GET /admin/profiles`, `POST /admin/profiles` with
`{provider:"claude"|"codex",alias,proxy_url}`, and `POST /admin/profiles/test`
with `{provider,alias}`. The provider test sends GET to the public provider page
through the profile's proxy. A 403 is reported as a provider refusal, not a ready
account. `POST /admin/profiles/ip` runs real `curl https://2ip.io/` through that
same stored proxy, with curlrc and NO_PROXY bypass disabled. Proxy credentials
are provided on stdin, never in command arguments. Both checks return a trace
ID, request/response diagnostics and a bounded, redacted response preview.
The setup page displays the external IP and expandable diagnostics next to the
proxy test. Structured `[dario] proxy-check` events are in container logs:

```sh
docker compose logs --since 15m dario | grep 'proxy-check'
```

Account traffic requires Bun >= 1.4.4. The image pins this runtime and includes
curl. Every account request sets `proxy: {url: profile.proxyUrl,
respectNoProxy: false}` and overrides client proxy options. Missing profiles,
ambiguous credential bindings, unavailable proxies and older runtimes fail
closed; no direct retry is made. The real CONNECT integration test also sets
both `NO_PROXY=*` and `no_proxy=*` and exercises OAuth, refresh, inference,
streaming, curl, and missing/dead proxies, asserting zero direct connections.
The page keeps the admin token in memory only. `/livez` checks the running
server; `/health` reports readiness and returns 503 until an account is usable.

For scripted login, call `/admin/login/start` with the admin bearer token, open the
returned `authorize_url` on another device, then submit the code to
`/admin/login/complete`. See [admin API](../docs/admin-api.md).
Alternatively, use `docker compose exec dario dario accounts add main`.

Inspect services with `docker compose ps` and `docker compose logs --tail 100`.
Back up the `dario-data` volume and `.env` to retain credentials and client keys.
