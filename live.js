// Customer dashboard live data: makes sure the wallet exists, then shows real transactions and notifications.
import { auth, db } from "./firebase.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/13.3.0/firebase-auth.js";
import { collection, query, where, onSnapshot } from "https://www.gstatic.com/firebasejs/13.3.0/firebase-firestore.js";

const $ = (i) => document.getElementById(i);
const money = (k) => (k / 100).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const LABEL = { deposit: "Wallet funding", purchase: "Number purchase", refund: "Refund", adjustment: "Balance adjustment" };
const when = (ts) => (ts && ts.toMillis ? new Date(ts.toMillis()).toLocaleString("en-NG", { dateStyle: "medium", timeStyle: "short" }) : "just now");

function row(title, sub, right, rightClass) {
  const r = document.createElement("div"); r.className = "row";
  const l = document.createElement("div"); l.append(title);
  const s = document.createElement("small"); s.textContent = sub; l.append(s);
  r.append(l);
  if (right) { const b = document.createElement("b"); b.textContent = right; b.className = rightClass || ""; r.append(b); }
  return r;
}
function fill(el, rows) { el.textContent = ""; rows.forEach((r) => el.append(r)); }
const ms = (d) => (d.createdAt && d.createdAt.toMillis ? d.createdAt.toMillis() : Date.now());

onAuthStateChanged(auth, async (u) => {
  if (!u) return;
  try {
    const t = await u.getIdToken();
    await fetch("/api/customer", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + t }, body: JSON.stringify({ action: "bootstrap" }) });
  } catch (e) { /* wallet shows 0 until the server is reachable */ }

  onSnapshot(query(collection(db, "walletTransactions"), where("userId", "==", u.uid)), (snap) => {
    const items = snap.docs.map((x) => x.data()).sort((a, b) => ms(b) - ms(a)).slice(0, 50);
    if (!items.length) return;
    const rows = items.map((x) => row(LABEL[x.type] || x.type, x.reference + " · " + when(x.createdAt), (x.amount > 0 ? "+₦" : "-₦") + money(Math.abs(x.amount)), x.amount > 0 ? "in" : "out"));
    fill($("txList"), rows);
    fill($("recent"), rows.slice(0, 5).map((r) => r.cloneNode(true)));
  }, () => {});

  onSnapshot(query(collection(db, "notifications"), where("userId", "==", u.uid)), (snap) => {
    const items = snap.docs.map((x) => x.data()).sort((a, b) => ms(b) - ms(a)).slice(0, 50);
    if (!items.length) return;
    fill($("noteList"), items.map((n) => row(n.title, (n.body ? n.body + " · " : "") + when(n.createdAt))));
  }, () => {});
});
