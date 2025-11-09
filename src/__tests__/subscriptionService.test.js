// src/__tests__/subscriptionService.test.js

// Mock the local client instance (the axios.create() result)
jest.mock('../cashfree/client', () => {
    return {
      // subscriptionService expects axiosInstance.defaults.headers['x-api-version']
      defaults: {
        headers: {
          'x-api-version': '2023-01-01'
        }
      }
    };
  });
  
  // Also mock axios because createCashfreeSubscription uses axios.post directly (PG_BASE)
  jest.mock('axios');
  const axios = require('axios');
  
  const { createCashfreeSubscription } = require('../cashfree/subscriptionService');
  const { PG_BASE } = require('../config');
  
  describe('createCashfreeSubscription', () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });
  
    test('calls PG_BASE subscriptions endpoint with headers and payload', async () => {
      const fakeResponse = { data: { subscription_id: 'merchant_sub_123', subscription_status: 'INITIALIZED' } };
      axios.post.mockResolvedValueOnce(fakeResponse);
  
      const merchantId = 'merchant_abc';
      const payload = { subscription_id: 'local_sub_1' };
      const idempotencyKey = 'idem_key_1';
  
      const resp = await createCashfreeSubscription(merchantId, payload, idempotencyKey);
  
      expect(axios.post).toHaveBeenCalled();
  
      const expectedUrl = `${PG_BASE}/subscriptions`;
      const [url, body, opts] = axios.post.mock.calls[0];
  
      expect(url).toBe(expectedUrl);
      expect(body).toEqual(payload);
  
      // headers asserted on the third arg (opts.headers)
      expect(opts).toBeDefined();
      expect(opts.headers['x-partner-apikey']).toBeDefined();
      expect(opts.headers['x-partner-merchantid']).toBe(merchantId);
      expect(opts.headers['x-idempotency-key']).toBe(idempotencyKey);
      expect(opts.headers['x-api-version']).toBeDefined();
  
      expect(resp).toEqual(fakeResponse.data);
    });
  
    test('throws if axios rejects', async () => {
      axios.post.mockRejectedValueOnce(new Error('network'));
      await expect(createCashfreeSubscription('m', {}, 'k')).rejects.toThrow();
    });
  });
  