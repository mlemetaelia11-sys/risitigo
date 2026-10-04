# RisitiGo launch checklist

- [x] Black / gold / navy / white UI palette from supplied reference
- [x] RisitiGo logo assets
- [x] First user becomes platform admin
- [x] Multi-business isolation by businessId
- [x] Login / signup / logout
- [x] Business profile
- [x] Customers
- [x] Quotes
- [x] Invoices
- [x] Payments and receipts
- [x] Debt tracking + WhatsApp reminder links
- [x] Server-side plan/feature gating + automatic expiry fallback to Free
- [x] Public invoice / quote / receipt pages
- [x] Printable / Save to PDF document views
- [x] Free / Starter / Pro / Business plans
- [x] PesaPal API 3 auth + order + callback + IPN + transaction verification
- [x] Resend health hook
- [x] R2 readiness
- [x] Sentry readiness
- [x] Render Blueprint + health check + persistent data disk
- [x] Automated smoke tests

## Before accepting real customer money
- [ ] Set a real HTTPS `APP_URL`
- [ ] Add PesaPal production credentials only after merchant onboarding
- [ ] Complete a sandbox payment and confirm callback/IPN
- [ ] Confirm persistent Render disk is attached and backups are configured
- [ ] Add a custom domain and verify HTTPS
- [ ] Add a real Resend sender/domain if email is enabled
