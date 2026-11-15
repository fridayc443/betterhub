const { jsonResponse, requireAdmin, getDb, readJsonEvent, moneyToKobo, koboToMoney } = require("./lib/core");
const { providerHealth, providerCatalog } = require("./lib/providers");

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return jsonResponse(200, { ok: true });
  }

  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "Method not allowed" });
  }

  try {
    const body = await readJsonEvent(event);
    const action = body.action;

    if (action === "whoami") {
      const user = await requireAdmin(event);
      return jsonResponse(200, { ok: true, uid: user.uid, email: user.email, refresh: false });
    }

    if (action === "overview") {
      await requireAdmin(event);
      const db = getDb();
      const [usersSnap, ordersSnap, walletsSnap] = await Promise.all([
        db.collection("users").get(),
        db.collection("orders").get(),
        db.collection("wallets").get(),
      ]);
      const walletLiabilityKobo = walletsSnap.docs.reduce((sum, doc) => sum + (Number(doc.data().balance) || 0), 0);
      return jsonResponse(200, { users: usersSnap.size, orders: ordersSnap.size, walletLiabilityKobo });
    }

    if (action === "providerHealth") {
      await requireAdmin(event);
      return jsonResponse(200, await providerHealth());
    }

    if (action === "providerCatalog") {
      await requireAdmin(event);
      return jsonResponse(200, await providerCatalog(body.call, body.country, body.product));
    }

    if (action === "getPricing") {
      await requireAdmin(event);
      const db = getDb();
      const pricing = await db.collection("systemSettings").doc("pricing").get();
      const data = pricing.exists ? pricing.data() : { type: "percent", value: 30, minProfitKobo: 0 };
      return jsonResponse(200, {
        type: data.type || "percent",
        value: Number(data.value || 0),
        minProfitKobo: Number(data.minProfitKobo || 0),
      });
    }

    if (action === "setPricing") {
      await requireAdmin(event);
      const db = getDb();
      const type = body.type || "percent";
      const value = Number(body.value || 0);
      const minProfitKobo = moneyToKobo(Number(body.minProfitNaira || 0));
      await db.collection("systemSettings").doc("pricing").set({ type, value, minProfitKobo }, { merge: true });
      return jsonResponse(200, { ok: true });
    }

    if (action === "quote") {
      await requireAdmin(event);
      const costNaira = Number(body.costNaira || 0);
      const db = getDb();
      const pricingSnap = await db.collection("systemSettings").doc("pricing").get();
      const settings = pricingSnap.exists ? pricingSnap.data() : { type: "percent", value: 30, minProfitKobo: 0 };
      const costKobo = moneyToKobo(costNaira);
      let retailKobo = costKobo;
      let profitKobo = 0;

      if (settings.type === "percent") {
        const pct = Number(settings.value || 0) / 100;
        retailKobo = Math.round(costKobo * (1 + pct));
      } else if (settings.type === "fixed") {
        retailKobo = costKobo + moneyToKobo(Number(settings.value || 0));
      } else if (settings.type === "custom") {
        retailKobo = moneyToKobo(Number(settings.value || 0));
      }

      profitKobo = retailKobo - costKobo;
      const min = Number(settings.minProfitKobo || 0);
      if (profitKobo < min) profitKobo = min;
      if (retailKobo < costKobo + min) retailKobo = costKobo + min;

      return jsonResponse(200, { retailKobo, profitKobo, costKobo });
    }

    if (action === "getCategories") {
      await requireAdmin(event);
      const db = getDb();
      const snapshot = await db.collection("categories").get();
      const out = { numbers: false, esim: false, vpn: false, gifts: false, growth: false };
      snapshot.forEach((doc) => { out[doc.id] = !!doc.data().active; });
      return jsonResponse(200, out);
    }

    if (action === "setCategory") {
      await requireAdmin(event);
      const db = getDb();
      await db.collection("categories").doc(String(body.key || "")).set({ active: !!body.enabled }, { merge: true });
      return jsonResponse(200, { ok: true });
    }

    if (action === "listUsers") {
      await requireAdmin(event);
      const db = getDb();
      let query = db.collection("users");
      const q = String(body.q || "").trim().toLowerCase();
      if (q) {
        const snapshot = await query.get();
        const users = snapshot.docs
          .map((d) => ({ uid: d.id, ...d.data() }))
          .filter((u) => (u.email || "").toLowerCase().includes(q));
        return jsonResponse(200, { users });
      }
      const snapshot = await query.orderBy("createdAt", "desc").limit(20).get();
      const users = snapshot.docs.map((d) => ({ uid: d.id, ...d.data() }));
      return jsonResponse(200, { users });
    }

    if (action === "adjust") {
      await requireAdmin(event);
      const db = getDb();
      const uid = body.uid;
      const amount = Number(body.amountNaira || 0);
      const reason = String(body.reason || "").trim();
      const requestId = String(body.requestId || "");
      if (!uid) return jsonResponse(400, { error: "Missing uid" });
      const walletRef = db.collection("wallets").doc(uid);
      const walletSnap = await walletRef.get();
      const balance = walletSnap.exists ? Number(walletSnap.data().balance || 0) : 0;
      const next = balance + moneyToKobo(amount);
      const txRef = db.collection("walletTransactions").doc();
      await walletRef.set({ userId: uid, balance: next, updatedAt: new Date() }, { merge: true });
      await txRef.set({
        userId: uid,
        type: "adjustment",
        amount: moneyToKobo(amount),
        description: reason || "Admin adjustment",
        reference: requestId || txRef.id,
        createdAt: new Date(),
      });
      return jsonResponse(200, { ok: true, balanceAfterKobo: next, duplicate: false });
    }

    if (action === "setUserStatus") {
      await requireAdmin(event);
      const db = getDb();
      const uid = body.uid;
      const status = String(body.status || "active");
      if (!uid) return jsonResponse(400, { error: "Missing uid" });
      await db.collection("users").doc(uid).set({ status }, { merge: true });
      return jsonResponse(200, { ok: true });
    }

    return jsonResponse(400, { error: "Unknown admin action" });
  } catch (error) {
    return jsonResponse(error.status || 500, { error: error.message || "Admin API error" });
  }
};
