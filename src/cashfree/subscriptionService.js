// src/cashfree/subscriptionService.js
const axiosInstance = require('./client');
const { PARTNER_KEY, PG_BASE, PG_API_VERSION } = require('../config');
const axios = require('axios');

async function cashfreePartnerPost(path, body = {}, extraHeaders = {}) {
  const headers = { 
    'x-partner-apikey': PARTNER_KEY, 
    ...extraHeaders 
  };
  console.log('[CF REQUEST]', {
    method: 'POST',
    baseURL: axiosInstance.defaults.baseURL,
    path,
    headers: {
      'x-partner-apikey': PARTNER_KEY ? 'SET' : 'MISSING',
      'x-api-version': extraHeaders['x-api-version'],
      'content-type': extraHeaders['Content-Type']
    },
    body
  });
  
  const url = path.startsWith('http') ? path : `${path.startsWith('/') ? '' : '/'}${path}`;
  try {
    const resp = await axiosInstance.post(url, body, { headers });
    return resp.data;
  } catch (err) {
    console.error('[CF ERROR]', {
      status: err.response?.status,
      data: err.response?.data,
      headers: err.response?.headers
    });
    throw err;
  }
}

// create subscription using PG endpoint (not partners base)
async function createCashfreeSubscription(merchantId, payload, idempotencyKey) {
  const url = `${PG_BASE}/subscriptions`;
  const headers = {
    'x-api-version': '2025-01-01',
    'x-partner-apikey': PARTNER_KEY,
    'x-partner-merchantid': merchantId,
    'x-idempotency-key': idempotencyKey
  };
  // use axios directly because base URL differs
  const resp = await axios.post(url, payload, { headers });
  return resp.data;
}

module.exports = { cashfreePartnerPost, createCashfreeSubscription };
