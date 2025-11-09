// src/__tests__/routes/debug.route.test.js
const request = require('supertest');
const express = require('express');

jest.mock('axios');
const axios = require('axios');
axios.get = jest.fn(async (url, opts) => ({ data: { merchant_id: 'm1', status: 'OK' } }));

const debugRoutes = require('../../routes/debug');

describe('debug routes', () => {
  let app;
  beforeAll(() => {
    app = express();
    app.use('/', debugRoutes);
  });

  test('GET /health', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.text).toBe('ok');
  });

  test('GET /merchant/:merchantId/status proxies to Cashfree', async () => {
    const res = await request(app).get('/merchant/m1/status');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('merchant_id', 'm1');
  });
});
