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
      enrollment_details = {},
      return_url,
      plan_id
    } = req.body;

    // ---- Required validations (aligned with Cashfree spec) ----
    if (!merchantId || !userId || !enrollmentId || (!amount && !plan_id)) {
      return res.status(400).json({ error: 'missing required params' });
    }

    if (!enrollment_details.enrollment_email || !enrollment_details.enrollment_phone) {
      return res.status(400).json({
        error: 'enrollment_email and enrollment_phone are required'
      });
    }

    const localId = subLocalId();

    // ---- Build Cashfree payload (SPEC COMPLIANT) ----
    const payload = {
      subscription_id: localId,
      enrollment_details,
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

// POST /mandate/create-and-auth
router.post('/create-and-auth', verifyFirebaseToken, async (req, res) => {
  try {
    const {
      userId,
      merchantId,
      enrollmentId,
      amount,
      intervalType = 'MONTH',
      interval = 1,
      enrollment_details = {},
      return_url
    } = req.body;

    // ---- Basic validations ----
    if (!merchantId || !userId || !enrollmentId || !amount) {
      return res.status(400).json({ error: 'missing required params' });
    }

    if (!enrollment_details.enrollment_email || !enrollment_details.enrollment_phone) {
      return res.status(400).json({
        error: 'enrollment_email and enrollment_phone are required'
      });
    }

    const localId = subLocalId();

    // ---- STEP 1: Create Subscription ----
    const subscriptionPayload = {
      subscription_id: localId,
      enrollment_details,
      authorization_details: {
        authorization_amount: 0,
        authorization_amount_refund: false,
        payment_methods: ['upi']
      },
      subscription_meta: {
        return_url: return_url || ''
      },
      plan_details: {
        plan_type: 'PERIODIC',
        plan_amount: amount,
        plan_currency: 'INR',
        plan_intervals: interval,
        plan_interval_type: intervalType
      }
    };

    const requestId = uuid();

    const subResp = await createCashfreeSubscription(
      merchantId,
      subscriptionPayload,
      requestId
    );

    const subData = subResp?.data || subResp || {};
    const subscriptionId = subData.subscription_id;
    const cfSubscriptionId = subData.cf_subscription_id || null;
    const sessionId = subData.subscription_session_id;

    if (!subscriptionId || !sessionId) {
      throw new Error('Failed to create subscription session');
    }

    // Persist mandate immediately
    const mandateDocId = await persistMandateRecord({
      localId,
      merchantSubId: subscriptionId,
      cfSubId: cfSubscriptionId,
      merchantId,
      userId,
      enrollmentId,
      status: subData.subscription_status || 'INITIALIZED',
      cfResp: subResp
    });

    // ---- STEP 2: Create AUTH payment (Raise Auth) ----
    const axios = require('axios');
    const { PARTNER_KEY, API_VERSION } = require('../config');

    const authPaymentPayload = {
      subscription_id: subscriptionId,
      subscription_session_id: sessionId,
      payment_id: `AUTH_${uuid()}`,
      payment_type: 'AUTH',
      payment_method: {
        upi: {
          channel: 'link'
        }
      }
    };

    const headers = {
      'x-api-version': API_VERSION || '2025-01-01',
      'x-idempotency-key': uuid(),
      'x-partner-apikey': PARTNER_KEY,
      'x-partner-merchantid': merchantId,
      'Content-Type': 'application/json'
    };

    const payResp = await axios.post(
      `${process.env.PG_BASE || 'https://sandbox.cashfree.com/pg'}/subscriptions/pay`,
      authPaymentPayload,
      { headers }
    );

    const payData = payResp.data || {};

    // ---- Extract hosted checkout URL (THIS is what goes on WhatsApp) ----
    const authUrl =
      payData?.data?.url ||
      'https://payments.cashfree.com/subscriptions/checkout/timer';

    await logEvent('cashfree.mandate.auth_created', {
      mandateDocId,
      subscriptionId,
      merchantId,
      payment_id: authPaymentPayload.payment_id
    });

    // ---- Final clean response ----
    return res.json({
      ok: true,
      subscription_id: subscriptionId,
      cf_subscription_id: cfSubscriptionId,
      auth_url: authUrl,
      payment_status: payData.payment_status || 'PENDING'
    });
  } catch (err) {
    console.error('/mandate/create-and-auth error', err);
    return res.status(err.status || 500).json({
      error: err.message || String(err)
    });
  }
});

module.exports = router;
