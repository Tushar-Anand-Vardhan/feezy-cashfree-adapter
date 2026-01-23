// src/cashfree/client.js
const axios = require('axios');
const { PARTNERS_BASE, PARTNER_API_VERSION } = require('../config');

const instance = axios.create({
  baseURL: PARTNERS_BASE,
  headers: { 'Content-Type': 'application/json', 'x-api-version': PARTNER_API_VERSION },
  timeout: 15000
});

instance.interceptors.request.use(req => {
  console.log('[CF OUTGOING]', {
    url: req.baseURL + req.url,
    headers: req.headers
  });
  return req;
});

module.exports = instance;
