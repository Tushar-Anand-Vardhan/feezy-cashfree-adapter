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
    const {
      userId,
      merchantId,
      enrollmentId,
      amount,
      intervalType = 'MONTH',
      interval = 1,
      customer_details = {},
      return_url,
      plan_id
    } = req.body;

    // ---- Required validations (aligned with Cashfree spec) ----
    if (!merchantId || !userId || !enrollmentId || (!amount && !plan_id)) {
      return res.status(400).json({ error: 'missing required params' });
    }

    if (!customer_details.customer_email || !customer_details.customer_phone) {
      return res.status(400).json({
        error: 'customer_email and customer_phone are required'
      });
    }

    const localId = subLocalId();

    // ---- Build Cashfree payload (SPEC COMPLIANT) ----
    const payload = {
      subscription_id: localId,
      customer_details,
      authorization_details: {
        authorization_amount: 0,
        authorization_amount_refund: false,
        payment_methods: ['upi']
      },
      subscription_meta: {
        return_url: return_url || ''
      }
    };

    // Plan handling (FIXED)
    if (plan_id) {
      payload.plan_details = {
        plan_id
      };
    } else {
      payload.plan_details = {
        plan_type: 'PERIODIC',
        plan_amount: amount,
        plan_currency: 'INR',
        plan_intervals: interval,
        plan_interval_type: intervalType
      };
    }

    // ---- Call Cashfree ----
    const requestId = uuid();
    const cfResp = await createCashfreeSubscription(
      merchantId,
      payload,
      requestId
    );

    // ---- Normalize Cashfree response ----
    const data = cfResp?.data || cfResp || {};
    const merchantSubId = data.subscription_id || localId;
    const cfSubId = data.cf_subscription_id || null;
    const status = data.subscription_status || 'INITIALIZED';
    const sessionId = data.subscription_session_id || null;

    // ---- Persist mandate ----
    const docId = await persistMandateRecord({
      localId,
      merchantSubId,
      cfSubId,
      merchantId,
      userId,
      enrollmentId,
      status,
      cfResp
    });

    await logEvent('cashfree.mandate.created', {
      subscriptionId: docId,
      merchantId,
      userId,
      status
    });

    // ---- Clean response to frontend ----
    return res.json({
      ok: true,
      subscription_id: merchantSubId,
      cf_subscription_id: cfSubId,
      subscription_session_id: sessionId,
      status
    });
  } catch (err) {
    console.error('/mandate/create error', err);
    return res.status(err.status || 500).json({
      error: err.message || err.body || String(err)
    });
  }
});

// POST /mandate/:subscriptionId/manage
router.post('/:subscriptionId/manage', verifyFirebaseToken, async (req, res) => {
  try {
    const { subscriptionId } = req.params;
    const { merchantId, action } = req.body;

    if (!merchantId || !action) {
      return res.status(400).json({
        error: 'merchantId and action required'
      });
    }

    const axios = require('axios');
    const { PARTNER_KEY, API_VERSION } = require('../config');

    const headers = {
      'x-api-version': API_VERSION,
      'x-partner-apikey': PARTNER_KEY,
      'x-partner-merchantid': merchantId,
      'Content-Type': 'application/json'
    };

    const resp = await axios.post(
      `${process.env.PG_BASE || 'https://sandbox.cashfree.com/pg'}/subscriptions/${subscriptionId}/manage`,
      { action },
      { headers }
    );

    const cfResp = resp.data;
    const statusVal = action === 'CANCEL' ? 'CANCELLED' : action;

    const { db } = require('../firebaseClient');

    // ---- Update mandate record (existing-safe logic) ----
    const direct = await db.collection('mandates').doc(subscriptionId).get();
    if (direct.exists) {
      await direct.ref.set(
        { status: statusVal, lastCfResponse: cfResp, updatedAt: new Date() },
        { merge: true }
      );
    } else {
      const q = await db
        .collection('mandates')
        .where('subscription_id', '==', subscriptionId)
        .limit(1)
        .get();

      if (!q.empty) {
        await q.docs[0].ref.set(
          { status: statusVal, lastCfResponse: cfResp, updatedAt: new Date() },
          { merge: true }
        );
      } else {
        const q2 = await db
          .collection('mandates')
          .where('cf_subscription_id', '==', subscriptionId)
          .limit(1)
          .get();

        if (!q2.empty) {
          await q2.docs[0].ref.set(
            { status: statusVal, lastCfResponse: cfResp, updatedAt: new Date() },
            { merge: true }
          );
        } else {
          await db.collection('mandates').doc(subscriptionId).set({
            subscription_id: subscriptionId,
            status: statusVal,
            lastCfResponse: cfResp,
            createdAt: new Date(),
            updatedAt: new Date()
          });
        }
      }
    }

    await logEvent('cashfree.mandate.manage', {
      subscriptionId,
      merchantId,
      action
    });

    return res.json({ ok: true, subscriptionId, status: statusVal });
  } catch (err) {
    console.error('/mandate/manage error', err);
    return res.status(err.status || 500).json({
      error: err.message || String(err)
    });
  }
});

module.exports = router;
