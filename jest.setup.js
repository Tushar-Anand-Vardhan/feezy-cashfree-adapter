// jest.setup.js
const path = require('path');
const dotenv = require('dotenv');

// load .env.test when NODE_ENV=test or when running jest
const envFile = path.resolve(process.cwd(), '.env.test');
const result = dotenv.config({ path: envFile });
if (result.error) {
  // no local .env.test found — we still continue because CI uses secrets
  // but set safe defaults so tests don't crash
  process.env.PARTNER_API_KEY = process.env.PARTNER_API_KEY || 'testkey_ci';
  process.env.CF_ENV = process.env.CF_ENV || 'sandbox';
  process.env.CF_API_VERSION = process.env.CF_API_VERSION || '2023-01-01';
}
