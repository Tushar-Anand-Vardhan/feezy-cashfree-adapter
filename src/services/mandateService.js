// src/services/mandateService.js
const { db, FieldValue } = require('../firebaseClient');
const { uuid } = require('../utils/id');

async function persistMandateRecord({ localId, merchantSubId, cfSubId, cfResp, merchantId, userId, enrollmentId, status }) {
  const docId = merchantSubId || cfSubId || localId || (`sub_${uuid()}`);
  const data = {
    local_id: localId || null,
    subscription_id: merchantSubId || null,
    cf_subscription_id: cfSubId || null,
    cf_response: cfResp || null,
    merchantId: merchantId || null,
    userId: userId || null,
    enrollmentId: enrollmentId || null,
    status: status || null,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp()
  };
  await db.collection('mandates').doc(docId).set(data, { merge: true });
  return docId;
}

async function upsertMandateFromWebhook(subId, updates = {}) {
  if (!subId) throw new Error('subId required');
  const col = db.collection('mandates');

  const directRef = col.doc(subId);
  const directSnap = await directRef.get();
  if (directSnap.exists) {
    await directRef.set({ ...updates, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return directRef.id;
  }

  const q = await col.where('subscription_id', '==', subId).limit(1).get();
  if (!q.empty) {
    await q.docs[0].ref.set({ ...updates, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return q.docs[0].id;
  }

  const q2 = await col.where('cf_subscription_id', '==', subId).limit(1).get();
  if (!q2.empty) {
    await q2.docs[0].ref.set({ ...updates, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return q2.docs[0].id;
  }

  await col.doc(subId).set({ subscription_id: subId, ...updates, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
  return subId;
}

module.exports = { persistMandateRecord, upsertMandateFromWebhook };
