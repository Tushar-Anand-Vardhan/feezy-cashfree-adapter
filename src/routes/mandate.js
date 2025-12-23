const express = require('express');
const router = express.Router();

const { verifyFirebaseToken } = require('../middleware/auth');
const { createCashfreeSubscription } = require('../cashfree/subscriptionService');
const { persistMandateRecord } = require('../services/mandateService');
const { uuid, subLocalId } = require('../utils/id');
const { logEvent } = require('../services/eventService');
const axios = require('axios');
const { PARTNER_KEY, API_VERSION } = require('../config');

/**
 * ----------------------------------------
 * POST /mandate/create
 * Creates ONLY the subscription (mandate)
 * ----------------------------------------
 */
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

    // ---- Strict validations ----
    if (!merchantId || !userId || !enrollmentId) {
      return res.status(400).json({ error: 'merchantId, userId, enrollmentId required' });
    }

    if (!plan_id && (!amount || amount <= 0)) {
      return res.status(400).json({ error: 'amount must be > 0' });
    }

    if (!customer_details.customer_phone || !customer_details.customer_email) {
      return res.status(400).json({
        error: 'customer_email and customer_phone are required'
      });
    }

    const localId = subLocalId();

    // ---- Build Cashfree-compliant payload ----
    const payload = {
      subscription_id: localId,
      customer_details: {
        customer_name: customer_details.customer_name || 'Customer',
        customer_email: customer_details.customer_email,
        customer_phone: customer_details.customer_phone
      },
      authorization_details: {
        authorization_amount: 0,
        authorization_amount_refund: false,
        payment_methods: ['upi']
      },
      subscription_meta: {
        return_url: return_url || ''
      }
    };

    if (plan_id) {
      payload.plan_details = { plan_id };
    } else {
      payload.plan_details = {
        plan_type: 'PERIODIC',
        plan_amount: amount,
        plan_currency: 'INR',
        plan_intervals: interval || 1,
        plan_interval_type: intervalType.toUpperCase()
      };
    }

    const cfResp = await createCashfreeSubscription(
      merchantId,
      payload,
      uuid()
    );

    const data = cfResp?.data || cfResp;
    const subscriptionId = data.subscription_id;
    const cfSubscriptionId = data.cf_subscription_id || null;
    const status = data.subscription_status || 'INITIALIZED';
    const sessionId = data.subscription_session_id || null;

    await persistMandateRecord({
      localId,
      merchantSubId: subscriptionId,
      cfSubId: cfSubscriptionId,
      merchantId,
      userId,
      enrollmentId,
      status,
      cfResp
    });

    await logEvent('cashfree.mandate.created', {
      subscriptionId,
      merchantId,
      userId
    });

    return res.json({
      ok: true,
      subscription_id: subscriptionId,
      cf_subscription_id: cfSubscriptionId,
      subscription_session_id: sessionId,
      status
    });
  } catch (err) {
    console.error('/mandate/create error', err);
    return res.status(err.status || 500).json({
      error: err.message || String(err)
    });
  }
});

/**
 * ----------------------------------------
 * POST /mandate/create-and-auth
 * Creates mandate + generates UPI link
 * ----------------------------------------
 */
router.post('/create-and-auth', verifyFirebaseToken, async (req, res) => {
  try {
    const {
      userId,
      merchantId,
      enrollmentId,
      amount,
      intervalType = 'MONTH',
      interval = 1,
      customer_details = {},
      return_url
    } = req.body;

    if (!merchantId || !userId || !enrollmentId) {
      return res.status(400).json({ error: 'merchantId, userId, enrollmentId required' });
    }

    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'amount must be > 0' });
    }

    if (!customer_details.customer_email || !customer_details.customer_phone) {
      return res.status(400).json({
        error: 'customer_email and customer_phone required'
      });
    }

    const localId = subLocalId();

    // ---- STEP 1: Create subscription ----
    const subscriptionPayload = {
      subscription_id: localId,
      customer_details: {
        customer_name: customer_details.customer_name || 'Customer',
        customer_email: customer_details.customer_email,
        customer_phone: customer_details.customer_phone
      },
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
        plan_intervals: interval || 1,
        plan_interval_type: intervalType.toUpperCase()
      }
    };

    const subResp = await createCashfreeSubscription(
      merchantId,
      subscriptionPayload,
      uuid()
    );

    const subData = subResp?.data || subResp;
    const subscriptionId = subData.subscription_id;
    const cfSubscriptionId = subData.cf_subscription_id || null;
    const sessionId = subData.subscription_session_id;

    if (!subscriptionId || !sessionId) {
      throw new Error('Subscription session not created');
    }

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

    // ---- STEP 2: Raise AUTH (generate UPI link) ----
    const authPayload = {
      subscription_id: subscriptionId,
      subscription_session_id: sessionId,
      payment_id: `AUTH_${uuid()}`,
      payment_type: 'AUTH',
      payment_method: {
        upi: { channel: 'link' }
      }
    };

    const headers = {
      'x-api-version': API_VERSION || '2025-01-01',
      'x-partner-apikey': PARTNER_KEY,
      'x-partner-merchantid': merchantId,
      'x-idempotency-key': uuid(),
      'Content-Type': 'application/json'
    };

    const payResp = await axios.post(
      `${process.env.PG_BASE || 'https://sandbox.cashfree.com/pg'}/subscriptions/pay`,
      authPayload,
      { headers }
    );

    const payData = payResp.data;

    const authUrl =
      payData?.data?.url ||
      'https://payments.cashfree.com/subscriptions/checkout/timer';

    await logEvent('cashfree.mandate.auth_created', {
      mandateDocId,
      subscriptionId,
      merchantId
    });

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

/**
 * ----------------------------------------
 * POST /mandate/:subscriptionId/manage
 * ----------------------------------------
 */
router.post('/:subscriptionId/manage', verifyFirebaseToken, async (req, res) => {
  try {
    const { subscriptionId } = req.params;
    const { merchantId, action } = req.body;

    if (!merchantId || !action) {
      return res.status(400).json({ error: 'merchantId and action required' });
    }

    const resp = await axios.post(
      `${process.env.PG_BASE || 'https://sandbox.cashfree.com/pg'}/subscriptions/${subscriptionId}/manage`,
      { action },
      {
        headers: {
          'x-api-version': API_VERSION,
          'x-partner-apikey': PARTNER_KEY,
          'x-partner-merchantid': merchantId,
          'Content-Type': 'application/json'
        }
      }
    );

    await logEvent('cashfree.mandate.manage', {
      subscriptionId,
      merchantId,
      action
    });

    return res.json({
      ok: true,
      subscriptionId,
      status: action === 'CANCEL' ? 'CANCELLED' : action
    });
  } catch (err) {
    console.error('/mandate/manage error', err);
    return res.status(err.status || 500).json({
      error: err.message || String(err)
    });
  }
});

module.exports = router;
