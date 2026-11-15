import { initializeApp } from "https://www.gstatic.com/firebasejs/13.3.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/13.3.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/13.3.0/firebase-firestore.js";

// Public web config. Safe to ship: access is controlled by Firestore rules, not by hiding this.
const firebaseConfig = {
  apiKey: "AIzaSyAW1QoZGKDUgBYL4rkgjqxTLC66bHRyYfU",
  authDomain: "betterhub-c69b8.firebaseapp.com",
  projectId: "betterhub-c69b8",
  storageBucket: "betterhub-c69b8.firebasestorage.app",
  messagingSenderId: "852351882076",
  appId: "1:852351882076:web:7ad526c1c532509f5ee799"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
