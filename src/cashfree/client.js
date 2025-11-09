// src/cashfree/client.js
const axios = require('axios');
const { PARTNERS_BASE, API_VERSION } = require('../config');

const instance = axios.create({
  baseURL: PARTNERS_BASE,
  headers: { 'Content-Type': 'application/json', 'x-api-version': API_VERSION },
  timeout: 15000
});

module.exports = instance;
