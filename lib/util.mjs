export function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

export function cleanText(value, maxLength, fallback = "") {
  if (typeof value !== "string") return fallback;
  return value.trim().replace(/[<>\u0000-\u001f]/g, "").slice(0, maxLength);
}

export function normalizeQuantity(value) {
  const quantity = Number(value);
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 100_000) {
    throw httpError(422, "Quantity must be a whole number between 1 and 100,000.");
  }
  return quantity;
}

export function money(minor) {
  return (minor / 100).toFixed(2);
}

export function toMinor(usd) {
  const value = Number(usd);
  if (!Number.isFinite(value) || value <= 0) return NaN;
  return Math.round(value * 100);
}

export function formatUsd(minor) {
  return `$${money(minor)}`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function jsonResponse(response, status, body, headers = {}) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

export async function readJsonBody(request, maxBytes = 24_000) {
  let received = 0;
  const chunks = [];
  for await (const chunk of request) {
    received += chunk.length;
    if (received > maxBytes) throw httpError(413, "Request is too large.");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw httpError(400, "Request body must be valid JSON.");
  }
}

// Fixed-window limiter keyed by client and bucket; enough to keep free AI tiers from being drained.
export function createRateLimiter({ limit, windowMs }) {
  const hits = new Map();
  return function allow(key) {
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || now - entry.start > windowMs) {
      hits.set(key, { start: now, count: 1 });
      return true;
    }
    entry.count += 1;
    return entry.count <= limit;
  };
}
