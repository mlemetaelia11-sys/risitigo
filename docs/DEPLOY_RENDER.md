# RisitiGo production deployment — Render

## 1. Connect the repository
Create a GitHub repository and push the contents of this folder. Then create a Render Blueprint from that repository.

## 2. Required environment values
After the service is created, set:

```text
APP_URL=https://YOUR-FINAL-DOMAIN
PESAPAL_ENVIRONMENT=sandbox
PESAPAL_CONSUMER_KEY=YOUR_KEY
PESAPAL_CONSUMER_SECRET=YOUR_SECRET
```

Keep `PESAPAL_ENVIRONMENT=sandbox` until the PesaPal sandbox transaction is confirmed. For live charging, switch it to `production` and use the live merchant credentials.

Render keeps environment variables/secrets out of your Git repository. The Blueprint generates `SESSION_SECRET` automatically and points the data file to the persistent disk at `/var/data/risitigo/db.json`.

## 3. PesaPal URLs
When `APP_URL` is set, RisitiGo calculates:

```text
IPN      https://YOUR-FINAL-DOMAIN/api/webhooks/pesapal/ipn
Callback https://YOUR-FINAL-DOMAIN/api/webhooks/pesapal/callback
```

Open Settings → Integrations → Test / Register PesaPal IPN, or start the first subscription checkout. RisitiGo can look up an existing registered IPN and otherwise register it, then save the returned IPN ID in process memory for reuse.

## 4. Smoke test
Open:

```text
https://YOUR-FINAL-DOMAIN/health
```

Expected response contains:

```json
{"ok":true,"service":"RisitiGo"}
```

Then:
1. Sign up with the first account — it becomes `PLATFORM_ADMIN`.
2. Create a customer.
3. Create an invoice.
4. Record a payment and open the generated receipt.
5. Open Subscription and choose Starter/Pro/Business.
6. Complete the PesaPal sandbox checkout.

## 5. Live PesaPal
The app is coded against PesaPal API 3. The integration sends `notification_id`, `callback_url`, and `billing_address` on `SubmitOrderRequest`, then verifies the transaction using `GetTransactionStatus` on callback/IPN before activating a subscription.
