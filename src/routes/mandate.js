const express = require('express');
const router = express.Router();
const axios = require('axios');
const { FieldValue, db } = require('../firebaseClient');

const { verifyFirebaseToken } = require('../middleware/auth');
const { createCashfreeSubscription } = require('../cashfree/subscriptionService');
const { PARTNER_KEY } = require('../config');

const PG_BASE = process.env.PG_BASE || 'https://sandbox.cashfree.com/pg';

/**
 * ------------------------------------------------
 * POST /mandate/create
 * Creates subscription container ONLY
 * ------------------------------------------------
 */
router.post('/create', verifyFirebaseToken, async (req, res) => {
  try {
    const {
      enrollmentId,
      customer,
      plan,
      subscription_first_charge_time,
      subscription_expiry_time,
      return_url
    } = req.body;

    console.log("hello",req);
    const merchantId = req.user.merchant_id;

    // -------------------------
    // Hard validations
    // -------------------------
    if (!enrollmentId) {
      return res.status(400).json({ error: 'enrollmentId is required' });
    }

    if (!merchantId) {
      return res.status(403).json({ error: 'merchant not authorized' });
    }

    if (!customer?.name || !customer?.email || !customer?.phone) {
      return res.status(400).json({ error: 'customer name, email, phone required' });
    }

    if (!plan?.plan_type || !plan?.plan_amount) {
      return res.status(400).json({ error: 'plan_type and plan_amount required' });
    }

    if (!subscription_first_charge_time) {
      return res.status(400).json({
        error: 'subscription_first_charge_time is required'
      });
    }

    const mandateId = `mandate_${enrollmentId}`;
    const mandateRef = db.collection('mandates').doc(mandateId);
    const existingSnap = await mandateRef.get();

    // -------------------------
    // Issue #2: Mandate existence guard
    // -------------------------
    if (existingSnap.exists && existingSnap.data().cf_subscription_id) {
      return res.status(409).json({
        error: 'Mandate already exists'
      });
    }

    // -------------------------
    // Cashfree payload
    // -------------------------
    const payload = {
      subscription_id: mandateId,

      customer_details: {
        customer_name: customer.name,
        customer_email: customer.email,
        customer_phone: customer.phone
      },

      plan_details: {
        plan_type: plan.plan_type,
        plan_currency: 'INR',
        plan_amount: plan.plan_amount,
        plan_intervals: plan.plan_interval ?? 1,
        plan_interval_type: plan.plan_interval_type
      },

      authorization_details: {
        authorization_amount: 0,
        authorization_amount_refund: false,
        payment_methods: ['upi']
      },

      subscription_meta: {
        return_url
      },

      subscription_expiry_time,
      subscription_first_charge_time
    };

    // -------------------------
    // Call Cashfree
    // -------------------------
    const data = await createCashfreeSubscription(
      merchantId,
      payload,
      mandateId // idempotency key
    );

    // -------------------------
    // Issue #5: created_at only once
    // -------------------------
    const baseUpdate = {
      mandate_id: mandateId,
      enrollment_id: enrollmentId,
      merchant_id: merchantId,

      cf_subscription_id: data.cf_subscription_id,
      subscription_session_id: data.subscription_session_id,

      subscription_status: data.subscription_status,
      next_schedule_date: data.next_schedule_date || null,
      subscription_first_charge_time: data.subscription_first_charge_time || null,

      raw_cf_response: data,
      updated_at: FieldValue.serverTimestamp()
    };

    if (!existingSnap.exists) {
      baseUpdate.created_at = FieldValue.serverTimestamp();
    }

    await mandateRef.set(baseUpdate, { merge: true });

    // -------------------------
    // API response
    // -------------------------
    return res.json({
      mandate_id: mandateId,
      cf_subscription_id: data.cf_subscription_id,
      subscription_session_id: data.subscription_session_id,
      subscription_status: data.subscription_status,
      next_schedule_date: data.next_schedule_date,
      subscription_first_charge_time: data.subscription_first_charge_time
    });

  } catch (err) {
    console.error('Create Subscription Error:', err?.response?.data || err);
    return res.status(500).json({
      error: 'Failed to create subscription',
      details: err?.response?.data || err.message
    });
  }
});

