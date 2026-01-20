const { db, FieldValue } = require('../firebaseClient');

async function persistMandate({
  subscription_id,
  userId,
  subscription_status,
  cf_subscription_id,
  subscription_session_id,
  raw_cf_response
}) {
  await db.collection('mandates').doc(subscription_id).set({
    subscription_id,
    userId,
    subscription_status,
    auth_status: 'NOT_STARTED',
    last_payment_status: null,
    next_schedule_date: null,
    cf_subscription_id,
    subscription_session_id,
    raw_cf_response,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
}

async function upsertMandateFromWebhook(subscription_id, updates) {
  if (!subscription_id) return;
  await db.collection('mandates').doc(subscription_id).set({
    ...updates,
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
}

module.exports = {
  persistMandate,
  upsertMandateFromWebhook
};
