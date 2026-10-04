# RisitiGo

Tanzania-first SaaS for invoices, receipts, quotes, payments and customer debt follow-up.

## MVP modules
- Auth: first registered user becomes `PLATFORM_ADMIN`; later users are `OWNER`.
- Business profile and branding.
- Customers.
- Invoices with item lines, discounts, tax, due dates and share links.
- Payments: Cash, M-Pesa, Airtel Money, Bank, Card and Other.
- Receipts with printable/PDF-friendly public pages.
- Quotes with one-click convert to invoice.
- Debt list with WhatsApp reminder links.
- Reports.
- Subscription plans and PesaPal API 3 checkout/callback/IPN verification.
- Server-side feature gating: Free limits are enforced for invoices, customers and payments; premium Quotes, Debt Tracking, WhatsApp reminders and Reports are blocked until the required active paid plan is confirmed.
- Resend, R2 and Sentry integration health hooks.

## Local
```bash
cp .env.example .env
npm start
```
Open http://localhost:3000

For subscriptions on localhost, use a public HTTPS tunnel because PesaPal callback/IPN URLs must be publicly reachable. Set `APP_URL` to that public URL.

## PesaPal
Set:
- `PESAPAL_ENVIRONMENT=sandbox` for sandbox testing.
- `PESAPAL_CONSUMER_KEY`
- `PESAPAL_CONSUMER_SECRET`

RisitiGo auto-finds/registers the IPN URL on first checkout when `PESAPAL_IPN_ID` is not set. You can also use the Settings → Integrations button.

The app stores the order tracking ID, then checks transaction status on both callback and IPN before changing a subscription to active.

## Production
For a production deployment, use an external/persistent data location. The included Render Blueprint uses a persistent disk at `/var/data` and points `DATA_FILE` there. Secrets belong in Render Environment Variables, not Git.

Set `APP_URL` to the final HTTPS domain.

## Branding
Palette follows the supplied reference:
- White `#FFFFFF`
- Light gray `#E5E5E5`
- Gold `#FCA311`
- Navy `#14213D`
- Black `#000000`

Brand assets live in `public/brand/`.

## Plans and feature gating
Feature access is enforced on the server, not only hidden in the UI. A paid plan is considered active only when PesaPal has confirmed the subscription and its current period has not expired. When a paid period expires, the account automatically falls back to Free limits.

Free: 10 invoices/month, 10 customers, 10 recorded payments/receipts per month, PDF/print and WhatsApp sharing.
Starter: adds unlimited invoices/customers/payments, Quotations, Debt Tracking, WhatsApp reminder links and custom branding.
Pro: adds Reports.
Business: adds priority-support entitlement on top of Pro.

## WhatsApp behavior in this MVP
RisitiGo does not yet send messages through the WhatsApp Business Platform automatically. The MVP uses WhatsApp click-to-chat: the owner clicks WhatsApp, RisitiGo creates a pre-filled message containing the invoice/share link or balance reminder, and the owner's WhatsApp opens so the owner taps Send. Automatic backend sending requires a Meta WhatsApp Business Platform/Cloud API integration, business phone onboarding, webhooks and approved templates where required.


## Vercel production architecture

RisitiGo supports Vercel as a Node.js application through `src/server.ts`. Production state is stored in PostgreSQL when `DATABASE_URL` is present; the local JSON file remains a development fallback. Requests that can mutate application state use a PostgreSQL advisory lock so multiple Vercel instances do not overwrite the shared state at the same time.

See `docs/DEPLOY_VERCEL.md`.

