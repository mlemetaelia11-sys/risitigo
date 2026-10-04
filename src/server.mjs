import './env.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { URL, fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { readDb, writeDb, refreshDb, flushDb, acquireDbLock, databaseHealth, id, token, hashPassword, verifyPassword, now, nextNumber, plans, getPlan } from './db.mjs';
import { createSession, setCookie, clearCookie, destroySession, getSessionUser, requireUser, sendJson, sendHtml, audit, securityHeaders } from './security.mjs';
import { integrationStatus, pesapalSubmitOrder, pesapalStatus, pesapalGetOrRegisterIpn, pesapalUrls, sendResend, sentryCapture } from './integrations.mjs';

const PORT = Number(process.env.PORT || 3000);
const root = fileURLToPath(new URL('..', import.meta.url));
const publicDir = path.join(root, 'public');
const isProd = process.env.NODE_ENV === 'production';
const rate = new Map();

function rateLimit(req, key, limit = 50, windowMs = 60_000) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'local';
  const k = `${key}:${ip}`;
  const t = Date.now();
  const arr = (rate.get(k) || []).filter(x => x > t - windowMs);
  arr.push(t); rate.set(k, arr);
  return arr.length <= limit;
}

function jsonBody(req, maxBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    let raw = '', size = 0;
    req.on('data', chunk => { size += chunk.length; if (size > maxBytes) { reject(Object.assign(new Error('Request too large'), { status: 413 })); req.destroy(); return; } raw += chunk; });
    req.on('end', () => { if (!raw) return resolve({}); try { resolve(JSON.parse(raw)); } catch { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); } });
    req.on('error', reject);
  });
}

