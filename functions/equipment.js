/* ================================================================
   equipment.js — Push notifications for equipment bookings
   ================================================================
   Triggers:
     equipmentBookings/{bookingId}  onCreate  — new booking (manager approval)
     equipmentBookings/{bookingId}  onUpdate  — status changes (confirmed, displaced)
   ================================================================ */

const { onDocumentCreated, onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { getFirestore } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');
const { sendToUsers } = require('./helpers/notify');

const APP_KEY = 'equipment';

/* ---------- Booking Created ---------- */

const onEquipmentBookingCreate = onDocumentCreated('equipmentBookings/{bookingId}', async (event) => {
  const snap = event.data;
  if (!snap) return;

  const booking = snap.data();
  const db = getFirestore();
  const messaging = getMessaging();

  // If booking needs approval, notify equipment managers
  if (booking.status === 'pending-approval' && booking.equipmentId) {
    const equipDoc = await db.collection('equipment').doc(booking.equipmentId).get();
    if (equipDoc.exists) {
      const managers = equipDoc.data().managers || [];
      if (managers.length > 0) {
        await sendToUsers(db, messaging, managers, {
          title: 'Booking Request',
          body: `${booking.userName} requests ${booking.equipmentName} on ${booking.date}`,
          url: '/#/apps/equipment',
          tag: `equip-approve-${event.params.bookingId}`,
        }, APP_KEY);
      }
    }
  }
});

/* ---------- Booking Updated ---------- */

const onEquipmentBookingUpdate = onDocumentUpdated('equipmentBookings/{bookingId}', async (event) => {
  const beforeData = event.data.before.data();
  const afterData = event.data.after.data();
  if (!beforeData || !afterData) return;

  // Only act on status changes
  if (beforeData.status === afterData.status) return;

  const db = getFirestore();
  const messaging = getMessaging();
  const bookingId = event.params.bookingId;

  // Booking was displaced — needs rebooking
  if (afterData.status === 'needs-rebooking') {
    await sendToUsers(db, messaging, [afterData.uid], {
      title: 'Booking Displaced',
      body: `Your ${afterData.equipmentName} booking on ${afterData.date} needs rebooking`,
      url: '/#/apps/equipment',
      tag: `equip-displaced-${bookingId}`,
    }, APP_KEY);
  }

  // Booking confirmed (was pending approval)
  if (afterData.status === 'confirmed' && beforeData.status === 'pending-approval') {
    await sendToUsers(db, messaging, [afterData.uid], {
      title: 'Booking Confirmed',
      body: `Your ${afterData.equipmentName} booking on ${afterData.date} is confirmed`,
      url: '/#/apps/equipment',
      tag: `equip-confirmed-${bookingId}`,
    }, APP_KEY);
  }
});

module.exports = { onEquipmentBookingCreate, onEquipmentBookingUpdate };
