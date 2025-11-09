// src/__tests__/mandateService.test.js
// Mock firebaseClient module
jest.mock('../firebaseClient', () => {
    // in-memory simple collection simulation
    const store = {};
    return {
      db: {
        collection: (name) => {
          return {
            doc: (id) => {
              return {
                id,
                set: jest.fn(async (data, opts) => {
                  store[`${name}/${id}`] = { ...(store[`${name}/${id}`] || {}), ...data };
                  return;
                }),
                get: jest.fn(async () => {
                  const exists = !!store[`${name}/${id}`];
                  return { exists, id, data: () => store[`${name}/${id}`] };
                }),
                ref: {
                  set: jest.fn()
                }
              };
            },
            where: (field, op, value) => {
              // naive impl for tests: iterate store and return matches
              return {
                limit: () => ({ get: async () => {
                  const docs = [];
                  Object.keys(store).forEach(k => {
                    if (k.startsWith(`${name}/`)) {
                      const doc = store[k];
                      if (doc && doc[field] === value) {
                        docs.push({ id: k.split('/')[1], ref: { set: jest.fn(async (d)=> store[k] = {...store[k], ...d}) }, data: () => doc });
                      }
                    }
                  });
                  return { empty: docs.length === 0, docs };
                }})
              };
            },
            add: jest.fn(async (d) => { const id = 'evt_' + Math.random().toString(36).slice(2,8); store[`${name}/${id}`] = d; return { id }; })
          };
        },
      },
      FieldValue: {
        serverTimestamp: () => new Date()
      }
    };
  });
  
  const { persistMandateRecord, upsertMandateFromWebhook } = require('../services/mandateService');
  
  describe('mandateService', () => {
    test('persistMandateRecord creates a doc and returns id', async () => {
      const docId = await persistMandateRecord({
        localId: 'local_1', merchantSubId: 'ms_1', cfSubId: 'cf_1', cfResp: { any: true }, merchantId: 'm', userId: 'u', enrollmentId: 'e', status: 'INIT'
      });
      expect(docId).toBe('ms_1');
    });
  
    test('upsertMandateFromWebhook updates existing doc by docId', async () => {
      // create a doc first
      const first = await persistMandateRecord({ localId: 'local_2', merchantSubId: 'ms_2', cfResp: {} });
      // now upsert by subId
      const id = await upsertMandateFromWebhook('ms_2', { status: 'UPDATED' });
      expect(id).toBe('ms_2');
    });
  
    test('upsertMandateFromWebhook creates doc if not found', async () => {
      const id = await upsertMandateFromWebhook('nonexistent_sub', { status: 'NEW' });
      expect(id).toBe('nonexistent_sub');
    });
  });
  