function clean(v, max = 500) { return String(v ?? '').trim().slice(0, max); }
function htmlEscape(v) { return String(v ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;'); }
function businessForUser(db, user) { return db.businesses.find(b => b.id === user.businessId); }
function publicOrigin(req) { const proto = req.headers['x-forwarded-proto']?.split(',')[0]?.trim() || (isProd ? 'https' : 'http'); return `${proto}://${req.headers.host}`; }
function currentBase(req) { return (process.env.APP_URL || publicOrigin(req)).replace(/\/$/, ''); }
function monthKey() { return new Date().toISOString().slice(0, 7); }
function money(n) { return Number(n || 0); }
function invoiceStatus(invoice) {
  if (invoice.status === 'cancelled') return 'cancelled';
  if (invoice.balance <= 0) return 'paid';
  if (invoice.amountPaid > 0) return 'partial';
  if (invoice.dueDate && invoice.dueDate < new Date().toISOString().slice(0,10)) return 'overdue';
  return 'sent';
}
function recalcInvoice(db, invoice) {
  invoice.amountPaid = db.payments.filter(p => p.invoiceId === invoice.id && p.status === 'paid').reduce((s,p) => s + money(p.amount), 0);
  invoice.balance = Math.max(0, invoice.total - invoice.amountPaid);
  invoice.status = invoiceStatus(invoice);
  invoice.updatedAt = now();
  const customer = db.customers.find(c => c.id === invoice.customerId);
  if (customer) {
    const invs = db.invoices.filter(i => i.customerId === customer.id && i.businessId === invoice.businessId && i.status !== 'cancelled');
    customer.totalInvoiced = invs.reduce((s,i)=>s+money(i.total),0);
    customer.totalPaid = invs.reduce((s,i)=>s+money(i.amountPaid),0);
    customer.outstandingBalance = Math.max(0, customer.totalInvoiced - customer.totalPaid);
    customer.lastActivityAt = now();
  }
}
function effectivePlan(business) {
  if (!business) return getPlan('free');
  const planId = business.subscriptionPlan || 'free';
  if (planId === 'free') return getPlan('free');
  if (business.subscriptionStatus !== 'active') return getPlan('free');
  if (business.subscriptionCurrentPeriodEnd && new Date(business.subscriptionCurrentPeriodEnd).getTime() <= Date.now()) return getPlan('free');
  return getPlan(planId);
}
function hasFeature(business, featureId) { return effectivePlan(business).featureIds.includes(featureId); }
function featureGate(res, business, featureId, message) {
  if (hasFeature(business, featureId)) return true;
  return sendJson(res, 402, { code: 'FEATURE_LOCKED', feature: featureId, plan: effectivePlan(business).id, error: message || 'Feature hii inahitaji upgrade ya plan.' });
}
function canCreateInvoice(db, businessId) {
  const business = db.businesses.find(b => b.id === businessId);
  const plan = effectivePlan(business);
  if (!Number.isFinite(plan.limits.invoices)) return true;
  const prefix = monthKey();
  const count = db.invoices.filter(i => i.businessId === businessId && String(i.createdAt || '').startsWith(prefix)).length;
  return count < plan.limits.invoices;
}
function canCreateCustomer(db, businessId) {
  const business = db.businesses.find(b => b.id === businessId);
  const limit = effectivePlan(business).limits.customers;
  if (!Number.isFinite(limit)) return true;
  return db.customers.filter(c => c.businessId === businessId).length < limit;
}
function canCreatePayment(db, businessId) {
  const business = db.businesses.find(b => b.id === businessId);
  const limit = effectivePlan(business).limits.payments;
  if (!Number.isFinite(limit)) return true;
  const prefix = monthKey();
  const count = db.payments.filter(p => p.businessId === businessId && String(p.createdAt || '').startsWith(prefix) && p.type !== 'subscription').length;
  return count < limit;
}
function requireBusiness(req, res) { return requireUser(req, res, ['OWNER','PLATFORM_ADMIN']); }
function requireOwnerOrAdmin(req, res) { return requireUser(req, res, ['OWNER','PLATFORM_ADMIN']); }
function planData() { return plans.map(p=>({id:p.id,name:p.name,monthly:p.monthly,yearly:p.yearly,features:p.features,featureIds:p.featureIds})); }

function layout(title, body) {
  return `<!doctype html><html lang="sw"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#14213D"><meta name="description" content="RisitiGo — Invoice, risiti na madeni kwa biashara za Tanzania."><title>${htmlEscape(title)} · RisitiGo</title><link rel="icon" href="/brand/risitigo-mark.svg"><link rel="stylesheet" href="/styles.css"></head><body>${body}<script src="/app.js" defer></script></body></html>`;
}

function updateSubscription(db, payment, status) {
  if (payment.type !== 'subscription') return;
  const b = db.businesses.find(x=>x.id===payment.businessId); if (!b) return;
  const state = String(status?.payment_status_description || status?.status || '').toLowerCase();
  const code = Number(status?.status_code);
  if (code === 1 || state === 'completed') {
    const meta = payment.metadata || {};
    b.subscriptionPlan = meta.planId || b.subscriptionPlan;
    b.subscriptionStatus = 'active';
    b.subscriptionBillingCycle = meta.billingCycle || 'monthly';
    b.subscriptionLastPaymentAt = now();
    const cycleDays = b.subscriptionBillingCycle === 'yearly' ? 365 : 30;
    b.subscriptionCurrentPeriodEnd = new Date(Date.now()+cycleDays*86400000).toISOString();
  }
  payment.status = (code === 1 || state === 'completed') ? 'paid' : ([0,2,3].includes(code) || ['failed','invalid','reversed'].includes(state) ? 'failed' : 'pending');
  payment.providerStatus = status?.payment_status_description || status?.status || null;
  payment.providerStatusCode = status?.status_code ?? null;
  payment.confirmationCode = status?.confirmation_code || null;
  payment.paymentMethod = status?.payment_method || null;
  payment.updatedAt = now();
}

async function api(req, res, u) {
  const db = readDb();
  const p = u.pathname;

  if (req.method === 'GET' && p === '/api/session') {
    const user = getSessionUser(req); const b = user ? businessForUser(db,user) : null;
    return sendJson(res, 200, { authenticated: !!user, user: user ? { id:user.id,email:user.email,name:user.name,role:user.role,businessId:user.businessId } : null, business:b ? {id:b.id,name:b.name,logo:b.logo,subscriptionPlan:effectivePlan(b).id,subscriptionStatus:b.subscriptionStatus,subscriptionCurrentPeriodEnd:b.subscriptionCurrentPeriodEnd,features:effectivePlan(b).featureIds} : null });
  }

  if (req.method === 'POST' && p === '/api/auth/signup') {
    if (!rateLimit(req,'signup',8,15*60_000)) return sendJson(res,429,{error:'Too many signup attempts. Try again later.'});
    const x=await jsonBody(req); const name=clean(x.name,120), email=clean(x.email,180).toLowerCase(), password=String(x.password||''), businessName=clean(x.businessName,140), phone=clean(x.phone,30), category=clean(x.category,80)||'Other';
    if(!name||!/^\S+@\S+\.\S+$/.test(email)||password.length<10||!businessName) return sendJson(res,400,{error:'Weka jina, email sahihi, jina la biashara na password yenye angalau characters 10.'});
    if(db.users.some(u=>u.email.toLowerCase()===email)) return sendJson(res,409,{error:'Email hii tayari imesajiliwa.'});
    const first = db.users.length === 0; const userId=id('usr'), businessId=id('biz');
    const slugBase=businessName.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,50)||'biashara'; let slug=slugBase,n=2; while(db.businesses.some(b=>b.slug===slug)) slug=`${slugBase}-${n++}`;
    const user={id:userId,email,name,passwordHash:hashPassword(password),role:first?'PLATFORM_ADMIN':'OWNER',businessId,createdAt:now()};
    const business={id:businessId,ownerUserId:userId,name:businessName,slug,category,phone,email,address:'',city:'',country:'Tanzania',tin:'',logo:'/brand/risitigo-mark.svg',currency:'TZS',subscriptionPlan:'free',subscriptionStatus:'trial',subscriptionBillingCycle:'monthly',subscriptionCurrentPeriodEnd:null,subscriptionLastPaymentAt:null,createdAt:now()};
    db.users.push(user); db.businesses.push(business); writeDb(db);
    const sid=createSession(user.id); audit(user.id,'signup',{firstUser:first,businessId});
    return sendJson(res,201,{ok:true,user:{id:user.id,name:user.name,email:user.email,role:user.role,businessId},business},{'Set-Cookie':setCookie('risitigo_session',sid)});
  }

  if (req.method === 'POST' && p === '/api/auth/login') {
    if (!rateLimit(req,'login',12,10*60_000)) return sendJson(res,429,{error:'Too many login attempts. Jaribu tena baadaye.'});
    const x=await jsonBody(req); const email=clean(x.email,180).toLowerCase(); const password=String(x.password||'');
    const user=db.users.find(u=>u.email.toLowerCase()===email);
    if(!user||!verifyPassword(password,user.passwordHash)) return sendJson(res,401,{error:'Email au password si sahihi.'});
    const sid=createSession(user.id); audit(user.id,'login');
    return sendJson(res,200,{ok:true,user:{id:user.id,name:user.name,email:user.email,role:user.role,businessId:user.businessId}},{'Set-Cookie':setCookie('risitigo_session',sid)});
  }
  if (req.method === 'POST' && p === '/api/auth/logout') { destroySession(req); return sendJson(res,200,{ok:true},{'Set-Cookie':clearCookie('risitigo_session')}); }

  if (req.method === 'GET' && p === '/api/plans') return sendJson(res,200,{plans:planData()});

  if (req.method === 'GET' && p === '/api/dashboard/summary') {
    const user=requireBusiness(req,res); if(!user)return; const b=businessForUser(db,user);
    const inv=db.invoices.filter(i=>i.businessId===b.id && i.status!=='cancelled'); const pay=db.payments.filter(x=>x.businessId===b.id && x.status==='paid'); const customers=db.customers.filter(x=>x.businessId===b.id);
    const month=monthKey(); const monthInv=inv.filter(i=>String(i.date||'').startsWith(month));
    return sendJson(res,200,{business:b,counts:{customers:customers.length,invoices:inv.length,quotes:db.quotes.filter(q=>q.businessId===b.id).length,debts:inv.filter(i=>i.balance>0).length},salesToday:inv.filter(i=>i.date===new Date().toISOString().slice(0,10)).reduce((s,i)=>s+i.total,0),paidToday:pay.filter(x=>String(x.createdAt).slice(0,10)===new Date().toISOString().slice(0,10)).reduce((s,p)=>s+p.amount,0),outstanding:inv.reduce((s,i)=>s+i.balance,0),monthSales:monthInv.reduce((s,i)=>s+i.total,0),recentInvoices:inv.sort((a,z)=>String(z.createdAt).localeCompare(String(a.createdAt))).slice(0,8).map(i=>({...i,customerName:customers.find(c=>c.id===i.customerId)?.name||'—'})),overdue:inv.filter(i=>i.balance>0&&i.dueDate&&i.dueDate<new Date().toISOString().slice(0,10)).sort((a,z)=>a.dueDate.localeCompare(z.dueDate)).slice(0,6).map(i=>({...i,customerName:customers.find(c=>c.id===i.customerId)?.name||'—'}))});
  }

  if (req.method === 'GET' && p === '/api/customers') { const user=requireBusiness(req,res);if(!user)return;const b=businessForUser(db,user);return sendJson(res,200,{customers:db.customers.filter(c=>c.businessId===b.id).sort((a,z)=>z.name.localeCompare(a.name))}); }
  if (req.method === 'POST' && p === '/api/customers') { const user=requireBusiness(req,res);if(!user)return;const b=businessForUser(db,user);if(!canCreateCustomer(db,b.id))return sendJson(res,402,{code:'LIMIT_REACHED',feature:'customer.create',error:'Free plan imefikia wateja 10. Upgrade ili kuongeza wateja zaidi.'});const x=await jsonBody(req);const name=clean(x.name,120),phone=clean(x.phone,40),email=clean(x.email,180);if(!name||!phone)return sendJson(res,400,{error:'Jina na namba ya simu vinahitajika.'});const duplicate=db.customers.find(c=>c.businessId===b.id&&c.phone===phone);if(duplicate)return sendJson(res,409,{error:'Mteja mwenye namba hiyo tayari yupo.',customer:duplicate});const c={id:id('cus'),businessId:b.id,name,phone,email,address:clean(x.address,240),notes:clean(x.notes,400),totalInvoiced:0,totalPaid:0,outstandingBalance:0,createdAt:now(),lastActivityAt:now()};db.customers.push(c);writeDb(db);return sendJson(res,201,{customer:c}); }
  if (req.method === 'PUT' && p.startsWith('/api/customers/')) { const user=requireBusiness(req,res);if(!user)return;const b=businessForUser(db,user);const cid=p.split('/').pop();const c=db.customers.find(x=>x.id===cid&&x.businessId===b.id);if(!c)return sendJson(res,404,{error:'Customer not found'});const x=await jsonBody(req);Object.assign(c,{name:clean(x.name,120)||c.name,phone:clean(x.phone,40)||c.phone,email:clean(x.email,180),address:clean(x.address,240),notes:clean(x.notes,400),updatedAt:now()});writeDb(db);return sendJson(res,200,{customer:c}); }

  if (req.method === 'GET' && p === '/api/invoices') { const user=requireBusiness(req,res);if(!user)return;const b=businessForUser(db,user);const rows=db.invoices.filter(i=>i.businessId===b.id).sort((a,z)=>String(z.createdAt).localeCompare(String(a.createdAt))).map(i=>({...i,customerName:db.customers.find(c=>c.id===i.customerId)?.name||'—',customerPhone:db.customers.find(c=>c.id===i.customerId)?.phone||''}));return sendJson(res,200,{invoices:rows}); }
  if (req.method === 'GET' && p.startsWith('/api/invoices/') && !p.endsWith('/payments')) { const user=requireBusiness(req,res);if(!user)return;const b=businessForUser(db,user);const iid=p.split('/').pop();const invoice=db.invoices.find(i=>i.id===iid&&i.businessId===b.id);if(!invoice)return sendJson(res,404,{error:'Invoice not found'});return sendJson(res,200,{invoice,customer:db.customers.find(c=>c.id===invoice.customerId),payments:db.payments.filter(x=>x.invoiceId===invoice.id).sort((a,z)=>z.createdAt.localeCompare(a.createdAt))}); }
  if (req.method === 'POST' && p === '/api/invoices') {
    const user=requireBusiness(req,res);if(!user)return;const b=businessForUser(db,user);if(!canCreateInvoice(db,b.id))return sendJson(res,402,{error:'Umefikia kikomo cha Free plan. Upgrade ili kutengeneza invoices zaidi.'});const x=await jsonBody(req);const customer=db.customers.find(c=>c.id===x.customerId&&c.businessId===b.id);if(!customer)return sendJson(res,400,{error:'Mteja si sahihi.'});const rawItems=Array.isArray(x.items)?x.items:[];const items=rawItems.map(it=>({name:clean(it.name,160),qty:Math.max(1,Number(it.qty)||1),unitPrice:Math.max(0,Number(it.unitPrice)||0)})).filter(it=>it.name);if(!items.length)return sendJson(res,400,{error:'Ongeza angalau bidhaa/huduma moja.'});const subtotal=items.reduce((s,it)=>s+it.qty*it.unitPrice,0);const discount=Math.max(0,Number(x.discount)||0);const tax=Math.max(0,Number(x.tax)||0);const total=Math.max(0,subtotal-discount+tax);const invoice={id:id('inv'),businessId:b.id,customerId:customer.id,number:nextNumber(db,b.id,'invoice','INV'),date:clean(x.date,10)||new Date().toISOString().slice(0,10),dueDate:clean(x.dueDate,10),items,subtotal,discount,tax,total,amountPaid:0,balance:total,status:'sent',notes:clean(x.notes,1000),shareToken:token(),createdAt:now(),updatedAt:now()};db.invoices.push(invoice);recalcInvoice(db,invoice);writeDb(db);audit(user.id,'invoice_created',{invoiceId:invoice.id});return sendJson(res,201,{invoice,shareUrl:`${currentBase(req)}/i/${invoice.shareToken}`}); }
  if (req.method === 'POST' && p.startsWith('/api/invoices/') && p.endsWith('/cancel')) { const user=requireBusiness(req,res);if(!user)return;const b=businessForUser(db,user);const iid=p.split('/')[3];const invoice=db.invoices.find(i=>i.id===iid&&i.businessId===b.id);if(!invoice)return sendJson(res,404,{error:'Invoice not found'});invoice.status='cancelled';invoice.updatedAt=now();writeDb(db);return sendJson(res,200,{invoice}); }
  if (req.method === 'POST' && p === '/api/payments') { const user=requireBusiness(req,res);if(!user)return;const b=businessForUser(db,user);if(!canCreatePayment(db,b.id))return sendJson(res,402,{code:'LIMIT_REACHED',feature:'payment.create',error:'Free plan imefikia receipts/malipo 10 kwa mwezi. Upgrade ili kuendelea.'});const x=await jsonBody(req);const invoice=db.invoices.find(i=>i.id===x.invoiceId&&i.businessId===b.id);if(!invoice)return sendJson(res,404,{error:'Invoice not found'});const amount=Math.min(Math.max(0,Number(x.amount)||0),invoice.balance);if(!amount)return sendJson(res,400,{error:'Amount ya malipo si sahihi.'});const payment={id:id('pay'),businessId:b.id,invoiceId:invoice.id,receiptNumber:nextNumber(db,b.id,'receipt','RCT'),amount,currency:'TZS',method:clean(x.method,40)||'Other',reference:clean(x.reference,100),note:clean(x.note,300),status:'paid',createdAt:now()};db.payments.push(payment);recalcInvoice(db,invoice);writeDb(db);audit(user.id,'payment_recorded',{paymentId:payment.id,invoiceId:invoice.id,amount});return sendJson(res,201,{payment,invoice}); }

  if (req.method === 'GET' && p === '/api/quotes') { const user=requireBusiness(req,res);if(!user)return;const b=businessForUser(db,user);if(!featureGate(res,b,'quote.create','Quotations zinapatikana kuanzia Starter plan.'))return;return sendJson(res,200,{quotes:db.quotes.filter(q=>q.businessId===b.id).sort((a,z)=>z.createdAt.localeCompare(a.createdAt)).map(q=>({...q,customerName:db.customers.find(c=>c.id===q.customerId)?.name||'—'}))}); }
  if (req.method === 'POST' && p === '/api/quotes') { const user=requireBusiness(req,res);if(!user)return;const b=businessForUser(db,user);if(!featureGate(res,b,'quote.create','Quotations zinapatikana kuanzia Starter plan.'))return;const x=await jsonBody(req);const customer=db.customers.find(c=>c.id===x.customerId&&c.businessId===b.id);if(!customer)return sendJson(res,400,{error:'Mteja si sahihi.'});const items=(Array.isArray(x.items)?x.items:[]).map(it=>({name:clean(it.name,160),qty:Math.max(1,Number(it.qty)||1),unitPrice:Math.max(0,Number(it.unitPrice)||0)})).filter(it=>it.name);if(!items.length)return sendJson(res,400,{error:'Ongeza angalau item moja.'});const subtotal=items.reduce((s,it)=>s+it.qty*it.unitPrice,0),discount=Math.max(0,Number(x.discount)||0),tax=Math.max(0,Number(x.tax)||0),total=Math.max(0,subtotal-discount+tax);const quote={id:id('quo'),businessId:b.id,customerId:customer.id,number:nextNumber(db,b.id,'quote','QT'),date:clean(x.date,10)||new Date().toISOString().slice(0,10),validUntil:clean(x.validUntil,10),items,subtotal,discount,tax,total,status:'draft',notes:clean(x.notes,1000),shareToken:token(),createdAt:now()};db.quotes.push(quote);writeDb(db);return sendJson(res,201,{quote,shareUrl:`${currentBase(req)}/q/${quote.shareToken}`}); }
  if (req.method === 'POST' && p.startsWith('/api/quotes/') && p.endsWith('/convert')) { const user=requireBusiness(req,res);if(!user)return;const b=businessForUser(db,user);if(!featureGate(res,b,'quote.create','Quotations zinapatikana kuanzia Starter plan.'))return;const qid=p.split('/')[3];const q=db.quotes.find(q=>q.id===qid&&q.businessId===b.id);if(!q)return sendJson(res,404,{error:'Quote not found'});if(!canCreateInvoice(db,b.id))return sendJson(res,402,{error:'Upgrade plan yako ili kuendelea.'});const invoice={id:id('inv'),businessId:b.id,customerId:q.customerId,number:nextNumber(db,b.id,'invoice','INV'),date:new Date().toISOString().slice(0,10),dueDate:'',items:q.items,subtotal:q.subtotal,discount:q.discount,tax:q.tax,total:q.total,amountPaid:0,balance:q.total,status:'sent',notes:q.notes,shareToken:token(),createdAt:now(),updatedAt:now()};db.invoices.push(invoice);q.status='converted';q.invoiceId=invoice.id;recalcInvoice(db,invoice);writeDb(db);return sendJson(res,201,{invoice}); }

  if (req.method === 'GET' && p === '/api/debts') {
    const user=requireBusiness(req,res);if(!user)return;const b=businessForUser(db,user);if(!featureGate(res,b,'debt.track','Debt tracking inapatikana kuanzia Starter plan.'))return;const invoices=db.invoices.filter(i=>i.businessId===b.id&&i.balance>0&&i.status!=='cancelled').sort((a,z)=>String(a.dueDate||'9999-12-31').localeCompare(String(z.dueDate||'9999-12-31'))).map(i=>({...i,customerName:db.customers.find(c=>c.id===i.customerId)?.name||'—',customerPhone:db.customers.find(c=>c.id===i.customerId)?.phone||''}));return sendJson(res,200,{invoices});
  }

  if (req.method === 'GET' && p === '/api/reports') { const user=requireBusiness(req,res);if(!user)return;const b=businessForUser(db,user);if(!featureGate(res,b,'reports.view','Reports zinapatikana kuanzia Pro plan.'))return;const inv=db.invoices.filter(i=>i.businessId===b.id&&i.status!=='cancelled');const payments=db.payments.filter(p=>p.businessId===b.id&&p.status==='paid');const quotes=db.quotes.filter(q=>q.businessId===b.id);return sendJson(res,200,{sales:inv.reduce((s,i)=>s+i.total,0),paid:payments.reduce((s,p)=>s+p.amount,0),outstanding:inv.reduce((s,i)=>s+i.balance,0),invoiceCount:inv.length,paidInvoiceCount:inv.filter(i=>i.status==='paid').length,overdueCount:inv.filter(i=>i.balance>0&&i.dueDate&&i.dueDate<new Date().toISOString().slice(0,10)).length,quoteCount:quotes.length,monthly:Array.from({length:6},(_,idx)=>{const d=new Date();d.setMonth(d.getMonth()-5+idx);const m=d.toISOString().slice(0,7);return {month:m,sales:inv.filter(i=>String(i.date).startsWith(m)).reduce((s,i)=>s+i.total,0)}})}); }

  if (req.method === 'GET' && p === '/api/business/settings') { const user=requireBusiness(req,res);if(!user)return;return sendJson(res,200,{business:businessForUser(db,user)}); }
  if (req.method === 'POST' && p === '/api/business/settings') { const user=requireBusiness(req,res);if(!user)return;const b=businessForUser(db,user);const x=await jsonBody(req);Object.assign(b,{name:clean(x.name,140)||b.name,phone:clean(x.phone,40),email:clean(x.email,180),address:clean(x.address,240),city:clean(x.city,100),tin:clean(x.tin,80),category:clean(x.category,80)});if(hasFeature(b,'business.branding')) b.logo=clean(x.logo,500)||b.logo;writeDb(db);return sendJson(res,200,{business:b}); }

  if (req.method === 'GET' && p.startsWith('/api/whatsapp/reminder/')) {
    const user=requireBusiness(req,res);if(!user)return;const b=businessForUser(db,user);if(!featureGate(res,b,'whatsapp.reminder','WhatsApp reminders zinapatikana kuanzia Starter plan.'))return;const iid=p.split('/').pop();const invoice=db.invoices.find(i=>i.id===iid&&i.businessId===b.id);if(!invoice)return sendJson(res,404,{error:'Invoice not found'});const customer=db.customers.find(c=>c.id===invoice.customerId&&c.businessId===b.id);if(!customer)return sendJson(res,404,{error:'Customer not found'});const phone=customer.phone.replace(/[^0-9]/g,'');const message=`Habari ${customer.name}, tunakukumbusha balance ya TSh ${Number(invoice.balance||0).toLocaleString('en-TZ')} kwenye invoice ${invoice.number} ya ${b.name}. Asante.`;return sendJson(res,200,{message,waUrl:`https://wa.me/${encodeURIComponent(phone)}?text=${encodeURIComponent(message)}`});
  }

  if (req.method === 'GET' && p === '/api/integrations/status') { const user=requireBusiness(req,res);if(!user)return;return sendJson(res,200,{integrations:integrationStatus(),pesapal:pesapalUrls()}); }
  if (req.method === 'POST' && p === '/api/integrations/pesapal/test-ipn') { const user=requireOwnerOrAdmin(req,res);if(!user)return;try{return sendJson(res,200,{ok:true,ipnId:await pesapalGetOrRegisterIpn(),urls:pesapalUrls()});}catch(e){return sendJson(res,503,{error:e.message});} }
  if (req.method === 'POST' && p === '/api/integrations/email/test') { const user=requireOwnerOrAdmin(req,res);if(!user)return;const x=await jsonBody(req);try{return sendJson(res,200,{ok:true,result:await sendResend({to:x.to||user.email,subject:'RisitiGo integration test',html:'<h2>RisitiGo</h2><p>Email integration iko sawa.</p>',idempotencyKey:`risitigo-test-${user.id}`})});}catch(e){return sendJson(res,503,{error:e.message});} }
  if (req.method === 'POST' && p === '/api/integrations/sentry/test') { const user=requireOwnerOrAdmin(req,res);if(!user)return;try{return sendJson(res,200,await sentryCapture({message:'RisitiGo test event'}));}catch(e){return sendJson(res,503,{error:e.message});} }

  if (req.method === 'POST' && p === '/api/subscriptions/checkout') {
    const user=requireOwnerOrAdmin(req,res);if(!user)return;const b=businessForUser(db,user);const x=await jsonBody(req);const plan=getPlan(clean(x.planId,30));if(!plan||plan.id==='free')return sendJson(res,400,{error:'Chagua paid plan.'});const cycle=x.billingCycle==='yearly'?'yearly':'monthly';const amount=cycle==='yearly'?plan.yearly:plan.monthly;const reference=`RGO-SUB-${b.id}-${Date.now()}`;try{const result=await pesapalSubmitOrder({reference,amount,description:`RisitiGo ${plan.name} ${cycle} subscription`,customer:{name:user.name,email:user.email,phone:b.phone}});db.payments.push({id:id('pay'),businessId:b.id,invoiceId:null,type:'subscription',receiptNumber:null,amount,currency:'TZS',status:'pending',provider:'Pesapal',reference,trackingId:result.order_tracking_id,metadata:{planId:plan.id,planName:plan.name,billingCycle:cycle},createdAt:now()});writeDb(db);return sendJson(res,200,{ok:true,result,reference,plan,amount});}catch(e){return sendJson(res,503,{error:e.message});}
  }

  if (req.method === 'GET' && p === '/api/subscriptions/status') { const user=requireOwnerOrAdmin(req,res);if(!user)return;const b=businessForUser(db,user),tracking=clean(u.searchParams.get('trackingId'),200),payment=db.payments.find(p=>p.businessId===b.id&&p.trackingId===tracking&&p.type==='subscription');if(!payment)return sendJson(res,404,{error:'Payment not found'});try{const status=await pesapalStatus(tracking);updateSubscription(db,payment,status);writeDb(db);return sendJson(res,200,{status,payment,business:b});}catch(e){return sendJson(res,503,{error:e.message});} }

  if ((req.method==='POST'||req.method==='GET') && p==='/api/webhooks/pesapal/ipn') { const x=req.method==='GET'?Object.fromEntries(u.searchParams.entries()):await jsonBody(req);const tracking=clean(x.OrderTrackingId,200);if(!tracking)return sendJson(res,400,{orderNotificationType:'IPNCHANGE',orderTrackingId:null,status:400});try{const status=await pesapalStatus(tracking);const payment=db.payments.find(p=>p.trackingId===tracking);if(payment){updateSubscription(db,payment,status);writeDb(db);}return sendJson(res,200,{orderNotificationType:'IPNCHANGE',orderTrackingId:tracking,orderMerchantReference:x.OrderMerchantReference||payment?.reference||null,status:200});}catch(e){return sendJson(res,500,{orderNotificationType:'IPNCHANGE',orderTrackingId:tracking,status:500,error:'Unable to verify payment'});} }
  if (req.method==='GET' && p==='/api/webhooks/pesapal/callback') { const tracking=clean(u.searchParams.get('OrderTrackingId'),200);const merchant=clean(u.searchParams.get('OrderMerchantReference'),200);if(!tracking)return sendHtml(res,400,layout('Payment callback','<main class="public-shell"><section class="public-card"><img src="/brand/risitigo-wordmark.svg" class="wordmark"><h1>Payment callback haijakamilika</h1><p>Tracking ID haijarudi kutoka Pesapal.</p><a class="btn btn-primary" href="/">Rudi RisitiGo</a></section></main>'));try{const status=await pesapalStatus(tracking);const payment=db.payments.find(p=>p.trackingId===tracking);if(payment){updateSubscription(db,payment,status);writeDb(db);}const code=Number(status.status_code),state=code===1?'paid':([0,2,3].includes(code)?'failed':'pending');const title=state==='paid'?'Malipo yamefanikiwa':state==='failed'?'Malipo yameshindikana':'Malipo yanaendelea';return sendHtml(res,200,layout(title,`<main class="public-shell"><section class="public-card payment-result"><img src="/brand/risitigo-wordmark.svg" class="wordmark"><div class="result-icon ${state}">${state==='paid'?'✓':state==='failed'?'!':'…'}</div><h1>${htmlEscape(title)}</h1><p>Reference: <b>${htmlEscape(merchant||payment?.reference||'—')}</b></p><div class="result-box"><div>Status <b>${htmlEscape(status.payment_status_description||state)}</b></div><div>Amount <b>${htmlEscape(status.amount||payment?.amount||'—')} TZS</b></div><div>Tracking ID <b class="wrap">${htmlEscape(tracking)}</b></div></div><a class="btn btn-primary" href="/app">Rudi kwenye dashboard</a></section></main>`));}catch(e){return sendHtml(res,503,layout('Payment verification',`<main class="public-shell"><section class="public-card"><img src="/brand/risitigo-wordmark.svg" class="wordmark"><h1>Malipo yanachakatwa</h1><p>RisitiGo imerudi kutoka Pesapal lakini haikuweza kuthibitisha status kwa sasa.</p><a class="btn btn-primary" href="/app">Rudi kwenye app</a></section></main>`));} }

  if (req.method === 'GET' && p === '/api/admin/overview') { const user=requireUser(req,res,'PLATFORM_ADMIN');if(!user)return;const d=readDb();return sendJson(res,200,{counts:{users:d.users.length,businesses:d.businesses.length,invoices:d.invoices.length,payments:d.payments.length},users:d.users.map(u=>({id:u.id,name:u.name,email:u.email,role:u.role,createdAt:u.createdAt})),businesses:d.businesses.map(b=>({id:b.id,name:b.name,category:b.category,subscriptionPlan:b.subscriptionPlan,subscriptionStatus:b.subscriptionStatus,owner:d.users.find(u=>u.id===b.ownerUserId)?.email||''}))}); }

  return sendJson(res,404,{error:'Not found'});
}

function receiptPublicHtml(payment, invoice, business, customer) {
  return layout(`Receipt ${payment.receiptNumber}`,`<main class="doc-shell"><section class="document"><div class="doc-head"><div><img src="${htmlEscape(business.logo||'/brand/risitigo-mark.svg')}" class="doc-logo"><h1>${htmlEscape(business.name)}</h1><p>${htmlEscape(business.address||business.city||'Tanzania')} · ${htmlEscape(business.phone||'')}</p></div><div class="doc-type"><span>RECEIPT</span><b>${htmlEscape(payment.receiptNumber)}</b><small>${htmlEscape(payment.createdAt.slice(0,10))}</small></div></div><hr><div class="doc-meta"><div><span>MTEJA</span><b>${htmlEscape(customer?.name||'—')}</b><small>${htmlEscape(customer?.phone||'')}</small></div><div><span>INVOICE</span><b>${htmlEscape(invoice?.number||'—')}</b><small>${htmlEscape(payment.method||'Other')}</small></div></div><div class="result-box"><div>Amount Paid <b>${Number(payment.amount).toLocaleString()} TZS</b></div><div>Payment Method <b>${htmlEscape(payment.method||'Other')}</b></div>${payment.reference?`<div>Reference <b>${htmlEscape(payment.reference)}</b></div>`:''}<div>Invoice Total <b>${Number(invoice?.total||0).toLocaleString()} TZS</b></div><div>Balance <b>${Number(invoice?.balance||0).toLocaleString()} TZS</b></div></div><div class="doc-notes"><b>Asante!</b><p>Asante kwa biashara yako. Hii ni receipt iliyotengenezwa na RisitiGo.</p></div><div class="doc-foot">RisitiGo · Invoice, risiti na madeni kwa biashara za Tanzania.</div><div class="no-print doc-actions"><button class="btn btn-primary" id="printDoc">Print / Save PDF</button><button class="btn" id="backDoc">Back</button></div></section></main>`);
}

function invoicePublicHtml(invoice, business, customer, kind='invoice') {
  const title=kind==='quote'?'QUOTATION':'INVOICE';
  const rows=(invoice.items||[]).map(it=>`<tr><td>${htmlEscape(it.name)}</td><td class="right">${it.qty}</td><td class="right">${Number(it.unitPrice).toLocaleString()}</td><td class="right">${(it.qty*it.unitPrice).toLocaleString()}</td></tr>`).join('');
  return layout(`${title} ${invoice.number}`,`<main class="doc-shell"><section class="document"><div class="doc-head"><div><img src="${htmlEscape(business.logo||'/brand/risitigo-mark.svg')}" class="doc-logo"><h1>${htmlEscape(business.name)}</h1><p>${htmlEscape(business.address||business.city||'Tanzania')} · ${htmlEscape(business.phone||'')}</p></div><div class="doc-type"><span>${title}</span><b>${htmlEscape(invoice.number)}</b><small>${htmlEscape(invoice.date)}</small></div></div><hr><div class="doc-meta"><div><span>MTEJA</span><b>${htmlEscape(customer?.name||'—')}</b><small>${htmlEscape(customer?.phone||'')} ${customer?.email?'· '+htmlEscape(customer.email):''}</small></div><div><span>TOLEO</span><b>${htmlEscape(invoice.date)}</b><small>${invoice.dueDate?'Due: '+htmlEscape(invoice.dueDate):'Malipo kutokana'}</small></div></div><table class="doc-table"><thead><tr><th>Bidhaa / Huduma</th><th class="right">Qty</th><th class="right">Bei</th><th class="right">Jumla</th></tr></thead><tbody>${rows}</tbody></table><div class="doc-summary"><div>Subtotal <b>${invoice.subtotal.toLocaleString()} TZS</b></div><div>Discount <b>${invoice.discount.toLocaleString()} TZS</b></div><div>VAT/Tax <b>${invoice.tax.toLocaleString()} TZS</b></div><div class="grand">TOTAL <b>${invoice.total.toLocaleString()} TZS</b></div>${kind==='invoice'?`<div>Imelipwa <b>${invoice.amountPaid.toLocaleString()} TZS</b></div><div>Balance <b>${invoice.balance.toLocaleString()} TZS</b></div>`:''}</div>${invoice.notes?`<div class="doc-notes"><b>Notes</b><p>${htmlEscape(invoice.notes)}</p></div>`:''}<div class="doc-foot">Imetengenezwa na <b>RisitiGo</b> · Invoice, risiti na madeni kwa biashara za Tanzania.</div><div class="no-print doc-actions"><button class="btn btn-primary" id="printDoc">Print / Save PDF</button><button class="btn" id="backDoc">Back</button></div></section></main>`);
}

async function page(req,res,u) {
  if (u.pathname.startsWith('/i/')) { const d=readDb(),key=clean(u.pathname.split('/')[2],120),invoice=d.invoices.find(i=>i.shareToken===key);if(!invoice)return sendJson(res,404,{error:'Invoice not found'});const business=d.businesses.find(b=>b.id===invoice.businessId),customer=d.customers.find(c=>c.id===invoice.customerId);return sendHtml(res,200,invoicePublicHtml(invoice,business,customer,'invoice')); }
  if (u.pathname.startsWith('/q/')) { const d=readDb(),key=clean(u.pathname.split('/')[2],120),quote=d.quotes.find(i=>i.shareToken===key);if(!quote)return sendJson(res,404,{error:'Quote not found'});const business=d.businesses.find(b=>b.id===quote.businessId),customer=d.customers.find(c=>c.id===quote.customerId);return sendHtml(res,200,invoicePublicHtml(quote,business,customer,'quote')); }
  if (u.pathname.startsWith('/receipt/')) { const d=readDb(),key=clean(u.pathname.split('/')[2],120),payment=d.payments.find(p=>p.receiptNumber===key);if(!payment||payment.status!=='paid'||!payment.invoiceId)return sendJson(res,404,{error:'Receipt not found'});const invoice=d.invoices.find(i=>i.id===payment.invoiceId),business=d.businesses.find(b=>b.id===payment.businessId),customer=d.customers.find(c=>c.id===invoice?.customerId);return sendHtml(res,200,receiptPublicHtml(payment,invoice,business,customer)); }
  if (u.pathname === '/' || u.pathname === '/login' || u.pathname === '/signup' || u.pathname === '/pricing' || u.pathname === '/app' || u.pathname === '/dashboard') return sendHtml(res,200,layout('RisitiGo','<div id="app"></div>'));
  return sendJson(res,404,{error:'Not found'});
}

const server=http.createServer(async(req,res)=>{
  let releaseDb = null;
  try {
    securityHeaders(res);
    res.setHeader('Cache-Control','no-store');
    const cleanPath = req.url.split('?')[0];
    if (req.method==='GET' && req.url.startsWith('/brand/')) { const rel=cleanPath.slice(1); const file=path.resolve(publicDir,rel); if(file.startsWith(path.resolve(publicDir))&&fs.existsSync(file)){res.writeHead(200,{'Content-Type':'image/svg+xml','Cache-Control':'public,max-age=86400'});return res.end(fs.readFileSync(file));} }
    if (req.method==='GET' && cleanPath==='/styles.css') {res.writeHead(200,{'Content-Type':'text/css; charset=utf-8'});return res.end(fs.readFileSync(path.join(publicDir,'styles.css')))}
    if (req.method==='GET' && cleanPath==='/app.js') {res.writeHead(200,{'Content-Type':'application/javascript; charset=utf-8'});return res.end(fs.readFileSync(path.join(publicDir,'app.js')))}
    const u=new URL(req.url,publicOrigin(req));
    if (process.env.DATABASE_URL) { releaseDb = await acquireDbLock(); await refreshDb(); }
    if(u.pathname==='/health'&&req.method==='GET') return sendJson(res,200,{ok:true,service:'RisitiGo',environment:process.env.NODE_ENV||'development',database:databaseHealth(),time:now()});
    if(u.pathname.startsWith('/api/')) return api(req,res,u);
    return page(req,res,u);
  } catch(e) { console.error(e); return sendJson(res,e.status||500,{error:e.status?e.message:'Internal server error'}); }
  finally {
    if (releaseDb) { try { await flushDb(); } catch (e) { console.error('Database flush failed:', e); } try { await releaseDb(); } catch (e) { console.error('Database lock release failed:', e); } }
  }
});

if (process.env.RISITIGO_NO_LISTEN !== '1') server.listen(PORT,'0.0.0.0',()=>console.log(`RisitiGo running on http://0.0.0.0:${PORT}`));
export default server;
