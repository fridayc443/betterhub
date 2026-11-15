const { jsonResponse, requireUser, getDb, readJsonEvent, moneyToKobo, koboToMoney, requireAdmin } = require("./lib/core");

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return jsonResponse(200, { ok: true });
  }

  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "Method not allowed" });
  }

  try {
    const user = await requireUser(event);
    const body = await readJsonEvent(event);

    if (body.action === "bootstrap") {
      const db = getDb();
      const walletRef = db.collection("wallets").doc(user.uid);
      const wallet = await walletRef.get();
      if (!wallet.exists) {
        await walletRef.set({ userId: user.uid, balance: 0, createdAt: new Date() });
      }
      return jsonResponse(200, { ok: true, wallet: { userId: user.uid, balance: wallet.exists ? wallet.data().balance : 0 } });
    }

    return jsonResponse(400, { error: "Unknown customer action" });
  } catch (error) {
    return jsonResponse(error.status || 500, { error: error.message || "Customer API error" });
  }
};
