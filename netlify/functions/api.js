// BetterHub server: ONE file with everything (wallet ledger, pricing, supplier adapters, customer + admin actions).
// Sections: 1 core  2 providers  3 customer actions  4 admin actions  5 router
// Called from the website as POST /api with { scope: "customer" | "admin", action: "...", ... }

// ===== 1. CORE =====
// Shared server code: Firebase Admin, auth checks, rate limits, audit log, wallet ledger, pricing.
const admin = require("firebase-admin");
const crypto = require("crypto");
const { FieldValue } = admin.firestore;

function init() {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
      }),
    });
  }
  return { db: admin.firestore(), auth: admin.auth() };
}

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const json = (data, status = 200) => ({ statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(data) });

// Wraps a function so every call is POST-only, JSON-in/JSON-out, with safe errors.
function handler(fn) {
  return async (event) => {
    if (event.httpMethod !== "POST") return json({ error: "POST only" }, 405);
    try {
      let body = {};
      try { body = JSON.parse(event.body || "{}"); } catch (e) { throw new HttpError(400, "Bad request"); }
      return json(await fn(body, event));
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: "Server error" }, 500);
    }
  };
}

async function verify(event) {
  const h = (event.headers && (event.headers.authorization || event.headers.Authorization)) || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!token) throw new HttpError(401, "Sign in required");
  const { auth } = init();
  try { return await auth.verifyIdToken(token, true); }
  catch (e) { throw new HttpError(401, "Session expired. Sign in again."); }
}

