// src/cashfree/subscriptionService.js
const axiosInstance = require('./client');
const { PARTNER_KEY, PG_BASE } = require('../config');
const axios = require('axios');

async function cashfreePartnerPost(path, body = {}, extraHeaders = {}) {
  const headers = { 
    'x-partner-apikey': PARTNER_KEY, 
    'x-api-version': '2025-01-01',
    ...extraHeaders 
  };
  const url = path.startsWith('http') ? path : `${path.startsWith('/') ? '' : '/'}${path}`;
  const resp = await axiosInstance.post(url, body, { headers });
  return resp.data;
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
