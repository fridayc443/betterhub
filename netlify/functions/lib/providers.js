const fetch = globalThis.fetch;

async function providerHealth() {
  const baseUrl = process.env.PROVIDER_BASE_URL;
  if (!baseUrl) {
    return { ok: false, error: "PROVIDER_BASE_URL is not configured." };
  }

  const start = Date.now();
  try {
    const res = await fetch(baseUrl + "/health", { method: "GET" });
    const ms = Date.now() - start;
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}`, ms };
    }
    return { ok: true, ms };
  } catch (error) {
    return { ok: false, error: error.message, ms: Date.now() - start };
  }
}

async function providerCatalog(call, country = "", product = "") {
  const baseUrl = process.env.PROVIDER_BASE_URL;
  if (!baseUrl) {
    return { status: "unconfigured", error: "PROVIDER_BASE_URL is not configured." };
  }

  const headers = { "Content-Type": "application/json" };
  if (process.env.PROVIDER_API_KEY) headers["x-api-key"] = process.env.PROVIDER_API_KEY;

  const start = Date.now();
  try {
    const url = new URL(baseUrl);
    const path = "/" + String(call || "");
    if (country) url.searchParams.set("country", country);
    if (product) url.searchParams.set("product", product);
    const res = await fetch(url.origin + path + url.search, {
      method: "POST",
      headers,
      body: JSON.stringify({ country, product }),
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch (error) { data = text; }
    return { ms: Date.now() - start, status: res.status, ok: res.ok, data, error: res.ok ? null : text || `HTTP ${res.status}` };
  } catch (error) {
    return { ms: Date.now() - start, status: "error", error: error.message, data: null };
  }
}

module.exports = { providerHealth, providerCatalog };
