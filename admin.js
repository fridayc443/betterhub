import { auth } from "./firebase.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/13.3.0/firebase-auth.js";

const $ = (i) => document.getElementById(i);
const naira = (k) => "₦" + (k / 100).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const rid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));

async function call(action, data = {}) {
  const t = await auth.currentUser.getIdToken();
  const r = await fetch("/api/admin", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + t }, body: JSON.stringify({ action, ...data }) });
  const j = await r.json().catch(() => ({ error: "Bad response from server" }));
  if (!r.ok) { const e = new Error(j.error || "Request failed"); e.status = r.status; throw e; }
  return j;
}
function say(el, text, bad) { el.textContent = text; el.className = (el.className.split(" ")[0] || "") + (bad ? " bad" : ""); }
function busy(btn, fn) { return async () => { btn.disabled = true; try { await fn(); } finally { btn.disabled = false; } }; }

onAuthStateChanged(auth, async (u) => {
  if (!u) { location.replace("index.html#login"); return; }
  try {
    const w = await call("whoami");
    if (w.refresh) await u.getIdToken(true);
  } catch (e) {
    $("gate").textContent = e.status === 403
      ? "This account is not an admin. Add your email to ADMIN_EMAILS in Netlify, verify your email, then sign in again."
      : "Could not reach the server: " + e.message;
    return;
  }
  $("gate").hidden = true; $("panel").hidden = false;
  loadOverview(); loadPricing(); loadCats();
});

async function loadOverview() {
  try { const o = await call("overview"); $("oU").textContent = o.users; $("oO").textContent = o.orders; $("oW").textContent = naira(o.walletLiabilityKobo); } catch (e) { /* leave dashes */ }
}

$("hBtn").onclick = busy($("hBtn"), async () => {
  say($("hOut"), "Checking...");
  try { const h = await call("providerHealth"); say($("hOut"), h.ok ? "Connected, " + h.ms + " ms" : "Not reachable: " + h.error, !h.ok); $("hOut").className = "small " + (h.ok ? "ok" : "bad"); }
  catch (e) { say($("hOut"), e.message, true); }
});

let fullReply = "";
$("eBtn").onclick = busy($("eBtn"), async () => {
  $("eOut").hidden = false; $("eOut").textContent = "Loading...";
  try {
    const r = await call("providerCatalog", { call: $("eCall").value, country: $("eCountry").value.trim(), product: $("eProd").value.trim() });
    fullReply = JSON.stringify({ call: $("eCall").value, country: $("eCountry").value.trim(), product: $("eProd").value.trim(), ms: r.ms, error: r.error, status: r.status, data: r.data }, null, 2);
    $("eOut").textContent = fullReply.length > 6000 ? fullReply.slice(0, 6000) + "\n... (shortened here, Copy gives everything)" : fullReply;
    $("eCopy").hidden = false;
  } catch (e) { $("eOut").textContent = e.message; }
});
$("eCopy").onclick = async () => { try { await navigator.clipboard.writeText(fullReply); $("eCopy").textContent = "Copied"; } catch (e) { $("eCopy").textContent = "Copy failed. Select the text instead."; } setTimeout(() => ($("eCopy").textContent = "Copy full reply"), 2500); };

function pLabel() { $("pLbl").textContent = $("pType").value === "percent" ? "Percent (e.g. 30)" : "Amount (₦)"; }
$("pType").onchange = pLabel;
async function loadPricing() {
  try {
    const r = await call("getPricing");
    $("pType").value = r.type; pLabel();
    $("pVal").value = r.type === "percent" ? r.value : r.value / 100;
    $("pMin").value = (r.minProfitKobo || 0) / 100;
  } catch (e) { /* keep blanks */ }
}
$("pSave").onclick = busy($("pSave"), async () => {
  try { await call("setPricing", { type: $("pType").value, value: $("pVal").value, minProfitNaira: $("pMin").value }); say($("pMsg"), "Saved"); }
  catch (e) { say($("pMsg"), e.message, true); }
});
$("qBtn").onclick = busy($("qBtn"), async () => {
  try { const q = await call("quote", { costNaira: $("qCost").value }); $("qOut").textContent = "Customer pays " + naira(q.retailKobo) + ", your profit " + naira(q.profitKobo) + " (saved rule)."; }
  catch (e) { $("qOut").textContent = e.message; }
});

const CAT = { numbers: "Virtual numbers", esim: "eSIM", vpn: "VPN", gifts: "Gifts", growth: "Social growth (needs compliance approval)" };
async function loadCats() {
  try {
    const c = await call("getCategories"); $("cats").textContent = "";
    Object.keys(CAT).forEach((k) => {
      const row = document.createElement("div"); row.className = "row";
      const l = document.createElement("span"); l.textContent = CAT[k];
      const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = !!c[k]; cb.style.width = "auto"; cb.setAttribute("aria-label", CAT[k]);
      cb.onchange = async () => { try { await call("setCategory", { key: k, enabled: cb.checked }); } catch (e) { cb.checked = !cb.checked; alert(e.message); } };
      row.append(l, cb); $("cats").append(row);
    });
  } catch (e) { $("cats").textContent = e.message; }
}

let sel = null;
function showUser(u) {
  sel = u; $("uPanel").hidden = false; $("uName").textContent = u.name || u.email;
  $("uInfo").textContent = u.email + " · " + naira(u.balanceKobo) + " · " + u.status;
  $("sBtn").textContent = u.status === "suspended" ? "Reactivate account" : "Suspend account"; $("uMsg").textContent = "";
}
$("uBtn").onclick = busy($("uBtn"), async () => {
  try {
    const r = await call("listUsers", { q: $("uQ").value }); const box = $("uList"); box.textContent = "";
    if (!r.users.length) { box.textContent = "No customers found."; return; }
    r.users.forEach((u) => {
      const row = document.createElement("div"); row.className = "row";
      const l = document.createElement("span"); l.textContent = (u.name || "") + " " + u.email + " (" + naira(u.balanceKobo) + ")";
      const b = document.createElement("button"); b.className = "btn alt"; b.textContent = "Open"; b.onclick = () => showUser(u);
      row.append(l, b); box.append(row);
    });
  } catch (e) { $("uList").textContent = e.message; }
});
let adjId = rid();
$("aBtn").onclick = busy($("aBtn"), async () => {
  if (!sel) return;
  try {
    const r = await call("adjust", { uid: sel.uid, amountNaira: $("aAmt").value, reason: $("aWhy").value, requestId: adjId });
    adjId = rid(); sel.balanceKobo = r.balanceAfterKobo; showUser(sel); say($("uMsg"), r.duplicate ? "Already applied" : "Done"); $("aAmt").value = ""; $("aWhy").value = ""; loadOverview();
  } catch (e) { say($("uMsg"), e.message, true); }
});
$("sBtn").onclick = busy($("sBtn"), async () => {
  if (!sel) return;
  const next = sel.status === "suspended" ? "active" : "suspended";
  try { await call("setUserStatus", { uid: sel.uid, status: next }); sel.status = next; showUser(sel); say($("uMsg"), "Updated"); }
  catch (e) { say($("uMsg"), e.message, true); }
});
