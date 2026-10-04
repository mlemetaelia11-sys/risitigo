# PesaPal setup

1. Set `APP_URL` to the final public HTTPS domain.
2. Set `PESAPAL_ENVIRONMENT=sandbox` for sandbox testing.
3. Add PesaPal consumer key and consumer secret in environment variables.
4. Open Settings → Integrations → Test / Register PesaPal IPN.
5. The app will use `/api/webhooks/pesapal/ipn` as its IPN endpoint unless `PESAPAL_IPN_URL` overrides it.
6. The app will use `/api/webhooks/pesapal/callback` as its callback endpoint unless `PESAPAL_CALLBACK_URL` overrides it.
7. Run a subscription checkout from Subscription.
8. After the customer returns, RisitiGo calls GetTransactionStatus and only marks the subscription active when the provider status is completed.

For production, switch `PESAPAL_ENVIRONMENT=production` and use production credentials only after completing the merchant/provider onboarding required by PesaPal.
