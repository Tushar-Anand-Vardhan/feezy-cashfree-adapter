const express = require('express');
const router = express.Router();
const { FieldValue, db } = require('../firebaseClient');
const { verifyCashfreeSignature } = require('../cashfree/signature');

/**
 * ------------------------------------------------
 * POST /webhooks/subscription
 * Cashfree Subscription Webhooks (2025-01-01)
 * ------------------------------------------------
 *
 * Design principles:
 * - Verify signature BEFORE acknowledging
 * - Idempotent processing (exactly once)
 * - Mandate is source of truth
 * - AUTH ≠ CHARGE
 * - Webhooks mutate state, APIs do not
 */
router.post('/', async (req, res) => {
  try {
    // ------------------------------------------------
    // 1️⃣ Signature verification (MUST come first)
    // ------------------------------------------------
    const isValid = verifyCashfreeSignature({
      headers: req.headers,
      rawBody: req.rawBody
    });

    if (!isValid) {
      console.error('Invalid Cashfree webhook signature');
      return res.status(401).send('invalid signature');
    }

    // ACK only after signature validation
    res.status(200).send('ok');

    const { type, data, event_time } = req.body || {};
    if (!type || !data) return;

    // ------------------------------------------------
    // 2️⃣ Resolve subscription identifiers
    // ------------------------------------------------
    const subscriptionId =
      data.subscription_id ||
      data.subscription_details?.subscription_id;

    const cfSubscriptionId =
      data.cf_subscription_id ||
      data.subscription_details?.cf_subscription_id;

    if (!subscriptionId && !cfSubscriptionId) return;

    // ------------------------------------------------
    // 3️⃣ Webhook idempotency guard
    // ------------------------------------------------
    const eventKey = `${type}_${event_time}_${data.payment_id || 'NA'}`;
    const eventRef = db.collection('webhook_events').doc(eventKey);
    const eventSnap = await eventRef.get();

    if (eventSnap.exists) {
      // Already processed → exit silently
      return;
    }

    // ------------------------------------------------
    // 4️⃣ Locate mandate (cf_subscription_id preferred)
    // ------------------------------------------------
    let mandateSnap = null;

    if (cfSubscriptionId) {
      const q = await db.collection('mandates')
        .where('cf_subscription_id', '==', cfSubscriptionId)
        .limit(1)
        .get();
      if (!q.empty) mandateSnap = q.docs[0];
    }

    if (!mandateSnap && subscriptionId) {
      const ref = db.collection('mandates').doc(subscriptionId);
      const snap = await ref.get();
      if (snap.exists) mandateSnap = snap;
    }

    if (!mandateSnap) {
      console.error('Mandate not found for webhook', {
        type,
        subscriptionId,
        cfSubscriptionId
      });
      return;
    }

    const mandateRef = mandateSnap.ref;
    const mandate = mandateSnap.data();

    // ------------------------------------------------
    // 5️⃣ Helper: safe subscription state transitions
    // ------------------------------------------------
    const isValidTransition = (from, to) => {
      const allowed = {
        INITIALIZED: ['BANK_APPROVAL_PENDING', 'ACTIVE', 'CANCELLED'],
        BANK_APPROVAL_PENDING: ['ACTIVE', 'CANCELLED'],
        ACTIVE: ['ON_HOLD', 'COMPLETED', 'CUSTOMER_CANCELLED', 'EXPIRED'],
        ON_HOLD: ['ACTIVE', 'CANCELLED'],
        COMPLETED: [],
        CANCELLED: [],
        EXPIRED: []
      };
      return (allowed[from] || []).includes(to);
    };

    // ------------------------------------------------
    // 6️⃣ Process webhook by type
    // ------------------------------------------------

    /* ================================
       SUBSCRIPTION STATUS CHANGED
    ================================= */
    if (type === 'SUBSCRIPTION_STATUS_CHANGED') {
      const sd = data.subscription_details || {};
      const newStatus = sd.subscription_status;

      if (
        !mandate.subscription_status ||
        isValidTransition(mandate.subscription_status, newStatus)
      ) {
        await mandateRef.set({
          subscription_status: newStatus,
          next_schedule_date: sd.next_schedule_date || null,
          subscription_expiry_time: sd.subscription_expiry_time || null,
          updated_at: FieldValue.serverTimestamp()
        }, { merge: true });
      }

      // 🔔 Placeholder: notify enrollment
      // notifyEnrollment(mandate.enrollment_id, 'SUBSCRIPTION_STATUS_CHANGED');
    }

    /* ================================
       AUTH STATUS
    ================================= */
    else if (type === 'SUBSCRIPTION_AUTH_STATUS') {
      await mandateRef.set({
        auth_status: data.payment_status,
        auth_payment_id: data.payment_id,
        cf_payment_id: data.cf_payment_id,
        authorization_reference:
          data.authorization_details?.authorization_reference || null,
        updated_at: FieldValue.serverTimestamp()
      }, { merge: true });

      // 🔔 Placeholder: notify enrollment auth result
      // notifyEnrollment(mandate.enrollment_id, 'AUTH_STATUS_UPDATED');
    }

    /* ================================
       PAYMENT NOTIFICATION INITIATED
       (Informational only)
    ================================= */
    else if (type === 'SUBSCRIPTION_PAYMENT_NOTIFICATION_INITIATED') {
      // No state mutation
      // 🔔 Placeholder: notify enrollment payment attempt started
      // notifyEnrollment(mandate.enrollment_id, 'PAYMENT_INITIATED');
    }

    /* ================================
       PAYMENT SUCCESS
    ================================= */
    else if (type === 'SUBSCRIPTION_PAYMENT_SUCCESS') {
      const paymentId = data.payment_id;
      const paymentRef = db.collection('payments').doc(paymentId);
      const paymentSnap = await paymentRef.get();

      // EXACTLY-ONCE financial processing
      if (!paymentSnap.exists || paymentSnap.data().payment_status !== 'SUCCESS') {

        // Store minimal payment record
        await paymentRef.set({
          payment_id: paymentId,
          enrollment_id: mandate.enrollment_id,
          subscription_id: mandate.mandate_id,
          cf_subscription_id: cfSubscriptionId,
          payment_type: data.payment_type,
          payment_status: 'SUCCESS',
          amount: data.payment_amount,
          currency: data.payment_currency,
          payment_date: data.payment_initiated_date,
          created_at: FieldValue.serverTimestamp()
        }, { merge: true });

        // CHARGE → money movement
        if (data.payment_type === 'CHARGE') {
          await db.collection('enrollments')
            .doc(mandate.enrollment_id)
            .set({
              total_paid_amount: FieldValue.increment(data.payment_amount || 0),
              last_payment_date: data.payment_initiated_date,
              updated_at: FieldValue.serverTimestamp()
            }, { merge: true });

          // 📄 Placeholder: send invoice via WhatsApp
          // sendInvoiceWhatsapp(mandate.enrollment_id, paymentId);
        }

        // AUTH → mandate activation handled via status webhook
        await mandateRef.set({
          last_payment_status: 'SUCCESS',
          last_payment_date: data.payment_initiated_date,
          updated_at: FieldValue.serverTimestamp()
        }, { merge: true });
      }

      // 🔔 Placeholder: notify enrollment payment success
      // notifyEnrollment(mandate.enrollment_id, 'PAYMENT_SUCCESS');
    }

    /* ================================
       PAYMENT FAILED / CANCELLED
    ================================= */
    else if (
      type === 'SUBSCRIPTION_PAYMENT_FAILED' ||
      type === 'SUBSCRIPTION_PAYMENT_CANCELLED'
    ) {
      const paymentId = data.payment_id;

      await db.collection('payments').doc(paymentId).set({
        payment_id: paymentId,
        enrollment_id: mandate.enrollment_id,
        subscription_id: mandate.mandate_id,
        payment_status: data.payment_status,
        failure_reason: data.failure_details?.failure_reason || null,
        created_at: FieldValue.serverTimestamp()
      }, { merge: true });

      await mandateRef.set({
        last_payment_status: data.payment_status,
        updated_at: FieldValue.serverTimestamp()
      }, { merge: true });

      // 🔔 Placeholder: notify enrollment failure
      // notifyEnrollment(mandate.enrollment_id, 'PAYMENT_FAILED');
    }

    /* ================================
       REFUND STATUS
    ================================= */
    else if (type === 'SUBSCRIPTION_REFUND_STATUS') {
      await db.collection('refunds').doc(data.refund_id).set({
        refund_id: data.refund_id,
        payment_id: data.payment_id,
        refund_amount: data.refund_amount,
        refund_status: data.refund_status,
        created_at: FieldValue.serverTimestamp()
      }, { merge: true });

      // 🔔 Placeholder: notify enrollment refund
      // notifyEnrollment(mandate.enrollment_id, 'REFUND_UPDATED');
    }

    /* ================================
       CARD EXPIRY REMINDER
    ================================= */
    else if (type === 'SUBSCRIPTION_CARD_EXPIRY_REMINDER') {
      // No mandate mutation
      // 🔔 Placeholder: notify enrollment card expiry
      // notifyEnrollment(mandate.enrollment_id, 'CARD_EXPIRY_REMINDER');
    }

    // ------------------------------------------------
    // 7️⃣ Mark webhook event as processed (LAST STEP)
    // ------------------------------------------------
    await eventRef.set({
      type,
      subscription_id: subscriptionId,
      cf_subscription_id: cfSubscriptionId,
      processed_at: FieldValue.serverTimestamp()
    });

  } catch (err) {
    // Webhook already ACKed — log for manual intervention
    console.error('Webhook processing error:', err);
  }
});

module.exports = router;
