const axios = require('axios');
const crypto = require('crypto');
const db = require('./db');

const API_KEY = process.env.NOWPAYMENTS_API_KEY || '';
const IPN_SECRET = process.env.NOWPAYMENTS_IPN_SECRET || '';
const BASE = 'https://api.nowpayments.io/v1';
const PRICE_USD = parseFloat(process.env.SUBSCRIPTION_PRICE_USD || '5');
const SUB_DAYS = parseInt(process.env.SUBSCRIPTION_DAYS || '30', 10);

function client() {
  return axios.create({
    baseURL: BASE,
    headers: { 'x-api-key': API_KEY, 'Content-Type': 'application/json' },
    timeout: 20000
  });
}

async function ping() {
  try {
    const r = await client().get('/status');
    return r.data && r.data.message === 'OK';
  } catch (e) {
    return false;
  }
}

async function getCurrencies() {
  let universal = [];
  try {
    const r = await client().get('/currencies');
    universal = Array.isArray(r.data?.currencies) ? r.data.currencies : [];
  } catch (e) {
    console.error('[payment] /currencies failed:', e.response?.status, e.response?.data || e.message);
  }
  let selected = [];
  try {
    const r2 = await client().get('/merchant/coins');
    selected = Array.isArray(r2.data?.selectedCurrencies) ? r2.data.selectedCurrencies : [];
  } catch (e) {
    console.error('[payment] /merchant/coins failed:', e.response?.status, e.response?.data || e.message);
  }
  if (selected.length && universal.length) {
    const uniSet = new Set(universal.map(c => String(c).toLowerCase()));
    const filtered = selected.map(c => String(c).toLowerCase()).filter(c => uniSet.has(c));
    if (filtered.length) return filtered;
  }
  if (selected.length) return selected.map(c => String(c).toLowerCase());
  if (universal.length) return universal.map(c => String(c).toLowerCase());
  return [];
}

async function estimatePrice(currency) {
  const r = await client().get('/estimate', {
    params: { amount: PRICE_USD, currency_from: 'usd', currency_to: currency }
  });
  return r.data;
}

async function getMinAmount(currency) {
  try {
    const r = await client().get('/min-amount', {
      params: { currency_from: currency, currency_to: 'usd', fiat_equivalent: 'usd' }
    });
    return r.data?.min_amount || 0;
  } catch (e) {
    return 0;
  }
}

async function createPayment({ payCurrency, email, ip, sessionId, ipnUrl }) {
  const orderId = `sub_${sessionId}`;
  const r = await client().post('/payment', {
    price_amount: PRICE_USD,
    price_currency: 'usd',
    pay_currency: payCurrency,
    order_id: orderId,
    order_description: `Premium subscription (${SUB_DAYS} days)`,
    ipn_callback_url: ipnUrl,
    is_fixed_rate: true,
    is_fee_paid_by_user: true
  });
  return r.data;
}

async function getPaymentStatus(paymentId) {
  const r = await client().get(`/payment/${paymentId}`);
  return r.data;
}

function verifyIpnSignature(rawBody, signatureHeader) {
  if (!IPN_SECRET || !signatureHeader) return false;
  try {
    const parsed = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody;
    const sortedKeys = Object.keys(parsed).sort();
    const sortedObj = {};
    for (const k of sortedKeys) sortedObj[k] = parsed[k];
    const stringified = JSON.stringify(sortedObj);
    const hmac = crypto.createHmac('sha512', IPN_SECRET).update(stringified).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(signatureHeader));
  } catch (e) {
    return false;
  }
}

function isPaidStatus(status) {
  return ['finished', 'confirmed', 'sending'].includes((status || '').toLowerCase());
}

function isFailedStatus(status) {
  return ['failed', 'expired', 'refunded'].includes((status || '').toLowerCase());
}

function isWaitingStatus(status) {
  return ['waiting', 'confirming', 'partially_paid'].includes((status || '').toLowerCase());
}

module.exports = {
  ping,
  getCurrencies,
  estimatePrice,
  getMinAmount,
  createPayment,
  getPaymentStatus,
  verifyIpnSignature,
  isPaidStatus,
  isFailedStatus,
  isWaitingStatus,
  PRICE_USD,
  SUB_DAYS,
  hasApiKey: () => !!API_KEY
};
