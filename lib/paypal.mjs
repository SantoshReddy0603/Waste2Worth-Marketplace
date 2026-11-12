import { randomUUID } from "node:crypto";
import { httpError, money } from "./util.mjs";

export function createPayPal({ clientId, clientSecret, merchantId, env = "sandbox", webhookId = "", fetchImpl = fetch }) {
  const base = env === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
  const enabled = env === "sandbox" && Boolean(clientId && clientSecret && merchantId);
  let cachedToken = null;

  async function accessToken() {
    if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;
    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    const response = await fetchImpl(`${base}/v1/oauth2/token`, {
      method: "POST",
      headers: { authorization: `Basic ${auth}`, "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: "grant_type=client_credentials",
      signal: AbortSignal.timeout(15_000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || typeof body.access_token !== "string") throw httpError(502, "PayPal could not authorize this Sandbox request.");
    cachedToken = { value: body.access_token, expiresAt: Date.now() + Number(body.expires_in || 300) * 1000 };
    return cachedToken.value;
  }

  async function request(endpoint, { method = "GET", body, requestId } = {}) {
    const token = await accessToken();
    const response = await fetchImpl(`${base}${endpoint}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json",
        ...(requestId ? { "paypal-request-id": requestId } : {}),
        prefer: "return=representation",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20_000),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = payload?.details?.[0]?.issue || payload?.name || response.status;
      console.error(`[paypal] ${method} ${endpoint} failed: ${detail}`);
      throw httpError(response.status >= 400 && response.status < 500 ? 422 : 502, `PayPal Sandbox rejected the request (${detail}).`);
    }
    return payload;
  }

  // Orders v2: the platform is the payee and holds funds until the buyer confirms pickup.
  async function createOrder(deal) {
    deal.paypal.createRequestId ||= randomUUID();
    deal.paypal.captureRequestId ||= randomUUID();
    const order = await request("/v2/checkout/orders", {
      method: "POST",
      requestId: deal.paypal.createRequestId,
      body: {
        intent: "CAPTURE",
        purchase_units: [{
          payee: { merchant_id: merchantId },
          reference_id: deal.id,
          custom_id: deal.id,
          description: `${deal.quantity} ${deal.unit} of ${deal.listingTitle} via Waste2Worth`.slice(0, 127),
          amount: {
            currency_code: "USD",
            value: money(deal.totalMinor),
            breakdown: {
              item_total: { currency_code: "USD", value: money(deal.materialMinor) },
              shipping: { currency_code: "USD", value: money(deal.freightMinor) },
            },
          },
          items: [{
            name: deal.listingTitle.slice(0, 127),
            description: `Negotiated reuse lot from ${deal.supplierName}`.slice(0, 127),
            unit_amount: { currency_code: "USD", value: money(deal.unitMinor) },
            quantity: String(deal.quantity),
            category: "PHYSICAL_GOODS",
          }],
        }],
      },
    });
    if (!order.id) throw httpError(502, "PayPal did not return an order reference.");
    return order;
  }

  function reconcileCapture(deal, capture, orderState = {}) {
    const captureUnit = capture.purchase_units?.[0];
    const unit = orderState.purchase_units?.[0] || captureUnit;
    const payment = captureUnit?.payments?.captures?.[0] || unit?.payments?.captures?.[0];
    const payeeId = payment?.payee?.merchant_id || unit?.payee?.merchant_id || "";
    const ok = capture.status === "COMPLETED"
      && payment?.status === "COMPLETED"
      && payment?.amount?.currency_code === "USD"
      && payment?.amount?.value === money(deal.totalMinor)
      && payeeId === merchantId;
    return { ok, captureId: payment?.id || "", payeeId, captureStatus: payment?.status || capture.status };
  }

  // The same checks for a capture resource delivered by webhook. Webhook payloads may omit the
  // payee; when it is present it must be the platform account.
  function reconcileCaptureResource(deal, resource = {}) {
    const payeeId = resource.payee?.merchant_id;
    return resource.status === "COMPLETED"
      && resource.amount?.currency_code === "USD"
      && resource.amount?.value === money(deal.totalMinor)
      && (payeeId === undefined || payeeId === merchantId);
  }

  async function captureOrder(deal) {
    const capture = await request(`/v2/checkout/orders/${encodeURIComponent(deal.paypal.orderId)}/capture`, {
      method: "POST",
      requestId: deal.paypal.captureRequestId,
    });
    const orderState = await request(`/v2/checkout/orders/${encodeURIComponent(deal.paypal.orderId)}`).catch(() => ({}));
    return reconcileCapture(deal, capture, orderState);
  }

  async function refundCapture(deal) {
    const refund = await request(`/v2/payments/captures/${encodeURIComponent(deal.paypal.captureId)}/refund`, {
      method: "POST",
      requestId: deal.paypal.refundRequestId ||= randomUUID(),
      body: { note_to_payer: `Refund for Waste2Worth deal ${deal.id}`.slice(0, 255) },
    });
    return { refundId: refund.id, status: refund.status };
  }

  // Payouts API: after pickup, the platform pays the supplier their share minus the platform fee.
  async function sendPayout(deal, receiver) {
    const batch = await request("/v1/payments/payouts", {
      method: "POST",
      requestId: deal.paypal.payoutRequestId ||= randomUUID(),
      body: {
        sender_batch_header: {
          sender_batch_id: `${deal.id}-${Date.now()}`,
          email_subject: "You have a Waste2Worth payout",
          email_message: `Payout for ${deal.quantity} ${deal.unit} of ${deal.listingTitle}.`,
        },
        items: [{
          recipient_type: "EMAIL",
          receiver,
          amount: { value: money(deal.supplierNetMinor), currency: "USD" },
          note: `Waste2Worth deal ${deal.id}: ${money(deal.totalMinor)} paid, ${money(deal.platformFeeMinor)} platform fee.`,
          sender_item_id: deal.id,
        }],
      },
    });
    return { batchId: batch.batch_header?.payout_batch_id || "", batchStatus: batch.batch_header?.batch_status || "PENDING" };
  }

  async function payoutStatus(batchId) {
    const batch = await request(`/v1/payments/payouts/${encodeURIComponent(batchId)}`);
    const item = batch.items?.[0] || {};
    return { batchStatus: batch.batch_header?.batch_status || "", itemStatus: item.transaction_status || "", itemId: item.payout_item_id || "" };
  }

  async function verifyWebhook(headers, event) {
    if (!webhookId) return false;
    const result = await request("/v1/notifications/verify-webhook-signature", {
      method: "POST",
      body: {
        auth_algo: headers["paypal-auth-algo"],
        cert_url: headers["paypal-cert-url"],
        transmission_id: headers["paypal-transmission-id"],
        transmission_sig: headers["paypal-transmission-sig"],
        transmission_time: headers["paypal-transmission-time"],
        webhook_id: webhookId,
        webhook_event: event,
      },
    });
    return result.verification_status === "SUCCESS";
  }

  return { enabled, clientId: enabled ? clientId : null, webhookConfigured: Boolean(webhookId), createOrder, captureOrder, reconcileCapture, reconcileCaptureResource, refundCapture, sendPayout, payoutStatus, verifyWebhook };
}
