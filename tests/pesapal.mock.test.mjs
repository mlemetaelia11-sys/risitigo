import test, { after } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV='test';
process.env.PESAPAL_ENVIRONMENT='sandbox';
process.env.PESAPAL_CONSUMER_KEY='demo-key';
process.env.PESAPAL_CONSUMER_SECRET='demo-secret';
process.env.APP_URL='https://demo.risitigo.co.tz';

const calls=[];
const originalFetch=globalThis.fetch;
globalThis.fetch=async (url,options={})=>{
  calls.push({url,options});
  if(String(url).endsWith('/api/Auth/RequestToken')) return new Response(JSON.stringify({token:'mock-token'}),{status:200,headers:{'content-type':'application/json'}});
  if(String(url).endsWith('/api/URLSetup/GetIpnList')) return new Response(JSON.stringify([]),{status:200,headers:{'content-type':'application/json'}});
  if(String(url).endsWith('/api/URLSetup/RegisterIPN')) return new Response(JSON.stringify({ipn_id:'mock-ipn-guid'}),{status:200,headers:{'content-type':'application/json'}});
  if(String(url).includes('/api/Transactions/SubmitOrderRequest')) return new Response(JSON.stringify({order_tracking_id:'mock-tracking',redirect_url:'https://cybqa.pesapal.com/mock-checkout'}),{status:200,headers:{'content-type':'application/json'}});
  if(String(url).includes('/api/Transactions/GetTransactionStatus')) return new Response(JSON.stringify({status_code:1,payment_status_description:'Completed',confirmation_code:'ABC123'}),{status:200,headers:{'content-type':'application/json'}});
  return new Response(JSON.stringify({message:'unexpected'}),{status:404,headers:{'content-type':'application/json'}});
};

const {pesapalSubmitOrder,pesapalStatus,pesapalUrls}=await import('../src/integrations.mjs');

test('PesaPal API 3 order flow payload and status',async()=>{
  const result=await pesapalSubmitOrder({reference:'RGO-SUB-demo-1',amount:10000,description:'RisitiGo Starter monthly subscription',customer:{name:'Juma Mwanga',email:'juma@example.com',phone:'+255712000000'}});
  assert.equal(result.order_tracking_id,'mock-tracking');
  assert.equal(pesapalUrls().ipnId,'mock-ipn-guid');
  const orderCall=calls.find(x=>String(x.url).includes('SubmitOrderRequest'));
  const payload=JSON.parse(orderCall.options.body);
  assert.equal(payload.currency,'TZS');
  assert.equal(payload.notification_id,'mock-ipn-guid');
  assert.equal(payload.callback_url,'https://demo.risitigo.co.tz/api/webhooks/pesapal/callback');
  const status=await pesapalStatus('mock-tracking');
  assert.equal(status.status_code,1);
  assert.equal(status.confirmation_code,'ABC123');
});

after(()=>{globalThis.fetch=originalFetch});
