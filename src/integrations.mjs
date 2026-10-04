import crypto from 'node:crypto';

const env = name => process.env[name]?.trim() || '';
const appUrl = () => env('APP_URL').replace(/\/+$/, '');
const baseUrl = () => env('PESAPAL_ENVIRONMENT') === 'production' ? 'https://pay.pesapal.com/v3' : 'https://cybqa.pesapal.com/pesapalv3';
const callbackUrl = () => env('PESAPAL_CALLBACK_URL') || `${appUrl()}/api/webhooks/pesapal/callback`;
const ipnUrl = () => env('PESAPAL_IPN_URL') || `${appUrl()}/api/webhooks/pesapal/ipn`;
let cachedIpnId = env('PESAPAL_IPN_ID') || '';

export function integrationStatus() {
  return {
    pesapal: { configured: !!(env('PESAPAL_CONSUMER_KEY') && env('PESAPAL_CONSUMER_SECRET')), environment: env('PESAPAL_ENVIRONMENT') || 'sandbox', callbackUrl: callbackUrl(), ipnUrl: ipnUrl(), ipnId: cachedIpnId || null },
    resend: { configured: !!(env('RESEND_API_KEY') && env('RESEND_FROM_EMAIL')) },
    r2: { configured: !!(env('R2_ACCOUNT_ID') && env('R2_ACCESS_KEY_ID') && env('R2_SECRET_ACCESS_KEY') && env('R2_BUCKET_NAME')) },
    sentry: { configured: !!env('SENTRY_DSN') }
  };
}

async function jsonFetch(url, options = {}) {
  const r = await fetch(url, options);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.message || data.error?.message || `Provider request failed (${r.status})`);
  return data;
}

export async function pesapalToken() {
  if (!env('PESAPAL_CONSUMER_KEY') || !env('PESAPAL_CONSUMER_SECRET')) throw new Error('PesaPal credentials are not configured.');
  const data = await jsonFetch(`${baseUrl()}/api/Auth/RequestToken`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ consumer_key: env('PESAPAL_CONSUMER_KEY'), consumer_secret: env('PESAPAL_CONSUMER_SECRET') })
  });
  if (!data.token) throw new Error(data.message || 'PesaPal did not return a token.');
  return { token: data.token, base: baseUrl() };
}

export async function pesapalGetOrRegisterIpn() {
  if (cachedIpnId) return cachedIpnId;
  if (!/^https:\/\//i.test(ipnUrl()) || /localhost|127\.0\.0\.1/i.test(ipnUrl())) throw new Error('PesaPal IPN URL must be a public HTTPS URL. Set APP_URL or PESAPAL_IPN_URL first.');
  const { token, base } = await pesapalToken();
  const list = await jsonFetch(`${base}/api/URLSetup/GetIpnList`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  const existing = Array.isArray(list) ? list.find(x => x.url === ipnUrl() && String(x.ipn_status ?? 1) !== '0') : null;
  if (existing?.ipn_id) { cachedIpnId = existing.ipn_id; return cachedIpnId; }
  const registered = await jsonFetch(`${base}/api/URLSetup/RegisterIPN`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ url: ipnUrl(), ipn_notification_type: 'POST' })
  });
  if (!registered.ipn_id) throw new Error(registered.message || 'PesaPal did not return an IPN ID.');
  cachedIpnId = registered.ipn_id;
  return cachedIpnId;
}

export function pesapalUrls() { return { callbackUrl: callbackUrl(), ipnUrl: ipnUrl(), ipnId: cachedIpnId || null, environment: env('PESAPAL_ENVIRONMENT') || 'sandbox' }; }

export async function pesapalSubmitOrder({ reference, amount, description, customer }) {
  const { token, base } = await pesapalToken();
  const notificationId = await pesapalGetOrRegisterIpn();
  const name = String(customer?.name || 'Customer').trim().split(/\s+/);
  return jsonFetch(`${base}/api/Transactions/SubmitOrderRequest`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      id: reference,
      currency: 'TZS',
      amount: Number(amount),
      description: String(description).slice(0, 100),
      callback_url: callbackUrl(),
      notification_id: notificationId,
      billing_address: {
        email_address: customer?.email || undefined,
        phone_number: customer?.phone || undefined,
        country_code: 'TZ',
        first_name: name[0] || 'Customer',
        last_name: name.slice(1).join(' ') || 'Customer'
      }
    })
  });
}

export async function pesapalStatus(orderTrackingId) {
  if (!orderTrackingId) throw new Error('PesaPal tracking ID is required.');
  const { token, base } = await pesapalToken();
  return jsonFetch(`${base}/api/Transactions/GetTransactionStatus?orderTrackingId=${encodeURIComponent(orderTrackingId)}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
}

export async function sendResend({ to, subject, html, idempotencyKey }) {
  if (!env('RESEND_API_KEY') || !env('RESEND_FROM_EMAIL')) throw new Error('Resend is not configured.');
  return jsonFetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env('RESEND_API_KEY')}`, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey || crypto.randomUUID() },
    body: JSON.stringify({ from: env('RESEND_FROM_EMAIL'), to: [to], subject, html })
  });
}

export async function sentryCapture({ message, level = 'info' }) {
  if (!env('SENTRY_DSN')) throw new Error('Sentry is not configured.');
  // MVP intentionally avoids a runtime SDK dependency. The endpoint remains a simple integration health hook.
  return { ok: true, configured: true, message, level };
}
