# Go-live guide: real database + real payments

The code already supports PostgreSQL and Tap Payments. This guide covers what only you can do (accounts, KYC, keys, server).
Do the phases **in order**. Do not skip Phase 3: it is what turns "implemented" into "verified".

---

## Phase 1: Get a server and a domain (about 1 hour)

1. Buy a domain (Namecheap, GoDaddy, Cloudflare Registrar...).
2. Rent a small Linux server: Hetzner CX22, DigitalOcean, or AWS Lightsail (2 GB RAM is enough to start). Choose the region closest to your customers. For Saudi customers use Bahrain/Frankfurt/Dubai-adjacent regions.
3. Point DNS: `A` record `yourdomain.com` -> server IP (add `*.yourdomain.com` too if you want restaurant subdomains).
4. SSH in and install: Node >= 22.13, Caddy (free automatic HTTPS), git.

## Phase 2: Real database (PostgreSQL), about 30 minutes

Pick ONE:

**A. Managed PostgreSQL (recommended, backups handled for you).** Supabase, Neon, DigitalOcean Managed DB, AWS RDS. Create a database named `foodies`, **UTF8 encoding**, same region as the server. Copy the connection string.

**B. PostgreSQL on the same server.** `sudo apt install postgresql`, then:
```bash
sudo -u postgres createuser foodies --pwprompt
sudo -u postgres createdb -E UTF8 -T template0 -O foodies foodies
```

Then on the server:
```bash
git clone <your repo> /opt/foodies && cd /opt/foodies
npm ci --omit=dev
cp .env.example .env && chmod 600 .env
```
Edit `.env` (production values):
```
NODE_ENV=production
APP_URL=https://yourdomain.com
TRUST_PROXY=1
AUTH_SECRET=<run: node -e "console.log(require('crypto').randomBytes(48).toString('hex'))">
DATABASE_URL=postgres://foodies:PASSWORD@HOST:5432/foodies?sslmode=verify-full
UPLOAD_DIR=/var/lib/foodies/uploads
CURRENCY=SAR
PAYMENT_PROVIDER=none          # keep "none" until Phase 3 passes
SMTP_HOST=... SMTP_USER=... SMTP_PASS=... MAIL_FROM="Foodies <no-reply@yourdomain.com>"
```
Remove the old local `DATABASE_URL` (127.0.0.1:54320) and any `TAP_*` test values you do not need.

Create tables and the first admin:
```bash
mkdir -p /var/lib/foodies/uploads
npm run migrate
ADMIN_EMAIL=you@yourdomain.com ADMIN_PASSWORD='a long unique passphrase 1' npm run admin:create
```
Run as a service (systemd `foodies.service`) and put Caddy in front:
```
yourdomain.com { reverse_proxy 127.0.0.1:3000 }
```
Check: `curl https://yourdomain.com/health` shows the database is connected.

Then immediately: sign in at `/admin/login`, **enrol 2FA**, set real plans in *Admin -> Plans*, add the daily backup cron (`npm run backup`), and **do a restore test**.

The app is now live with a real database and **cash on delivery**. You can accept restaurants and orders at this point.

## Phase 3: Real payment gateway (Tap Payments)

Why this takes days, not minutes: Tap reviews your business (KYC). That is a legal requirement for any gateway.

1. **Create a Tap business account** at tap.company (commercial registration, ID, IBAN needed for a Saudi merchant). Ask Tap to enable **mada, Visa/Mastercard, Apple Pay**.
2. **Ask Tap in writing** (email your account manager):
   - Is my account eligible for **Marketplace / split payments (destinations)**?
   - Settlement cycle and currency (SAR) for each method?
   - Can I get **Marketplace keys** and a sandbox with destinations?
3. **Sandbox first.** Get `sk_test_...` key and merchant id. On a machine with a public URL (or an ngrok tunnel):
   ```bash
   TAP_SECRET_KEY=sk_test_... TAP_MERCHANT_ID=... TAP_TEST_DESTINATION_ID=... \
   TAP_TEST_PHONE=+9665... TAP_PUBLIC_URL=https://<tunnel> npm run sandbox:tap
   ```
   Pay on Tap's page with a Tap test card when asked. It writes evidence to `sandbox-results/`. Fix anything that differs from the docs.
4. **Restaurant onboarding** (per restaurant): each restaurant becomes a Tap *Business* (KYC + IBAN) done at Tap. You then paste its `destination_id` in *Admin -> Restaurants -> View -> Payment account*. Tap pays the restaurant's bank itself.
5. **Webhook:** in the Tap dashboard set the webhook URL to `https://yourdomain.com/webhooks/tap`.
6. **Go live:** put the **live** key in the server `.env` and restart:
   ```
   PAYMENT_PROVIDER=tap
   PAYMENT_ENV=production
   TAP_SECRET_KEY=sk_live_...
   TAP_MERCHANT_ID=...
   ```
   (The server refuses to start if a test key is used in production, or the reverse.)
7. **Real-money test:** place a small real order (e.g. 5 SAR), confirm in Tap's dashboard that the charge arrived, the restaurant wallet got only its share, then **refund it** and check the refund.

### If Tap Marketplace is not available for you
Use the simpler model: all money goes to **your** Tap account, and you pay restaurants yourself (bank transfer, weekly). In `.env` set:
```
PAYOUT_MODE=manual_transfer
```
No restaurant KYC at Tap is needed. The app tracks what each restaurant is owed and records each transfer you make.

## Phase 4: Final launch checklist

- [ ] HTTPS works; `APP_URL` matches
- [ ] Admin created, **2FA enabled**
- [ ] Password-reset email arrives (SMTP)
- [ ] Daily backup runs and a **restore was tested**
- [ ] Sandbox runner passed; one real 5 SAR order + refund tested
- [ ] Webhook delivered (check *Admin -> Payments*)
- [ ] Plans, commission and fees reviewed
- [ ] Terms of service, privacy policy, refund policy pages published (needed by Tap and by law)
- [ ] `docs/PRODUCTION_READINESS.md` blockers re-checked and updated with your real results

Never commit `.env`, `data/admin-credentials.txt`, or `.pg-test.env` (already in `.gitignore`).
