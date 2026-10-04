# RisitiGo — Vercel + Neon deployment

## 1. GitHub
Push this folder so `package.json`, `public/` and `src/` are at repository root.

## 2. Vercel
Import the GitHub repo. No framework preset is required. Vercel detects `src/server.ts` as a Node.js application. The project is pinned to Node 24.x in `package.json`.

## 3. Neon
Create a Neon Postgres database through the Vercel Marketplace (or Neon directly), then add the connection string as the `DATABASE_URL` Production environment variable. Vercel supports Neon as a Marketplace integration.

## 4. Vercel environment variables
Set at least:

- `NODE_ENV=production`
- `APP_URL=https://YOUR-DOMAIN`
- `DATABASE_URL=postgresql://...`
- `SESSION_SECRET=<long random value>`
- `PESAPAL_ENVIRONMENT=sandbox` for the first payment test
- `PESAPAL_CONSUMER_KEY=<sandbox key>`
- `PESAPAL_CONSUMER_SECRET=<sandbox secret>`

Keep PesaPal keys and `DATABASE_URL` as Secret variables in Vercel. A redeploy is required after changing environment variables.

## 5. Health check
Open `/health`. A healthy production response includes `database.provider: "postgresql"`.

## 6. PesaPal endpoints
- IPN: `/api/webhooks/pesapal/ipn`
- Callback: `/api/webhooks/pesapal/callback`

Once the site has a public HTTPS URL, use **Settings → Integrations → Test / Register PesaPal IPN** inside RisitiGo. The app registers/reuses the IPN and stores the returned IPN ID. Do not paste the URL itself into `notification_id`.

## 7. Payment test
Start with a low-value sandbox transaction. Verify: checkout → callback → `GetTransactionStatus` → subscription activation.

## 8. Production switch
After sandbox verification, change:
`PESAPAL_ENVIRONMENT=production`
and replace the credentials with production credentials. Re-register/verify the production IPN URL.
