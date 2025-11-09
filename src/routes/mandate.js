// src/routes/mandate.js
const express = require('express');
const router = express.Router();
const { verifyFirebaseToken } = require('../middleware/auth');
const { createCashfreeSubscription } = require('../cashfree/subscriptionService');
const { persistMandateRecord } = require('../services/mandateService');
const { uuid, subLocalId } = require('../utils/id');
const { logEvent } = require('../services/eventService');

// POST /mandate/create
router.post('/create', verifyFirebaseToken, async (req, res) => {
  try {
    const { userId, merchantId, enrollmentId, amount, intervalType = 'MONTH', interval = 1, customer_details = {}, return_url, plan_id } = req.body;
    if (!merchantId || !userId || !enrollmentId || (!amount && !plan_id)) return res.status(400).json({ error: 'missing required params' });

    const localId = subLocalId();
    const payload = {
      subscription_id: localId,
      customer_details,
      authorization_details: { payment_methods: ['UPI'] },
      subscription_meta: { return_url: return_url || '' }
    };

    if (plan_id) payload.plan_id = plan_id;
    else payload.plan_info = { plan_amount: amount, plan_interval_type: intervalType, plan_intervals: interval };

    const cfResp = await createCashfreeSubscription(merchantId, payload, uuid());
    const merchantSubId = cfResp?.data?.subscription_id || cfResp?.subscription_id || localId;
    const cfSubId = cfResp?.data?.cf_subscription_id || cfResp?.cf_subscription_id || null;
    const status = cfResp?.data?.subscription_status || cfResp?.subscription_status || 'INITIALIZED';

    const docId = await persistMandateRecord({ localId, merchantSubId, cfSubId, cfResp, merchantId, userId, enrollmentId, status });

    await logEvent('cashfree.mandate.created', { subscriptionId: docId, merchantId, userId, cfResp });

    return res.json({ ok: true, subscription_id: merchantSubId, cf_subscription_id: cfSubId, local_id: localId, cfResp });
  } catch (err) {
    console.error('/mandate/create error', err);
    return res.status(err.status || 500).json({ error: err.message || err.body || String(err) });
  }
});

// POST /mandate/:subscriptionId/manage
router.post('/:subscriptionId/manage', verifyFirebaseToken, async (req, res) => {
  try {
    const { subscriptionId } = req.params;
    const { merchantId, action } = req.body;
    if (!merchantId || !action) return res.status(400).json({ error: 'merchantId and action required' });

    const url = `${process.env.CF_PG_BASE || ''}/subscriptions/${subscriptionId}/manage`; // we'll call external straight in index if needed
    // For parity with your existing code, call Cashfree directly with axios
    const axios = require('axios');
    const { PARTNER_KEY, API_VERSION } = require('../config');
    const headers = { 'x-api-version': API_VERSION, 'x-partner-apikey': PARTNER_KEY, 'x-partner-merchantid': merchantId, 'Content-Type': 'application/json' };
    const resp = await axios.post(`${process.env.PG_BASE || 'https://sandbox.cashfree.com/pg'}/subscriptions/${subscriptionId}/manage`, { action }, { headers });
    const cfResp = resp.data;

    // update Firestore like earlier - simplified
    const targetId = subscriptionId;
    const { db } = require('../firebaseClient');
    const direct = await db.collection('mandates').doc(targetId).get();
    const statusVal = action === 'CANCEL' ? 'CANCELLED' : action;
    if (direct.exists) {
      await direct.ref.set({ status: statusVal, lastCfResponse: cfResp, updatedAt: new Date() }, { merge: true });
    } else {
      const q = await db.collection('mandates').where('subscription_id', '==', targetId).limit(1).get();
      if (!q.empty) {
        await q.docs[0].ref.set({ status: statusVal, lastCfResponse: cfResp, updatedAt: new Date() }, { merge: true });
      } else {
        const q2 = await db.collection('mandates').where('cf_subscription_id', '==', targetId).limit(1).get();
        if (!q2.empty) {
          await q2.docs[0].ref.set({ status: statusVal, lastCfResponse: cfResp, updatedAt: new Date() }, { merge: true });
        } else {
          await db.collection('mandates').doc(targetId).set({ subscription_id: targetId, status: statusVal, lastCfResponse: cfResp, createdAt: new Date(), updatedAt: new Date() });
        }
      }
    }

    await logEvent('cashfree.mandate.manage', { subscriptionId: targetId, merchantId, action, cfResp });

    return res.json({ ok: true, subscriptionId: targetId, cfResp });
  } catch (err) {
    console.error('/mandate/manage error', err);
    return res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

module.exports = router;
