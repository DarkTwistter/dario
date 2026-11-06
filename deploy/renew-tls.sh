#!/bin/sh
set -eu
cd "$(dirname "$0")"
# Standalone validation uses port 80; the application continues serving on 443.
docker run --rm -p 80:80 \
  -v "$PWD/letsencrypt:/etc/letsencrypt" \
  certbot/certbot:v5.4.0 renew --quiet --non-interactive
# Replace files within the mounted directory so nginx sees the new inodes.
install -m 644 letsencrypt/live/dario-ip/fullchain.pem tls/server.crt.new
install -m 600 letsencrypt/live/dario-ip/privkey.pem tls/server.key.new
mv tls/server.crt.new tls/server.crt
mv tls/server.key.new tls/server.key
docker compose exec -T https nginx -t
docker compose exec -T https nginx -s reload
