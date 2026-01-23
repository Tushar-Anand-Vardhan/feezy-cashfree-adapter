// src/config.js
const PARTNER_KEY = process.env.PARTNER_API_KEY;
const CF_ENV = (process.env.CF_ENV || 'sandbox').toLowerCase();
const API_VERSION = process.env.CF_API_VERSION || '2023-01-01';
const PARTNER_API_VERSION = process.env.PARTNER_API_VERSION || '2023-01-01';
const PG_API_VERSION = process.env.PG_API_VERSION || '2025-01-01';
const WEBHOOK_TOLERANCE_SEC = Number(process.env.WEBHOOK_TOLERANCE_SEC || 300);

const PARTNERS_BASE = CF_ENV === 'prod' ? 'https://api.cashfree.com/partners' : 'https://api-sandbox.cashfree.com/partners';
const PG_BASE       = CF_ENV === 'prod' ? 'https://api.cashfree.com/pg' : 'https://sandbox.cashfree.com/pg';

module.exports = {
  PARTNER_KEY, CF_ENV, API_VERSION, PARTNER_API_VERSION, PG_API_VERSION, PARTNERS_BASE, PG_BASE, WEBHOOK_TOLERANCE_SEC
};
