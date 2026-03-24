/* ================================================================
   Firebase Configuration — McGheeLab User System
   ================================================================
   SETUP INSTRUCTIONS:
   1. Go to https://console.firebase.google.com
   2. Select your McGheeLab project
   3. Go to Project Settings > General > Your apps > Web app
   4. Copy the config values below
   5. Enable Authentication > Email/Password in the Firebase console
   6. Create a Firestore database (production mode)
   7. Create a Storage bucket
   8. Deploy firestore.rules and storage.rules from this repo
   ================================================================ */

const firebaseConfig = {
  apiKey:            "AIzaSyAnkKivjCcjAS8_Lp-R2JSIG4wSDSJBFI0",
  authDomain:        "mcgheelab-f56cc.firebaseapp.com",
  projectId:         "mcgheelab-f56cc",
  storageBucket:     "mcgheelab-f56cc.firebasestorage.app",
  messagingSenderId: "665438582202",
  appId:             "1:665438582202:web:57416863d588bcdeff9983",
  measurementId: "G-D8LLB00X9V"
};

window.McgheeLab = window.McgheeLab || {};

try {
  if (typeof firebase !== 'undefined' && firebaseConfig.apiKey !== "YOUR_API_KEY") {
    firebase.initializeApp(firebaseConfig);
    McgheeLab.firebase = firebase;
    McgheeLab.auth    = firebase.auth();
    McgheeLab.db      = firebase.firestore();
    McgheeLab.storage = firebase.storage();
  } else if (typeof firebase === 'undefined') {
    console.warn('[McGheeLab] Firebase SDK not loaded — user system disabled.');
  } else {
    console.warn('[McGheeLab] Firebase not configured — user system disabled.');
    console.warn('[McGheeLab] Edit firebase-config.js with your Firebase project credentials.');
  }
} catch (err) {
  console.warn('[McGheeLab] Firebase init failed:', err.message);
}
