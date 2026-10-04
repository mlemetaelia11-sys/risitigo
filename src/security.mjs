import crypto from 'node:crypto';
import { readDb, writeDb, id, now } from './db.mjs';

const SESSION_COOKIE = 'risitigo_session';
const isProd = process.env.NODE_ENV === 'production';
const maxAge = 60 * 60 * 24 * 30;

export function parseCookies(header = '') {
  const out = {};
  for (const pair of header.split(';')) {
    const i = pair.indexOf('=');
    if (i < 0) continue;
    out[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim());
  }
  return out;
}

export function setCookie(name, value, options = {}) {
  const attrs = [`${name}=${encodeURIComponent(value)}`, `Max-Age=${options.maxAge ?? maxAge}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (isProd) attrs.push('Secure');
  return attrs.join('; ');
}
export function clearCookie(name) { return `${name}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax${isProd ? '; Secure' : ''}`; }

export function createSession(userId) {
  const db = readDb();
  const sessionId = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + maxAge * 1000).toISOString();
  db.sessions.push({ id: sessionId, userId, expiresAt, createdAt: now() });
  db.sessions = db.sessions.filter(s => new Date(s.expiresAt).getTime() > Date.now());
  writeDb(db);
  return sessionId;
}

export function getSessionUser(req) {
  const sid = parseCookies(req.headers.cookie || '')[SESSION_COOKIE];
  if (!sid) return null;
  const db = readDb();
  const session = db.sessions.find(s => s.id === sid && new Date(s.expiresAt).getTime() > Date.now());
  if (!session) return null;
  const user = db.users.find(u => u.id === session.userId);
  if (!user) return null;
  return user;
}

export function destroySession(req) {
  const sid = parseCookies(req.headers.cookie || '')[SESSION_COOKIE];
  if (!sid) return;
  const db = readDb();
  db.sessions = db.sessions.filter(s => s.id !== sid);
  writeDb(db);
}

export function requireUser(req, res, roles = null) {
  const user = getSessionUser(req);
  if (!user) { sendJson(res, 401, { error: 'Please log in.' }); return null; }
  const allowed = roles ? (Array.isArray(roles) ? roles : [roles]) : null;
  if (allowed && !allowed.includes(user.role)) { sendJson(res, 403, { error: 'You do not have permission to do that.' }); return null; }
  return user;
}

export function audit(userId, action, metadata = {}) {
  const db = readDb();
  db.auditLogs.push({ id: id('audit'), userId, action, metadata, createdAt: now() });
  writeDb(db);
}

export function sendJson(res, status, data, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(data));
}
export function sendHtml(res, status, html, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...headers });
  res.end(html);
}

export function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' https://api.resend.com https://cybqa.pesapal.com https://pay.pesapal.com; frame-ancestors 'self'; base-uri 'self'; form-action 'self'");
}