/**
 * ------------------------------------------------
 * POST /mandate/auth
 * Creates AUTH (UPI Autopay approval)
 * ------------------------------------------------
 */
router.post('/auth', verifyFirebaseToken, async (req, res) => {
  try {
    const { enrollmentId, payment_method } = req.body;
    const merchantId = req.user.merchant_id;

    if (!enrollmentId) {
      return res.status(400).json({ error: 'enrollmentId is required' });
    }

    const mandateId = `mandate_${enrollmentId}`;
    const mandateRef = db.collection('mandates').doc(mandateId);
    const mandateSnap = await mandateRef.get();

    if (!mandateSnap.exists) {
      return res.status(404).json({ error: 'mandate not found' });
    }

    const mandate = mandateSnap.data();

    // -------------------------
    // Tenant safety
    // -------------------------
    if (mandate.merchant_id !== merchantId) {
      return res.status(403).json({ error: 'unauthorized mandate access' });
    }

    // -------------------------
    // Issue #4 guard (strengthened)
    // -------------------------
    if (
      mandate.payment_status === 'SUCCESS' ||
      mandate.subscription_status === 'ACTIVE'
    ) {
      return res.status(409).json({
        error: 'Mandate already authorized'
      });
    }

    if (!mandate.subscription_session_id) {
      return res.status(400).json({
        error: 'subscription session not initialized'
      });
    }

    if (!mandate.subscription_first_charge_time) {
      return res.status(400).json({
        error: 'subscription_first_charge_time missing for auth'
      });
    }

    const authPaymentId = `auth_${enrollmentId}`;

    // -------------------------
    // Cashfree payload
    // -------------------------
    const payload = {
      subscription_id: mandate.mandate_id,
      subscription_session_id: mandate.subscription_session_id,
      payment_id: authPaymentId,
      payment_type: 'AUTH',
      payment_schedule_date: mandate.subscription_first_charge_time,
      payment_method: payment_method || {
        upi: { channel: 'link' }
      }
    };

    const headers = {
      'x-api-version': '2025-01-01',
      'x-partner-apikey': PARTNER_KEY,
      'x-partner-merchantid': merchantId,
      'x-idempotency-key': authPaymentId,
      'Content-Type': 'application/json'
    };

    // -------------------------
    // Call Cashfree
    // -------------------------
    const cfResp = await axios.post(
      `${PG_BASE}/subscriptions/pay`,
      payload,
      { headers }
    );

    const data = cfResp.data;

    // -------------------------
    // Issue #6: single payload storage
    // -------------------------
    await mandateRef.set({
      auth_payment_id: authPaymentId,
      cf_payment_id: data.cf_payment_id || null,
      payment_status: data.payment_status || 'PENDING',
      payment_type: 'AUTH',
      payment_method: data.payment_method || 'upi',
      payment_channel: data.channel || null,
      payment_payload: data, // single authoritative payment payload
      failure_reason: data.failure_details?.failure_reason || null,
      updated_at: FieldValue.serverTimestamp()
    }, { merge: true });

    // -------------------------
    // API response
    // -------------------------
    return res.json({
      payment_id: authPaymentId,
      cf_payment_id: data.cf_payment_id,
      payment_status: data.payment_status,
      action: data.action,
      channel: data.channel,
      auth_data: data.data
    });

  } catch (err) {
    console.error('Create Auth Error:', err?.response?.data || err);

    return res.status(500).json({
      error: 'Failed to create auth',
      details: err?.response?.data || err.message
    });
  }
});

module.exports = router;
