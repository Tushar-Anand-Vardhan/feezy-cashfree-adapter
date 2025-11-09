// src/__tests__/routes.mandate.test.js
const request = require('supertest');
const express = require('express');

// mock createCashfreeSubscription used by /mandate/create
jest.mock('../../cashfree/subscriptionService', () => ({
  createCashfreeSubscription: jest.fn(async (merchantId, payload, idemp) => ({
    data: { subscription_id: payload.subscription_id, cf_subscription_id: 'cf_123', subscription_status: 'INITIALIZED' }
  }))
}));

// mock persistMandateRecord used by /mandate/create
jest.mock('../../services/mandateService', () => ({
  persistMandateRecord: jest.fn(async (obj) => obj.merchantSubId || obj.localId || 'doc_1'),
}));

// mock event logging
jest.mock('../../services/eventService', () => ({ logEvent: jest.fn(async ()=>{}) }));

// mock auth middleware to pass through
jest.mock('../../middleware/auth', () => ({
  verifyFirebaseToken: (req, res, next) => { req.user = { uid: 'user1' }; return next(); }
}));

// Mock axios used in manage endpoint (PG_BASE call)
jest.mock('axios');
const axios = require('axios');

// Mock firebaseClient to avoid real Firestore init
jest.mock('../../firebaseClient', () => {
  // Minimal in-memory doc for the test
  const store = {
    'mandates/someId': { subscription_id: 'someId', status: 'ACTIVE' } // can be used if needed
  };

  return {
    db: {
      collection: (name) => ({
        doc: (id) => ({
          get: jest.fn(async () => {
            // if doc exists in store => return snapshot-like object
            const key = `${name}/${id}`;
            const exists = !!store[key];
            return {
              exists,
              id,
              data: () => store[key] || null,
              ref: {
                set: jest.fn(async (d, opts) => { store[key] = { ...(store[key]||{}), ...d }; return; })
              }
            };
          }),
          set: jest.fn(async (d, opts) => {
            store[`${name}/${id}`] = { ...(store[`${name}/${id}`]||{}), ...d };
            return;
          })
        }),
        where: (field, op, value) => ({
          limit: () => ({
            get: async () => {
              const docs = [];
              Object.keys(store).forEach(k => {
                if (k.startsWith(`${name}/`)) {
                  const doc = store[k];
                  if (doc && doc[field] === value) {
                    docs.push({
                      id: k.split('/')[1],
                      ref: { set: jest.fn(async (d)=> store[k] = {...store[k], ...d}) },
                      data: () => doc
                    });
                  }
                }
              });
              return { empty: docs.length === 0, docs };
            }
          })
        }),
        add: jest.fn(async (d) => { const id = 'evt_' + Math.random().toString(36).slice(2,8); store[`${name}/${id}`] = d; return { id }; })
      })
    },
    FieldValue: {
      serverTimestamp: () => new Date()
    }
  };
});

const mandateRoutes = require('../../routes/mandate');

describe('mandate routes', () => {
  let app;
  beforeAll(() => {
    app = express();
    app.use(express.json({ verify: (req,res,buf)=> { req.rawBody = buf ? buf.toString() : ''; } }));
    app.use('/mandate', mandateRoutes);
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('POST /mandate/create should call CF and persist mandate', async () => {
    const payload = {
      userId: 'user1',
      merchantId: 'm_1',
      enrollmentId: 'en_1',
      amount: 100,
      customer_details: { name: 'abc' }
    };
    const res = await request(app).post('/mandate/create').send(payload);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.subscription_id).toBeDefined();
    expect(res.body.cf_subscription_id).toBeDefined();
  });

  test('POST /mandate/:id/manage should call CF manage and update mandate', async () => {
    // make axios.post return a successful manage response
    axios.post.mockResolvedValueOnce({ data: { success: true } });

    const res = await request(app).post('/mandate/someId/manage').send({ merchantId: 'm_1', action: 'CANCEL' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
