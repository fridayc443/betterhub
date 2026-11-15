import { auth, db } from "./firebase.js";
import { onAuthStateChanged, signOut, sendEmailVerification } from "https://www.gstatic.com/firebasejs/13.3.0/firebase-auth.js";
import { doc, onSnapshot } from "https://www.gstatic.com/firebasejs/13.3.0/firebase-firestore.js";

const $ = (i) => document.getElementById(i);
let started = false;

onAuthStateChanged(auth, (u) => {
  if (!u) { location.replace("index.html#login"); return; }
  document.body.classList.add("ready");
  if (started) return; started = true;
  const name = u.displayName || u.email.split("@")[0];
  $("hi").textContent = "Hi, " + name;
  $("pn").value = name; $("pe").value = u.email;
  $("out").onclick = async () => { await signOut(auth); location.href = "index.html"; };

  const bar = $("acct");
  function note(text, ...btns) {
    bar.hidden = false; bar.textContent = "";
    const s = document.createElement("span"); s.textContent = text; bar.append(s);
    btns.forEach(([label, fn]) => { const b = document.createElement("button"); b.className = "ib"; b.textContent = label; b.onclick = fn; bar.append(b); });
  }
  function verifyBar() {
    if (auth.currentUser.emailVerified) { bar.hidden = true; return; }
    note("Verify your email. We sent a link to " + u.email + ".",
      ["Resend link", async () => { try { await sendEmailVerification(auth.currentUser); note("Link sent. Check your inbox and spam.", ["I’ve verified", check]); } catch (e) { note("Wait a minute before asking again.", ["I’ve verified", check]); } }],
      ["I’ve verified", check]);
  }
  async function check() { await auth.currentUser.reload(); verifyBar(); if (!auth.currentUser.emailVerified) note("Not verified yet. Open the link in the email, then tap again.", ["I’ve verified", check]); }
  verifyBar();

  onSnapshot(doc(db, "users", u.uid), (s) => {
    const st = s.exists() ? s.data().status : "active";
    $("pst").textContent = st;
    if (st === "suspended") note("This account is suspended. Contact support on WhatsApp.");
  }, () => { $("pst").textContent = "unavailable"; });

  onSnapshot(doc(db, "wallets", u.uid), (s) => {
    const kobo = s.exists() ? Number(s.data().balance) || 0 : 0;
    const t = "₦" + (kobo / 100).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    document.querySelectorAll("[data-bal]").forEach((el) => (el.textContent = t));
  }, () => {});
});
