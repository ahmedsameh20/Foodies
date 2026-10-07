# Deployment

Two supported shapes:
* **PostgreSQL (recommended for production)**: `DATABASE_URL=postgres://...`; one or several Node instances behind a load balancer; shared storage for `uploads/` when more than one instance. See `docs/DATABASE.md` (setup, TLS, how consistency works).
* **SQLite (single instance)**: one Node process, a SQLite file and an uploads folder on a **persistent disk** (VPS, Fly.io volume, Render disk, Railway volume, …).
Both need **HTTPS** in front.

## 1. Environment

Copy `.env.example` and set at least:

```
NODE_ENV=production
APP_URL=https://your-domain            # https is mandatory in production (the server refuses to start otherwise)
AUTH_SECRET=<48+ random hex chars>     # node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
DATABASE_URL=postgres://foodies:PASSWORD@db.internal:5432/foodies?sslmode=verify-full   # PostgreSQL (production)
#DATABASE_PATH=/data/app.db           # SQLite alternative (single instance, persistent volume)
UPLOAD_DIR=/uploads                    # on the persistent volume
TRUST_PROXY=1                          # one reverse proxy in front
WHATSAPP_NUMBER=00966566148975
SMTP_HOST=...  SMTP_USER=...  SMTP_PASS=...  MAIL_FROM=...   # password-reset / verification email
PAYMENT_PROVIDER=none                  # until the Tap sandbox checklist (docs/PAYMENTS.md §13) is done; cash on delivery works without it
CURRENCY=SAR                           # REQUIRED in production; SAR for a Saudi merchant (USD is NOT VERIFIED)
PAYMENT_ENV=production                 # sandbox | production; sk_test_ keys refuse to start in production
```

The server **refuses to start** in production if `AUTH_SECRET` is missing/weak/placeholder, `APP_URL` is not https,
or `PAYMENT_PROVIDER=tap` has no `PAYMENT_SECRET_KEY`.

## 1b. Admin access, plans and domains