const adminEmails = () => (process.env.ADMIN_EMAILS || "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
function isAdmin(tok) {
  return tok.role === "admin" || (tok.email_verified === true && adminEmails().includes((tok.email || "").toLowerCase()));
}

async function limit(uid, key, max) {
  const { db } = init();
  const ref = db.collection("rateLimits").doc(`${uid}_${key}_${Math.floor(Date.now() / 60000)}`);
  const n = await db.runTransaction(async (t) => {
    const s = await t.get(ref);
    const c = (s.exists ? s.data().n : 0) + 1;
    t.set(ref, { n: c, expireAt: new Date(Date.now() + 3600e3) });
    return c;
  });
  if (n > max) throw new HttpError(429, "Too many requests. Wait a minute and try again.");
}

async function audit(actor, action, details) {
  const { db } = init();
  await db.collection("auditLogs").add({ actor, action, details: details || {}, createdAt: FieldValue.serverTimestamp() });
}

async function notify(uid, title, body) {
  const { db } = init();
  await db.collection("notifications").add({ userId: uid, title, body, read: false, createdAt: FieldValue.serverTimestamp() });
}

function toKobo(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new HttpError(400, "Enter a valid amount");
  return Math.round(n * 100);
}

// Creates the wallet (balance 0) if it does not exist yet.
async function ensureWallet(uid) {
  const { db } = init();
  const ref = db.collection("wallets").doc(uid);
  return db.runTransaction(async (t) => {
    const s = await t.get(ref);
    if (s.exists) return s.data();
    const w = { balance: 0, currency: "NGN", createdAt: FieldValue.serverTimestamp() };
    t.create(ref, w);
    return w;
  });
}

/*
 Wallet ledger. Amounts are integer kobo (credit +, debit -).
 The ledger entry's document id IS the idempotency key, so the same key can never post twice.
 Balance and ledger entry change in one Firestore transaction. Entries are never updated or deleted.
*/
async function postLedger({ uid, type, amount, idemKey, reference, meta }) {
  const { db } = init();
  if (!Number.isInteger(amount) || amount === 0) throw new HttpError(400, "Invalid amount");
  if (!/^[\w.-]{6,120}$/.test(idemKey)) throw new HttpError(400, "Invalid request id");
  const txRef = db.collection("walletTransactions").doc(idemKey);
  const wRef = db.collection("wallets").doc(uid);
  return db.runTransaction(async (t) => {
    const existing = await t.get(txRef);
    const w = await t.get(wRef);
    if (existing.exists) return { dup: true, balanceAfter: existing.data().balanceAfter };
    const before = w.exists ? w.data().balance : 0;
    const after = before + amount;
    if (after < 0) throw new HttpError(402, "Insufficient wallet balance");
    t.set(wRef, { balance: after, currency: "NGN", updatedAt: FieldValue.serverTimestamp(), ...(w.exists ? {} : { createdAt: FieldValue.serverTimestamp() }) }, { merge: true });
    t.create(txRef, { userId: uid, type, amount, balanceAfter: after, reference, status: "completed", meta: meta || {}, createdAt: FieldValue.serverTimestamp() });
    return { dup: false, balanceAfter: after };
  });
}

// Pricing: cost and result are integer kobo. rule = { type: "percent"|"fixed"|"custom", value, minProfitKobo }
// percent: value is a percentage. fixed: value is kobo added to cost. custom: value is the final price in kobo.
function retailPrice(cost, rule) {
  let p;
  if (rule.type === "custom") p = rule.value;
  else if (rule.type === "fixed") p = cost + rule.value;
  else p = Math.round(cost * (1 + rule.value / 100));
  const minProfit = rule.minProfitKobo || 0;
  if (p - cost < minProfit) p = cost + minProfit;
  return p;
}
const DEFAULT_RULE = { type: "percent", value: 30, minProfitKobo: 0 };
async function getRule() {
  const { db } = init();
  const s = await db.collection("pricingRules").doc("default").get();
  return s.exists ? s.data() : DEFAULT_RULE;
}

// ===== 2. PROVIDERS =====
// Provider layer. Every supplier gets an adapter with the same interface, so the rest of the app never
// talks to a supplier directly. To add a supplier: write a class extending ProviderAdapter and register it below.

class ProviderError extends Error { constructor(message, status, data) { super(message); this.status = status; this.data = data; } }

class ProviderAdapter {
  constructor(id, cfg) { this.id = id; this.cfg = cfg || {}; }
  async catalog() { throw new ProviderError("catalog not implemented"); }
  async buy() { throw new ProviderError("buy not implemented"); }
  async status() { throw new ProviderError("status not implemented"); }
  async finish() { throw new ProviderError("finish not implemented"); }
  async cancel() { throw new ProviderError("cancel not implemented"); }
  // Health monitor: one cheap catalogue call, timed.
  async health() {
    const t = Date.now();
    try { await this.catalog("countries", {}); return { ok: true, ms: Date.now() - t, at: Date.now() }; }
    catch (e) { return { ok: false, ms: Date.now() - t, at: Date.now(), error: String(e.message).slice(0, 200) }; }
  }
}

// Get Your OTP. Requests follow their API documentation exactly (POST, JSON body with an "action" field).
// Purchase actions are deliberately disabled until we have confirmed sample responses, so we never pay
// the supplier for something we cannot record.
class GetYourOtp extends ProviderAdapter {
  async call(path, body, authed) {
    const key = authed ? process.env[this.cfg.credentialEnv || "GYO_API_KEY"] : null;
    if (authed && !key) throw new ProviderError("Provider key is not set", 500);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    try {
      const r = await fetch((this.cfg.baseUrl || "https://getyourotp.com/api") + path, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(key ? { Authorization: "Bearer " + key } : {}) },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
      const text = await r.text();
      let data; try { data = JSON.parse(text); } catch (e) { data = { raw: text.slice(0, 500) }; }
      if (!r.ok) throw new ProviderError((data && data.error) || "HTTP " + r.status, r.status, data);
      return data;
    } catch (e) {
      if (e.name === "AbortError") throw new ProviderError("Provider timed out", 0);
      throw e;
    } finally { clearTimeout(timer); }
  }
  // Public catalogue endpoints (no key). Returns the supplier's raw response.
  async catalog(action, params) {
    if (!["countries", "services", "operatorPrices"].includes(action)) throw new ProviderError("Unsupported catalogue action");
    return this.call("/numbers", { action, ...(params || {}) }, false);
  }
  async buy() { throw new ProviderError("Purchases are not enabled yet"); }
  async status() { throw new ProviderError("Not enabled yet"); }
  async finish() { throw new ProviderError("Not enabled yet"); }
  async cancel() { throw new ProviderError("Not enabled yet"); }
}

const TYPES = { getyourotp: GetYourOtp };

async function ensureDefaultProvider() {
  const { db } = init();
  const ref = db.collection("providers").doc("getyourotp");
  const s = await ref.get();
  if (!s.exists) await ref.set({ name: "Get Your OTP", type: "getyourotp", enabled: true, baseUrl: "https://getyourotp.com/api", credentialEnv: "GYO_API_KEY", priority: 1, purchasesEnabled: false });
}

async function getAdapter(id) {
  const { db } = init();
  const s = await db.collection("providers").doc(id).get();
  if (!s.exists) throw new HttpError(404, "Unknown provider");
  const cfg = s.data();
  const Cls = TYPES[cfg.type];
  if (!Cls) throw new HttpError(500, "Unsupported provider type");
  return new Cls(id, cfg);
}

// ===== PAYSTACK (wallet funding) =====
// Flow: customer starts a deposit -> we save a pending payment -> Paystack hosted page -> we verify with Paystack
// (from the return page AND from the webhook) -> ledger credit, once only (ledger entry id = "dep_" + reference).
const SITE_URL = () => (process.env.SITE_URL || "https://betterhubhq.netlify.app").replace(/\/$/, "");
const PAY_REF = /^BH-DEP-[A-F0-9]{12}$/;

async function paystack(path, method, body) {
  const key = process.env.PAYSTACK_SECRET_KEY;
  if (!key) throw new HttpError(503, "Payments are not set up yet");
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch("https://api.paystack.co" + path, {
      method, headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined, signal: ctl.signal,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.status === false) throw new HttpError(502, "Payment provider error. Try again.");
    return j.data;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(502, "Payment provider did not respond. Try again.");
  } finally { clearTimeout(timer); }
}

// Checks the payment with Paystack itself (never trusts the browser or the webhook body) and credits the wallet once.
async function settleDeposit(reference) {
  const { db } = init();
  const pref = db.collection("payments").doc(reference);
  const ps = await pref.get();
  if (!ps.exists) return { status: "unknown" };
  const p = ps.data();
  if (p.status === "success") return { status: "success" };
  const v = await paystack("/transaction/verify/" + encodeURIComponent(reference), "GET");
  if (v.status === "success") {
    if (v.currency !== "NGN" || v.amount !== p.amount) {
      await pref.update({ status: "mismatch", paidKobo: v.amount, flaggedAt: FieldValue.serverTimestamp() });
      await audit("system", "paymentMismatch", { reference, paid: v.amount, expected: p.amount });
      return { status: "mismatch" };
    }
    const r = await postLedger({ uid: p.userId, type: "deposit", amount: p.amount, idemKey: "dep_" + reference, reference, meta: { gateway: "paystack" } });
    await pref.update({ status: "success", paidAt: FieldValue.serverTimestamp() });
    if (!r.dup) await notify(p.userId, "Wallet funded", "\u20a6" + (p.amount / 100).toLocaleString("en-NG") + " was added to your wallet.");
    return { status: "success", balanceAfter: r.balanceAfter };
  }
  if (v.status === "failed" || v.status === "reversed") { await pref.update({ status: "failed" }); return { status: "failed" }; }
  return { status: "pending" };
}

async function paystackWebhook(d, event) {
  const key = process.env.PAYSTACK_SECRET_KEY || "";
  const sig = (event.headers && (event.headers["x-paystack-signature"] || event.headers["X-Paystack-Signature"])) || "";
  const mac = Buffer.from(crypto.createHmac("sha512", key).update(event.body || "").digest("hex"));
  const got = Buffer.from(String(sig));
  if (!key || mac.length !== got.length || !crypto.timingSafeEqual(mac, got)) throw new HttpError(401, "Bad signature");
  if (d.event === "charge.success" && d.data && PAY_REF.test(String(d.data.reference))) await settleDeposit(d.data.reference);
  return { ok: true };
}

// ===== 3. CUSTOMER ACTIONS =====

const ticketOut = (x) => { const t = x.data(); return { id: x.id, email: t.email, subject: t.subject, message: t.message, status: t.status, replies: t.replies || [], createdAt: (t.createdAt && t.createdAt.toMillis && t.createdAt.toMillis()) || 0 }; };
const customerAction = async (body, event) => {
  const tok = await verify(event);
  await limit(tok.uid, "customer", 30);
  const { db } = init();
  if (body.action === "bootstrap") {
    // Makes sure the wallet exists, and repairs a missing profile if sign-up was interrupted.
    const w = await ensureWallet(tok.uid);
    const uref = db.collection("users").doc(tok.uid);
    if (!(await uref.get()).exists) {
      await uref.set({ displayName: tok.name || (tok.email || "").split("@")[0], email: tok.email || "", role: "customer", status: "active", createdAt: FieldValue.serverTimestamp() });
    }
    const gs = await db.collection("systemSettings").doc("general").get();
    const g = gs.exists ? gs.data() : {};
    return { ok: true, balance: w.balance || 0, maintenance: !!g.maintenance, maintenanceMessage: g.maintenanceMessage || "" };
  }
  if (body.action === "createTicket") {
    await limit(tok.uid, "ticket", 5);
    const subject = String(body.subject || "").trim().slice(0, 120), message = String(body.message || "").trim().slice(0, 2000);
    if (!subject || !message) throw new HttpError(400, "Add a subject and a message");
    const ref = await db.collection("supportTickets").add({ userId: tok.uid, email: tok.email || "", subject, message, status: "open", replies: [], createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    return { ok: true, id: ref.id };
  }
  if (body.action === "myTickets") {
    const snap = await db.collection("supportTickets").where("userId", "==", tok.uid).limit(30).get();
    return { tickets: snap.docs.map(ticketOut).sort((a, b) => b.createdAt - a.createdAt) };
  }
  if (body.action === "startDeposit") {
    await limit(tok.uid, "deposit", 10);
    const amount = toKobo(body.amountNaira);
    if (amount < 10000 || amount > 200000000) throw new HttpError(400, "Enter an amount between \u20a6100 and \u20a62,000,000.");
    if (!tok.email) throw new HttpError(400, "Your account needs an email address.");
    const reference = "BH-DEP-" + crypto.randomBytes(6).toString("hex").toUpperCase();
    await ensureWallet(tok.uid);
    const pref = db.collection("payments").doc(reference);
    await pref.set({ userId: tok.uid, amount, currency: "NGN", gateway: "paystack", status: "pending", createdAt: FieldValue.serverTimestamp() });
    try {
      const data = await paystack("/transaction/initialize", "POST", { email: tok.email, amount, currency: "NGN", reference, callback_url: SITE_URL() + "/app.html" });
      return { url: data.authorization_url, reference };
    } catch (e) { await pref.update({ status: "failed" }); throw e; }
  }
  if (body.action === "verifyDeposit") {
    await limit(tok.uid, "verify", 20);
    const reference = String(body.reference || "").slice(0, 40);
    if (!PAY_REF.test(reference)) throw new HttpError(400, "Bad payment reference");
    const s = await db.collection("payments").doc(reference).get();
    if (!s.exists || s.data().userId !== tok.uid) throw new HttpError(404, "Payment not found");
    return await settleDeposit(reference);
  }
  return { error: "Unknown action" };
};

// ===== 4. ADMIN ACTIONS =====
const CATEGORIES = ["numbers", "esim", "vpn", "gifts", "growth"];
const DEFAULT_CATS = { numbers: true, esim: false, vpn: false, gifts: false, growth: false };
const str = (v, n = 60) => String(v == null ? "" : v).trim().slice(0, n);

const adminAction = async (d, event) => {
  const tok = await verify(event);
  if (!isAdmin(tok)) throw new HttpError(403, "Not an admin");
  await limit(tok.uid, "admin", 120);
  const { db, auth } = init();

  switch (d.action) {
    case "whoami": {
      let refresh = false;
      if (tok.role !== "admin") { await auth.setCustomUserClaims(tok.uid, { role: "admin" }); refresh = true; }
      return { admin: true, refresh };
    }
    case "overview": {
      await ensureDefaultProvider();
      const [u, o, w] = await Promise.all([
        db.collection("users").count().get(),
        db.collection("orders").count().get(),
        db.collection("wallets").aggregate({ total: admin.firestore.AggregateField.sum("balance") }).get(),
      ]);
      return { users: u.data().count, orders: o.data().count, walletLiabilityKobo: w.data().total || 0 };
    }
    case "providerHealth": {
      await ensureDefaultProvider();
      const h = await (await getAdapter("getyourotp")).health();
      await db.collection("providers").doc("getyourotp").set({ health: h }, { merge: true });
      return h;
    }
    case "providerCatalog": {
      await ensureDefaultProvider();
      const params = {};
      if (d.country) params.country = str(d.country);
      if (d.product) params.product = str(d.product);
      const t = Date.now();
      try { return { ms: Date.now() - t, data: await (await getAdapter("getyourotp")).catalog(str(d.call), params) }; }
      catch (e) { return { ms: Date.now() - t, error: e.message, status: e.status, data: e.data }; }
    }
    case "getPricing": return await getRule();
    case "setPricing": {
      if (!["percent", "fixed", "custom"].includes(d.type)) throw new HttpError(400, "Bad pricing type");
      const value = d.type === "percent" ? Number(d.value) : toKobo(d.value);
      if (!Number.isFinite(value) || value < 0 || (d.type === "percent" && value > 1000)) throw new HttpError(400, "Bad value");
      const rule = { type: d.type, value, minProfitKobo: Math.max(0, toKobo(d.minProfitNaira || 0)), updatedBy: tok.uid, updatedAt: admin.firestore.FieldValue.serverTimestamp() };
      await db.collection("pricingRules").doc("default").set(rule);
      await audit(tok.uid, "setPricing", { type: rule.type, value, minProfitKobo: rule.minProfitKobo });
      return { ok: true };
    }
    case "quote": {
      const cost = toKobo(d.costNaira), rule = await getRule(), retail = retailPrice(cost, rule);
      return { retailKobo: retail, profitKobo: retail - cost };
    }
    case "getCategories": {
      const s = await db.collection("systemSettings").doc("categories").get();
      return { ...DEFAULT_CATS, ...(s.exists ? s.data() : {}) };
    }
    case "setCategory": {
      if (!CATEGORIES.includes(d.key) || typeof d.enabled !== "boolean") throw new HttpError(400, "Bad request");
      await db.collection("systemSettings").doc("categories").set({ [d.key]: d.enabled }, { merge: true });
      await audit(tok.uid, "setCategory", { key: d.key, enabled: d.enabled });
      return { ok: true };
    }
    case "listUsers": {
      const q = str(d.q, 80).toLowerCase();
      let ref = db.collection("users");
      ref = q ? ref.where("email", ">=", q).where("email", "<=", q + "\uf8ff") : ref.orderBy("createdAt", "desc");
      const snap = await ref.limit(20).get();
      const wallets = snap.docs.length ? await db.getAll(...snap.docs.map((x) => db.collection("wallets").doc(x.id))) : [];
      return { users: snap.docs.map((x, i) => ({ uid: x.id, name: x.data().displayName, email: x.data().email, status: x.data().status, balanceKobo: wallets[i].exists ? wallets[i].data().balance : 0 })) };
    }
    case "adjust": {
      const amt = toKobo(d.amountNaira), reason = str(d.reason, 200), uid = str(d.uid, 128), rid = str(d.requestId, 64);
      if (!amt || Math.abs(amt) > 100000000 || !reason || !uid || !/^[\w-]{8,64}$/.test(rid)) throw new HttpError(400, "Check the amount, reason and user");
      if (!(await db.collection("users").doc(uid).get()).exists) throw new HttpError(404, "User not found");
      const r = await postLedger({ uid, type: "adjustment", amount: amt, idemKey: "adj_" + rid, reference: "BH-ADJ-" + rid.slice(0, 8).toUpperCase(), meta: { reason, by: tok.uid } });
      if (!r.dup) {
        await audit(tok.uid, "adjust", { uid, amountKobo: amt, reason });
        await notify(uid, amt > 0 ? "Wallet credited" : "Wallet debited", reason);
      }
      return { ok: true, duplicate: r.dup, balanceAfterKobo: r.balanceAfter };
    }
    case "setUserStatus": {
      const uid = str(d.uid, 128);
      if (!uid || !["active", "suspended"].includes(d.status)) throw new HttpError(400, "Bad request");
      if (uid === tok.uid) throw new HttpError(400, "You cannot suspend your own account");
      await db.collection("users").doc(uid).update({ status: d.status });
      await auth.updateUser(uid, { disabled: d.status === "suspended" });
      if (d.status === "suspended") await auth.revokeRefreshTokens(uid);
      await audit(tok.uid, "setUserStatus", { uid, status: d.status });
      return { ok: true };
    }
    case "listTickets": {
      const snap = await db.collection("supportTickets").where("status", "==", d.status === "closed" ? "closed" : "open").limit(50).get();
      return { tickets: snap.docs.map(ticketOut).sort((a, b) => b.createdAt - a.createdAt) };
    }
    case "replyTicket": {
      const id = str(d.id, 64), message = str(d.message, 2000), close = d.close === true;
      if (!id || (!message && !close)) throw new HttpError(400, "Write a reply or close the ticket");
      const ref = db.collection("supportTickets").doc(id), snap = await ref.get();
      if (!snap.exists) throw new HttpError(404, "Ticket not found");
      const upd = { updatedAt: FieldValue.serverTimestamp() };
      if (message) upd.replies = FieldValue.arrayUnion({ by: "support", message, at: Date.now() });
      if (close) upd.status = "closed";
      await ref.update(upd);
      if (message) await notify(snap.data().userId, "Support replied", "Re: " + snap.data().subject);
      await audit(tok.uid, "replyTicket", { id, closed: close });
      return { ok: true };
    }
    case "ledger": {
      const type = ["deposit", "purchase", "refund", "adjustment"].includes(d.type) ? d.type : null;
      const q = type ? db.collection("walletTransactions").where("type", "==", type).limit(100) : db.collection("walletTransactions").orderBy("createdAt", "desc").limit(100);
      const snap = await q.get();
      const rows = snap.docs.map((x) => { const t = x.data(); return { ref: t.reference, userId: t.userId, type: t.type, amountKobo: t.amount, balanceAfterKobo: t.balanceAfter, at: t.createdAt && t.createdAt.toMillis ? t.createdAt.toMillis() : 0, reason: (t.meta && t.meta.reason) || "" }; }).sort((a, b) => b.at - a.at);
      return { rows };
    }
    case "financeSummary": {
      const types = ["deposit", "purchase", "refund", "adjustment"];
      const res = await Promise.all(types.map((t) => db.collection("walletTransactions").where("type", "==", t).aggregate({ s: admin.firestore.AggregateField.sum("amount"), n: admin.firestore.AggregateField.count() }).get()));
      const out = {};
      types.forEach((t, i) => { out[t] = { sumKobo: res[i].data().s || 0, count: res[i].data().n || 0 }; });
      return out;
    }
    case "listOrders": {
      const snap = await db.collection("orders").orderBy("createdAt", "desc").limit(50).get();
      return { orders: snap.docs.map((x) => { const o = x.data(); return { id: x.id, userId: o.userId, status: o.status, service: o.service || "", country: o.country || "", priceKobo: o.priceKobo || 0, costKobo: o.costKobo || 0, providerRef: o.providerRef || "" }; }) };
    }
    case "getSettings": {
      const s = await db.collection("systemSettings").doc("general").get();
      return { businessName: "BetterHub", supportWhatsapp: "+2347026045216", maintenance: false, maintenanceMessage: "", ...(s.exists ? s.data() : {}) };
    }
    case "setSettings": {
      if (typeof d.maintenance !== "boolean") throw new HttpError(400, "Bad request");
      const v = { businessName: str(d.businessName, 80) || "BetterHub", supportWhatsapp: str(d.supportWhatsapp, 30), maintenance: d.maintenance, maintenanceMessage: str(d.maintenanceMessage, 200) };
      await db.collection("systemSettings").doc("general").set(v, { merge: true });
      await audit(tok.uid, "setSettings", v);
      return { ok: true };
    }
    case "getProvider": {
      await ensureDefaultProvider();
      const p = (await db.collection("providers").doc("getyourotp").get()).data();
      return { name: p.name, enabled: !!p.enabled, priority: p.priority || 1, health: p.health || null };
    }
    case "setProvider": {
      const pr = Number(d.priority);
      if (typeof d.enabled !== "boolean" || !Number.isInteger(pr) || pr < 1 || pr > 99) throw new HttpError(400, "Bad request");
      await db.collection("providers").doc("getyourotp").set({ enabled: d.enabled, priority: pr, name: str(d.name, 60) || "Get Your OTP" }, { merge: true });
      await audit(tok.uid, "setProvider", { enabled: d.enabled, priority: pr });
      return { ok: true };
    }
    case "verifyPayment": {
      const ref = str(d.reference, 40).toUpperCase();
      if (!PAY_REF.test(ref)) throw new HttpError(400, "Bad payment reference");
      const r = await settleDeposit(ref);
      await audit(tok.uid, "verifyPayment", { reference: ref, result: r.status });
      return r;
    }
    default: throw new HttpError(400, "Unknown action");
  }
};

// ===== 5. ROUTER =====
exports.handler = handler(async (d, event) => {
  if (event.queryStringParameters && event.queryStringParameters.hook === "paystack") return paystackWebhook(d, event);
  return d.scope === "admin" ? adminAction(d, event) : customerAction(d, event);
});
