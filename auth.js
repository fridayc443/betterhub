import { auth, db } from "./firebase.js";
import { createUserWithEmailAndPassword, signInWithEmailAndPassword, sendEmailVerification, sendPasswordResetEmail, updateProfile, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/13.3.0/firebase-auth.js";
import { doc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/13.3.0/firebase-firestore.js";

const ERR = {
  "auth/email-already-in-use": "That email already has an account. Log in instead.",
  "auth/invalid-credential": "Wrong email or password.",
  "auth/weak-password": "Use a password of at least 8 characters.",
  "auth/too-many-requests": "Too many attempts. Wait a few minutes and try again.",
  "auth/network-request-failed": "No connection. Check your internet and try again.",
  "auth/invalid-email": "Enter a valid email address."
};
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
function say(f, text, bad) { const m = f.querySelector(".msg"); m.className = "msg" + (bad ? " err" : ""); m.textContent = text; }

const reg = document.querySelector("form[data-kind=register]");
const log = document.querySelector("form[data-kind=login]");

reg.addEventListener("submit", async (e) => {
  e.preventDefault();
  const d = new FormData(reg), name = d.get("name").trim(), email = d.get("email").trim(), pw = d.get("password");
  if (!name) return say(reg, "Enter your full name.", 1);
  if (!EMAIL.test(email)) return say(reg, "Enter a valid email address.", 1);
  if (pw.length < 8) return say(reg, "Use a password of at least 8 characters.", 1);
  const btn = reg.querySelector("button"); btn.disabled = true; say(reg, "Creating your account...");
  try {
    const c = await createUserWithEmailAndPassword(auth, email, pw);
    await updateProfile(c.user, { displayName: name });
    await setDoc(doc(db, "users", c.user.uid), { displayName: name, email, role: "customer", status: "active", createdAt: serverTimestamp() });
    await sendEmailVerification(c.user);
    location.href = "app.html";
  } catch (x) { say(reg, ERR[x.code] || "Something went wrong. Try again.", 1); btn.disabled = false; }
});

log.addEventListener("submit", async (e) => {
  e.preventDefault();
  const d = new FormData(log), email = d.get("email").trim(), pw = d.get("password");
  if (!EMAIL.test(email)) return say(log, "Enter a valid email address.", 1);
  if (!pw) return say(log, "Enter your password.", 1);
  const btn = log.querySelector("button"); btn.disabled = true; say(log, "Logging in...");
  try { await signInWithEmailAndPassword(auth, email, pw); location.href = "app.html"; }
  catch (x) { say(log, ERR[x.code] || "Something went wrong. Try again.", 1); btn.disabled = false; }
});

document.getElementById("forgot").addEventListener("click", async (e) => {
  e.preventDefault();
  const email = new FormData(log).get("email").trim();
  if (!EMAIL.test(email)) return say(log, "Type your email above, then tap Forgot password.", 1);
  try { await sendPasswordResetEmail(auth, email); } catch (x) { if (x.code === "auth/network-request-failed") return say(log, ERR[x.code], 1); }
  say(log, "If an account exists for that email, a reset link is on its way.");
});

onAuthStateChanged(auth, (u) => {
  if (!u) return;
  const l = document.querySelector('nav a[href="#login"]'), c = document.querySelector("nav a.cta");
  l.textContent = "Dashboard"; l.href = "app.html"; c.style.display = "none";
});
