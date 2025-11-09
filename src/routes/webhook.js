// src/routes/webhook.js
const express = require('express');
const router = express.Router();
const { verifyCashfreeSignature } = require('../cashfree/signature');
const { db } = require('../firebaseClient');
const { upsertMandateFromWebhook } = require('../services/mandateService');
const { logEvent } = require('../services/eventService');

router.post('/', async (req, res) => {
  // respond fast
  res.status(200).send('ok');

  try {
    const ok = verifyCashfreeSignature({ headers: req.headers, rawBody: req.rawBody });
    if (!ok) {
      console.warn('Invalid CF webhook signature');
      await logEvent('cashfree.webhook.invalid_signature', { headers: req.headers, raw: req.rawBody });
      return;
    }

    const payload = req.body || {};
    await logEvent(`cashfree.webhook.${payload?.type || 'unknown'}`, { payload, headers: { 'x-webhook-timestamp': req.get('x-webhook-timestamp'), 'x-webhook-signature': req.get('x-webhook-signature') } });

    if (payload.type && payload.type.startsWith('SUBS')) {
      const subId = payload?.data?.subscription_id || payload?.data?.subscriptionId || payload?.data?.subscription?.id || payload?.data?.cf_subscription_id || null;
      const status = payload?.data?.status || payload?.data?.subscription_status || null;
      if (subId) {
        try {
          await upsertMandateFromWebhook(subId, { status, lastWebhook: payload });
        } catch (e) {
          console.error('upsertMandateFromWebhook error', e);
          await logEvent('cashfree.webhook.upsert_error', { error: String(e), subId, payload });
        }
      }

      if (payload?.data?.payment_id || payload?.data?.cf_payment_id || payload?.data?.amount) {
        const paymentDoc = { source: 'cashfree', raw: payload.data, createdAt: new Date() };
        await db.collection('payments').add(paymentDoc);
      }
    }

    if (payload.type === 'PAYMENT_SUCCESS' || payload.event === 'PAYMENT_SUCCESS') {
      const p = payload?.data || payload;
      await db.collection('payments').add({ source: 'cashfree', status: 'SUCCESS', amount: p?.amount, cf_payment_id: p?.payment_id || p?.cf_payment_id, raw: p, createdAt: new Date() });
    } else if (payload.type === 'PAYMENT_FAILED' || payload.event === 'PAYMENT_FAILED') {
      const p = payload?.data || payload;
      await db.collection('payments').add({ source: 'cashfree', status: 'FAILED', amount: p?.amount, cf_payment_id: p?.payment_id || null, raw: p, createdAt: new Date() });
    }
  } catch (e) {
    console.error('Error processing webhook', e);
    await logEvent('cashfree.webhook.processing_error', { error: String(e), raw: req.rawBody });
  }
});

module.exports = router;
