// src/__tests__/routes.onboard.test.js
const request = require('supertest');
const express = require('express');

jest.mock('../../cashfree/subscriptionService', () => ({
  cashfreePartnerPost: jest.fn(async (path, body) => ({ data: { merchant_id: 'm_1', onboarding_status: 'CREATED' } }))
}));

// Provide a lightweight firebaseClient mock for users collection writes
jest.mock('../../firebaseClient', () => {
  return {
    db: {
      collection: () => ({
        doc: (id) => ({
          set: jest.fn(async ()=>{}),
          get: jest.fn(async ()=>({ exists: false, data: ()=>({}) }))
        }),
        add: jest.fn(async ()=>({ id: 'evt1' }))
      })
    },
    FieldValue: {
      serverTimestamp: () => new Date()
    }
  };
});

// Instead of relying on firebase timestamps via eventService, mock eventService.logEvent as no-op
jest.mock('../../services/eventService', () => ({ logEvent: jest.fn(async ()=>{}) }));

jest.mock('../../middleware/auth', () => ({
  verifyFirebaseToken: (req, res, next) => { req.user = { uid: 'u1' }; return next(); }
}));

const onboardRoutes = require('../../routes/onboard');

describe('onboard routes', () => {
  let app;
  beforeAll(() => {
    app = express();
    app.use(express.json({ verify: (req,res,buf)=> { req.rawBody = buf ? buf.toString() : ''; } }));
    app.use('/onboard', onboardRoutes);
  });

  beforeEach(() => jest.clearAllMocks());

  test('POST /onboard creates merchant and writes users doc', async () => {
    const res = await request(app).post('/onboard').send({ userId: 'user1', merchantInfo: { name: 'x' } });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.cfResp).toBeDefined();
  });

  test('POST /onboard/link returns onboarding link', async () => {
    const res = await request(app).post('/onboard/link').send({ merchantId: 'm_1' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
