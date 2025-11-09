// src/__tests__/webhook.route.test.js
const request = require('supertest');
const express = require('express');

jest.mock('../cashfree/signature', () => ({
  verifyCashfreeSignature: jest.fn(() => true)
}));
jest.mock('../services/mandateService', () => ({
  upsertMandateFromWebhook: jest.fn(async () => 'doc123')
}));
jest.mock('../services/eventService', () => ({ logEvent: jest.fn(async ()=>{}) }));

const webhookRoute = require('../routes/webhook');

describe('POST /webhook', () => {
  let app;
  beforeAll(() => {
    app = express();
    // capture raw body like server.js
    app.use(express.json({
      verify: (req, res, buf) => { req.rawBody = buf.toString(); }
    }));
    app.use('/webhook', webhookRoute);
  });

  test('responds 200 immediately and processes payload', async () => {
    const payload = { type: 'SUBSCRIPTION_UPDATED', data: { subscription_id: 's1', status: 'ACTIVE' } };
    const res = await request(app)
      .post('/webhook')
      .set('x-webhook-timestamp', String(Math.floor(Date.now()/1000)))
      .set('x-webhook-signature', 'fake')
      .send(payload);

    expect(res.status).toBe(200);
    // assert our mocked upsertMandateFromWebhook was called
    const { upsertMandateFromWebhook } = require('../services/mandateService');
    // Give the event loop a tick because webhook handler performs async operations after responding
    await new Promise(r => setTimeout(r, 50));
    expect(upsertMandateFromWebhook).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ status: 'ACTIVE' }));
  });
});
