const admin = require("firebase-admin");

function ensureFirebase() {
  if (!admin.apps.length) {
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");

    if (!projectId || !clientEmail || !privateKey) {
      throw new Error("Missing Firebase service account environment variables. Copy .env.example to .env and fill in the values.");
    }

    admin.initializeApp({
      credential: admin.credential.cert({
        project_id: projectId,
        client_email: clientEmail,
        private_key: privateKey,
      }),
      projectId,
    });
  }
  return admin;
}

function getDb() {
  ensureFirebase();
  return admin.firestore();
}

function moneyToKobo(n) {
  const v = Number(n || 0);
  if (!Number.isFinite(v)) return 0;
  return Math.round(v * 100);
}

function koboToMoney(k) {
  const v = Number(k || 0);
  return (v / 100).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function getBearerToken(event) {
  const auth = event.headers && (event.headers.authorization || event.headers.Authorization || "");
  const m = String(auth).match(/Bearer\s+(.+)/i);
  return m ? m[1].trim() : null;
}

async function requireUser(event) {
  ensureFirebase();
  const token = getBearerToken(event);
  if (!token) throw Object.assign(new Error("Missing bearer token."), { status: 401 });

  const decoded = await admin.auth().verifyIdToken(token);
  return decoded;
}

async function requireAdmin(event) {
  const user = await requireUser(event);
  const emails = (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
  const isAdminEmail = !!user.email && emails.includes(user.email.toLowerCase());
  const isAdminClaim = user.role === "admin" || user.claims?.role === "admin";

  if (!isAdminEmail && !isAdminClaim) {
    throw Object.assign(new Error("Admin access required."), { status: 403 });
  }

  if (isAdminEmail && !isAdminClaim) {
    await admin.auth().setCustomUserClaims(user.uid, { ...(user.role ? { role: user.role } : {}), role: "admin" });
  }

  return user;
}

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
    body: JSON.stringify(body),
  };
}

async function readJsonEvent(event) {
  if (!event.body) return {};
  try {
    return JSON.parse(event.body);
  } catch (error) {
    throw Object.assign(new Error("Malformed JSON body."), { status: 400 });
  }
}

module.exports = {
  ensureFirebase,
  getDb,
  moneyToKobo,
  koboToMoney,
  requireUser,
  requireAdmin,
  jsonResponse,
  readJsonEvent,
};
