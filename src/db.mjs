import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const file = path.resolve(process.env.DATA_FILE || './data/db.json');
const databaseUrl = String(process.env.DATABASE_URL || '').trim();
const usePostgres = Boolean(databaseUrl);

export const plans = [
  {
    id: 'free', name: 'Free', monthly: 0, yearly: 0, limits: { invoices: 10, customers: 10, payments: 10 },
    features: ['10 invoices / month', '10 receipts / month', '10 customers', 'PDF / print', 'WhatsApp sharing'],
    featureIds: ['invoice.create','payment.create','receipt.view','document.pdf','whatsapp.share']
  },
  {
    id: 'starter', name: 'Starter', monthly: 10000, yearly: 100000, limits: { invoices: Infinity, customers: Infinity, payments: Infinity },
    features: ['Unlimited invoices', 'Unlimited receipts', 'Unlimited customers', 'Quotations', 'Debt tracking', 'WhatsApp reminders', 'Business branding'],
    featureIds: ['invoice.create','payment.create','receipt.view','document.pdf','whatsapp.share','quote.create','debt.track','whatsapp.reminder','business.branding']
  },
  {
    id: 'pro', name: 'Pro', monthly: 20000, yearly: 200000, limits: { invoices: Infinity, customers: Infinity, payments: Infinity },
    features: ['Everything in Starter', 'Sales reports & exports'],
    featureIds: ['invoice.create','payment.create','receipt.view','document.pdf','whatsapp.share','quote.create','debt.track','whatsapp.reminder','business.branding','reports.view']
  },
  {
    id: 'business', name: 'Business', monthly: 35000, yearly: 350000, limits: { invoices: Infinity, customers: Infinity, payments: Infinity },
    features: ['Everything in Pro', 'Priority support'],
    featureIds: ['invoice.create','payment.create','receipt.view','document.pdf','whatsapp.share','quote.create','debt.track','whatsapp.reminder','business.branding','reports.view','priority.support']
  }
];

export const emptyDb = () => ({
  users: [], businesses: [], staff: [], customers: [], invoices: [], quotes: [], payments: [],
  sessions: [], notifications: [], auditLogs: [], counters: {}
});

function ensureDbShape(db) {
  const base = emptyDb();
  for (const key of Object.keys(base)) if (!(key in db)) db[key] = structuredClone(base[key]);
  return db;
}

let state = emptyDb();
let dirty = false;
let initialized = false;
let pool = null;

if (usePostgres) {
  const pg = await import('pg');
  const Pool = pg.default?.Pool || pg.Pool;
  pool = new Pool({
    connectionString: databaseUrl,
    max: Number(process.env.PG_POOL_MAX || 5),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl: databaseUrl.includes('sslmode=disable') ? false : { rejectUnauthorized: false }
  });
  await initPostgres();
} else {
  state = loadFileDb();
  initialized = true;
}

function loadFileDb() {
  if (!fs.existsSync(file)) {
    const db = emptyDb();
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(db, null, 2), { mode: 0o600 });
    return db;
  }
  return ensureDbShape(JSON.parse(fs.readFileSync(file, 'utf8')));
}

async function initPostgres() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS risitigo_state (
      id integer PRIMARY KEY,
      state jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  const result = await pool.query('SELECT state FROM risitigo_state WHERE id = 1');
  if (!result.rowCount) {
    state = emptyDb();
    await pool.query('INSERT INTO risitigo_state (id, state) VALUES (1, $1::jsonb)', [JSON.stringify(state)]);
  } else {
    state = ensureDbShape(result.rows[0].state || emptyDb());
  }
  initialized = true;
}

export function readDb() {
  if (!initialized) throw new Error('RisitiGo database has not finished initializing.');
  return state;
}

export function writeDb(db) {
  state = ensureDbShape(db);
  if (usePostgres) {
    dirty = true;
    return;
  }
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export async function refreshDb() {
  if (!usePostgres) return state;
  const result = await pool.query('SELECT state FROM risitigo_state WHERE id = 1');
  if (result.rowCount) state = ensureDbShape(result.rows[0].state || emptyDb());
  dirty = false;
  return state;
}

export async function flushDb() {
  if (!usePostgres || !dirty) return;
  await pool.query(
    'UPDATE risitigo_state SET state = $1::jsonb, updated_at = now() WHERE id = 1',
    [JSON.stringify(state)]
  );
  dirty = false;
}

export async function acquireDbLock() {
  if (!usePostgres) return async () => {};
  const client = await pool.connect();
  await client.query("SELECT pg_advisory_lock(hashtext('risitigo:state:v1'))");
  return async () => {
    try { await client.query("SELECT pg_advisory_unlock(hashtext('risitigo:state:v1'))"); }
    finally { client.release(); }
  };
}

export function dbConfigured() { return usePostgres; }
export function databaseHealth() { return { configured: usePostgres, provider: usePostgres ? 'postgresql' : 'local-file' }; }

export function id(prefix) { return `${prefix}_${crypto.randomBytes(10).toString('hex')}`; }
export function token() { return crypto.randomBytes(24).toString('base64url'); }
export function now() { return new Date().toISOString(); }
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt$${salt}$${derived}`;
}
export function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  if (!stored.startsWith('scrypt$')) return false;
  const [, salt, expected] = stored.split('$');
  if (!salt || !expected) return false;
  const actual = crypto.scryptSync(String(password), salt, 64).toString('hex');
  const a = Buffer.from(actual, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
export function nextNumber(db, businessId, key, prefix) {
  const counterKey = `${businessId}:${key}`;
  const next = Number(db.counters[counterKey] || 0) + 1;
  db.counters[counterKey] = next;
  return `${prefix}-${String(next).padStart(5, '0')}`;
}
export function getPlan(planId) { return plans.find(p => p.id === planId) || plans[0]; }
