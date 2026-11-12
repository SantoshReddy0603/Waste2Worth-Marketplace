import { test } from "node:test";
import assert from "node:assert/strict";
import { createPayPal } from "../lib/paypal.mjs";
import { createSessions } from "../lib/auth.mjs";

const deal = { id: "D-TEST0001", quantity: 100, unit: "kg", listingTitle: "Cotton", supplierName: "S", unitMinor: 110, materialMinor: 11000, freightMinor: 3800, totalMinor: 14800, platformFeeMinor: 740, supplierNetMinor: 14060, paypal: { orderId: "ORDER1" } };

function mockFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const path = new URL(url).pathname;
    calls.push({ path, method: options.method || "GET", body: options.body ? (options.body.startsWith("{") ? JSON.parse(options.body) : options.body) : undefined, headers: options.headers });
    if (path === "/v1/oauth2/token") return new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }), { status: 200 });
    const handler = routes[`${options.method || "GET"} ${path}`];
    if (!handler) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(handler(calls.at(-1))), { status: 200 });
  };
  return { fetchImpl, calls };
}

const config = { clientId: "id", clientSecret: "secret", merchantId: "MERCHANT", webhookId: "WH" };

test("order is created for the negotiated amount with the platform as payee", async () => {
  const { fetchImpl, calls } = mockFetch({ "POST /v2/checkout/orders": () => ({ id: "ORDER1" }) });
  const paypal = createPayPal({ ...config, fetchImpl });
  const copy = structuredClone({ ...deal, paypal: {} });
  await paypal.createOrder(copy);
  const unit = calls.find((call) => call.path === "/v2/checkout/orders").body.purchase_units[0];
  assert.equal(unit.amount.value, "148.00");
  assert.equal(unit.amount.breakdown.item_total.value, "110.00");
  assert.equal(unit.items[0].unit_amount.value, "1.10");
  assert.equal(unit.payee.merchant_id, "MERCHANT");
  assert.ok(copy.paypal.createRequestId, "idempotency key stored on the deal");
});

test("capture is accepted only when amount, currency and payee match", async () => {
  const capture = (value, merchant) => ({ status: "COMPLETED", purchase_units: [{ payments: { captures: [{ id: "CAP1", status: "COMPLETED", amount: { currency_code: "USD", value }, payee: { merchant_id: merchant } }] } }] });
  const paypal = createPayPal({ ...config, fetchImpl: async () => new Response("{}") });
  assert.equal(paypal.reconcileCapture(deal, capture("148.00", "MERCHANT")).ok, true);
  assert.equal(paypal.reconcileCapture(deal, capture("1.00", "MERCHANT")).ok, false);
  assert.equal(paypal.reconcileCapture(deal, capture("148.00", "SOMEONE_ELSE")).ok, false);
});

test("webhook captures are reconciled on status, amount, currency and payee", () => {
  const paypal = createPayPal({ ...config, fetchImpl: async () => new Response("{}") });
  const resource = (overrides = {}) => ({ id: "CAP1", status: "COMPLETED", amount: { currency_code: "USD", value: "148.00" }, payee: { merchant_id: "MERCHANT" }, ...overrides });
  assert.equal(paypal.reconcileCaptureResource(deal, resource()), true);
  assert.equal(paypal.reconcileCaptureResource(deal, resource({ payee: undefined })), true, "payee is optional in webhook payloads");
  assert.equal(paypal.reconcileCaptureResource(deal, resource({ status: "PENDING" })), false);
  assert.equal(paypal.reconcileCaptureResource(deal, resource({ amount: { currency_code: "EUR", value: "148.00" } })), false);
  assert.equal(paypal.reconcileCaptureResource(deal, resource({ amount: { currency_code: "USD", value: "14.80" } })), false);
  assert.equal(paypal.reconcileCaptureResource(deal, resource({ payee: { merchant_id: "SOMEONE_ELSE" } })), false);
});

test("payout sends the supplier net amount to the receiver", async () => {
  const { fetchImpl, calls } = mockFetch({ "POST /v1/payments/payouts": () => ({ batch_header: { payout_batch_id: "BATCH1", batch_status: "PENDING" } }) });
  const paypal = createPayPal({ ...config, fetchImpl });
  const result = await paypal.sendPayout(structuredClone(deal), "supplier@example.com");
  const item = calls.find((call) => call.path === "/v1/payments/payouts").body.items[0];
  assert.equal(result.batchId, "BATCH1");
  assert.equal(item.amount.value, "140.60");
  assert.equal(item.receiver, "supplier@example.com");
});

test("webhook verification posts the headers and event to PayPal", async () => {
  const { fetchImpl, calls } = mockFetch({ "POST /v1/notifications/verify-webhook-signature": () => ({ verification_status: "SUCCESS" }) });
  const paypal = createPayPal({ ...config, fetchImpl });
  const ok = await paypal.verifyWebhook({ "paypal-transmission-id": "T", "paypal-transmission-sig": "S", "paypal-transmission-time": "now", "paypal-cert-url": "https://api.paypal.com/cert", "paypal-auth-algo": "SHA256withRSA" }, { id: "WH-EVENT" });
  assert.equal(ok, true);
  const body = calls.at(-1).body;
  assert.equal(body.webhook_id, "WH");
  assert.equal(body.webhook_event.id, "WH-EVENT");
});

test("paypal is disabled without full sandbox credentials", () => {
  assert.equal(createPayPal({ clientId: "a", clientSecret: "", merchantId: "m" }).enabled, false);
  assert.equal(createPayPal({ ...config, env: "live" }).enabled, false, "never live in this demo");
});

test("session cookies are signed and tampering falls back to the default buyer", () => {
  const sessions = createSessions("secret");
  const cookie = sessions.cookieFor("supplier-davis").split(";")[0];
  assert.equal(sessions.persona({ headers: { cookie } }).id, "supplier-davis");
  const forged = cookie.replace(/\.[^.]+$/, ".forged");
  assert.equal(sessions.persona({ headers: { cookie: forged } }).id, "buyer-northwind");
});