* **Create the first Super Admin** (no default account exists): `ADMIN_EMAIL=… ADMIN_PASSWORD='…' npm run admin:create`, then sign in at `https://your-domain/admin/login` and enable 2FA under *Admin → Security*. In production the admin API stays closed (`403 mfa_enrollment_required`) until 2FA is enabled.
* **Plans**: set your real prices, trial days and limits in *Admin → Plans* before opening registration (the seeded values are only starting points).
* **Restaurant subdomains** (optional): set `TENANT_BASE_DOMAIN=your-domain.com`, add a wildcard DNS record `*.your-domain.com` → your server and a wildcard TLS certificate (e.g. Caddy/Let's Encrypt DNS challenge), and have the proxy pass the original `Host` header. `https://<slug>.your-domain.com` then serves that restaurant. Custom domains: an admin sets `restaurants.custom_domain` and you point the domain + certificate at the proxy.
* **Database**: SQLite means one instance. Read `docs/DATABASE.md` and plan the PostgreSQL migration before you scale.

## 2. First start

```bash
npm ci --omit=dev
npm run migrate                                   # backs the DB up first (app.db.pre-NNN.bak) when upgrading
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='long unique passphrase 1' npm run admin:create
npm start
```

`npm start` runs migrations and then the server; migrations are additive and re-runnable. Do **not** run
`seed:sample` in production (it refuses).

## 3. Docker

```bash
cp .env.example .env       # fill in
docker compose up -d --build
```

The image runs as a non-root user, keeps the DB on the `/data` volume and uploads on `/uploads`, and has a health check
(`GET /api/health`). Put Caddy/nginx/Traefik in front for TLS and proxy to port 3000. *(The Dockerfile was not built
in the environment this project was developed in.)*

## 4. Reverse proxy (nginx example)

```nginx
server {
  listen 443 ssl http2;
  server_name your-domain;
  # ssl_certificate ... (e.g. certbot)
  client_max_body_size 3m;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

There is no CORS configuration on purpose: the frontend is served by the same origin as the API, and cross-origin
browser access is therefore denied. Cookies are `HttpOnly; Secure; SameSite=Lax`, and cookie-authenticated writes
must come from the same site.

## 5. Operations

* **Weekly payouts**: created by the server every Monday; for belt and braces add cron `0 6 * * 1  cd /app && npm run payouts:weekly` (idempotent).
* **Backups**: `npm run backup` (consistent online snapshot + uploads, keeps the newest 14) from cron daily; copy `backups/` off the host. Restore with `npm run restore -- backups/<timestamp>` (server stopped). Full procedure: `docs/BACKUPS.md`.
* **Logs**: JSON lines on stdout (`LOG_LEVEL`); ship them to your log service. Events of interest: `payment.*`, `refund.*`, `webhook.*`, `payout.*`, `audit`, `auth.login_failed`, `http.rate_limited`.
* **Health**: `GET /health` → `{status, database, uptimeSeconds}` (no secrets); `GET /api/health` also reports the payment provider. HTTP 503 when the database is unreachable.
* **Scaling**: one instance (SQLite). For more, migrate to PostgreSQL first.

## 6. Pre-launch checklist

- [ ] HTTPS works and `APP_URL` matches the public URL
- [ ] `AUTH_SECRET` is random and kept out of git; admin account created with a strong passphrase
- [ ] SMTP configured and a password-reset email arrives
- [ ] Backups configured and a restore tested
- [ ] (Card payments) the checklist in `docs/PAYMENTS.md`, including a real sandbox order, refund and webhook delivery
- [ ] Commission / service fee reviewed in *Admin → Settings*

## 7. Launch runbook (copy/paste, Linux VPS + Caddy)

```bash
# 1. Server: Node >= 22.13, a domain with an A record to the server (and *.yourdomain.com if you want restaurant subdomains)
git clone <your repo> /opt/foodies && cd /opt/foodies
npm ci --omit=dev

# 2. Environment (never commit this file)
cp .env.example .env && chmod 600 .env
#   NODE_ENV=production
#   APP_URL=https://YOURDOMAIN.com
#   TRUST_PROXY=1
#   AUTH_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")
#   DATABASE_PATH=/var/lib/foodies/app.db     UPLOAD_DIR=/var/lib/foodies/uploads
#   SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS (or SMTP_PASSWORD) / MAIL_FROM
#   PLATFORM_COMMISSION_BP=1000   TENANT_BASE_DOMAIN=yourdomain.com   (optional)
#   PAYMENT_PROVIDER=none  -> until docs/PAYMENTS.md sandbox checklist is done; then tap + TAP_SECRET_KEY / TAP_MERCHANT_ID / TAP_WEBHOOK_SECRET
mkdir -p /var/lib/foodies/uploads

# 3. Database + first admin (no default admin exists)
npm run migrate
ADMIN_EMAIL=you@yourdomain.com ADMIN_PASSWORD='long unique passphrase 1' npm run admin:create

# 4. Run as a service (systemd) - /etc/systemd/system/foodies.service
#   [Service] WorkingDirectory=/opt/foodies  ExecStart=/usr/bin/node server/index.js  EnvironmentFile=/opt/foodies/.env  Restart=always  User=foodies
sudo systemctl enable --now foodies

# 5. HTTPS: /etc/caddy/Caddyfile  ->  yourdomain.com { reverse_proxy 127.0.0.1:3000 }   (wildcard: use the DNS-challenge build of Caddy)
curl -fsS https://YOURDOMAIN.com/health

# 6. Daily backup
echo '0 3 * * * cd /opt/foodies && npm run backup >> /var/log/foodies-backup.log 2>&1' | crontab -
```

Then open `https://YOURDOMAIN.com/admin/login`, sign in, **enrol 2FA** (admin API is closed with `403 mfa_enrollment_required` until you do), and set plans in Admin → Plans.

* **Webhook URL** (Tap dashboard): `https://YOURDOMAIN.com/webhooks/tap`
* **SMTP**: send a password-reset to yourself; production cannot send reset/verification mail without it.
* **Admin 2FA recovery**: `ADMIN_EMAIL=you@yourdomain.com npm run admin:reset-2fa` — use **only** when an admin has lost both the authenticator and all backup codes. It deletes their 2FA secret and backup codes, signs them out everywhere, writes an audit-log entry; they sign in with their password and must enrol again. Never use it for a forgotten password (use the reset-password mail).
* **Rollback**: `git checkout <previous tag> && npm ci --omit=dev && systemctl restart foodies`. Migrations are forward-only: before upgrading, `npm run backup` (the migrator also writes `app.db.pre-NNN.bak`); to roll back a migration, stop the app, `npm run restore -- backups/<snapshot>`, then check out the old release.

## 8. PostgreSQL deployment checklist
```bash
# 1. database (UTF8 is mandatory), role, TLS
createdb -E UTF8 -T template0 foodies     # or your provider's console; then create the role and grant it CREATE on the database
# 2. environment
DATABASE_URL=postgres://foodies:PASSWORD@db.internal:5432/foodies?sslmode=verify-full
# 3. schema and first admin
npm run migrate
ADMIN_EMAIL=you@yourdomain.com ADMIN_PASSWORD='long unique passphrase 1' npm run admin:create
# 4. start one or more instances (same DATABASE_URL); only one runs the background jobs at a time
npm start
# 5. health and backups
curl -fsS https://YOURDOMAIN.com/health
npm run backup
```
* **Several instances:** share `uploads/` (volume or object storage), terminate TLS and apply a global rate limit at the proxy (the in-app limiter is per instance), and send webhooks to the load balancer URL. Roll deployments one instance at a time; migrations are idempotent and lock-protected.
* **From an existing SQLite install:** `npm run db:sqlite-to-postgres` (see `docs/DATABASE.md`).
* **Docker:** `docker-compose.postgres.yml` (PostgreSQL 17 + the app). Not built or run in the environment this project was developed in.
* **Rollback:** the schema is forward-only. Before an upgrade run `npm run backup`; to roll back, restore into a fresh database (`npm run restore`) and deploy the previous release.
