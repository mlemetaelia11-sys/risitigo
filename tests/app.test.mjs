import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(),'risitigo-'));
process.env.NODE_ENV='test';
process.env.RISITIGO_NO_LISTEN='1';
process.env.DATA_FILE=path.join(tmpDir,'db.json');
process.env.APP_URL='http://localhost:3987';
const { default: server } = await import('../src/server.mjs');
await new Promise(resolve=>server.listen(3987,'127.0.0.1',resolve));

const cookieJar={value:''};
async function req(url, options={}){
  const headers={...(options.body?{'Content-Type':'application/json'}:{}),...(options.headers||{})};
  if(cookieJar.value) headers.Cookie=cookieJar.value;
  const r=await fetch(`http://127.0.0.1:3987${url}`,{...options,headers});
  const set=r.headers.get('set-cookie');
  if(set) cookieJar.value=set.split(';')[0];
  return {status:r.status,data:await r.json().catch(()=>null),headers:r.headers};
}

test('health and first-user admin flow',async()=>{
  let r=await req('/health'); assert.equal(r.status,200); assert.equal(r.data.service,'RisitiGo');
  r=await req('/api/auth/signup',{method:'POST',body:JSON.stringify({name:'Juma Mwanga',businessName:'Juma Traders',email:'juma@example.com',phone:'+255712000000',password:'StrongPass12345',category:'Electronics'})});
  assert.equal(r.status,201); assert.equal(r.data.user.role,'PLATFORM_ADMIN'); assert.equal(r.data.business.name,'Juma Traders');
  r=await req('/api/dashboard/summary'); assert.equal(r.status,200); assert.equal(r.data.business.name,'Juma Traders');
});

test('customer invoice payment receipt and public document',async()=>{
  let r=await req('/api/customers',{method:'POST',body:JSON.stringify({name:'Asha Traders',phone:'+255713111111',email:'asha@example.com'})}); assert.equal(r.status,201);
  const cid=r.data.customer.id;
  r=await req('/api/invoices',{method:'POST',body:JSON.stringify({customerId:cid,dueDate:'2099-01-30',items:[{name:'Office Chair',qty:2,unitPrice:75000}],discount:5000,tax:0,notes:'Asante.'})});
  assert.equal(r.status,201); assert.equal(r.data.invoice.total,145000); assert.match(r.data.shareUrl,/\/i\//);
  const iid=r.data.invoice.id, share=r.data.invoice.shareToken;
  r=await req('/api/payments',{method:'POST',body:JSON.stringify({invoiceId:iid,amount:50000,method:'M-Pesa',reference:'MPESA-123'})}); assert.equal(r.status,201); assert.equal(r.data.invoice.balance,95000); assert.equal(r.data.payment.receiptNumber.startsWith('RCT-'),true);
  r=await fetch(`http://127.0.0.1:3987/i/${share}`); assert.equal(r.status,200); const html=await r.text(); assert.match(html,/INV-/); assert.match(html,/Juma Traders/);
  r=await fetch(`http://127.0.0.1:3987/receipt/${'RCT-00001'}`); assert.equal(r.status,200); const receipt=await r.text(); assert.match(receipt,/RECEIPT/); assert.match(receipt,/50,000/);
});

test('second user is owner and first user keeps admin access',async()=>{
  cookieJar.value='';
  let r=await req('/api/auth/signup',{method:'POST',body:JSON.stringify({name:'Neema Admin',businessName:'Neema Salon',email:'neema@example.com',phone:'+255754000000',password:'AnotherStrong123',category:'Salon'})});
  assert.equal(r.status,201); assert.equal(r.data.user.role,'OWNER');
  cookieJar.value='';
  r=await req('/api/auth/login',{method:'POST',body:JSON.stringify({email:'juma@example.com',password:'StrongPass12345'})}); assert.equal(r.status,200); assert.equal(r.data.user.role,'PLATFORM_ADMIN');
  r=await req('/api/admin/overview'); assert.equal(r.status,200); assert.equal(r.data.counts.users,2); assert.equal(r.data.counts.businesses,2);
});

after(async()=>{ await new Promise(resolve=>server.close(resolve)); });

test('free plan limits and premium feature gates are enforced server-side', async()=>{
  const freeCookie = cookieJar.value;
  // Free plan can use invoices/payments, but is capped.
  let r=await req('/api/reports'); assert.equal(r.status,402); assert.equal(r.data.code,'FEATURE_LOCKED');
  r=await req('/api/debts'); assert.equal(r.status,402); assert.equal(r.data.code,'FEATURE_LOCKED');
  r=await req('/api/quotes'); assert.equal(r.status,402); assert.equal(r.data.code,'FEATURE_LOCKED');
  for(let i=0;i<9;i++){
    r=await req('/api/customers',{method:'POST',body:JSON.stringify({name:`Free Customer ${i}`,phone:`+25570000${String(i).padStart(4,'0')}`})});
    assert.equal(r.status,201);
  }
  r=await req('/api/customers',{method:'POST',body:JSON.stringify({name:'Free Customer 11',phone:'+255700009999'})});
  assert.equal(r.status,402); assert.equal(r.data.code,'LIMIT_REACHED');
  // Premium features must be enabled only when the business has an active paid plan.
  const {readDb,writeDb}=await import('../src/db.mjs');
  const db=readDb(); const b=db.businesses.find(x=>x.id===db.users.find(u=>u.email==='juma@example.com').businessId);
  b.subscriptionPlan='starter'; b.subscriptionStatus='active'; b.subscriptionCurrentPeriodEnd=new Date(Date.now()+7*86400000).toISOString(); writeDb(db);
  r=await req('/api/quotes'); assert.equal(r.status,200);
  r=await req('/api/debts'); assert.equal(r.status,200);
  r=await req('/api/whatsapp/reminder/no-such-invoice'); assert.equal(r.status,404);
  // Expired paid plans fall back to Free automatically.
  b.subscriptionCurrentPeriodEnd=new Date(Date.now()-1000).toISOString(); writeDb(db);
  r=await req('/api/reports'); assert.equal(r.status,402); assert.equal(r.data.code,'FEATURE_LOCKED');
  cookieJar.value = freeCookie;
});
