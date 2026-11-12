import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { cleanText, createRateLimiter, httpError, jsonResponse, normalizeQuantity, nowIso, readJsonBody } from "./lib/util.mjs";
import { evaluateSafety, isListingPurchasable, listingText, permittedCategories } from "./lib/safety.mjs";
import { available, deriveIntent, rankListings } from "./lib/match.mjs";
import { createDealEngine, PAID_STATES } from "./lib/deals.mjs";
import { createPayPal } from "./lib/paypal.mjs";
import { createStore } from "./lib/store.mjs";
import { createSessions, PERSONAS } from "./lib/auth.mjs";
import { aiConfigFromEnv, createAI } from "./lib/ai.mjs";
import { runAgent } from "./lib/agent.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");

function loadLocalEnv() {
  const envPath = path.join(ROOT, ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[1] in process.env) continue;
    process.env[match[1]] = match[2].replace(/^(["'])(.*)\1$/, "$2");
  }
}

loadLocalEnv();

const PORT = Number.parseInt(process.env.PORT || "4173", 10);
const FEE_BPS = Number.parseInt(process.env.PLATFORM_FEE_BPS || "500", 10);
const SUPPLIER_PAYOUT_EMAIL = process.env.SUPPLIER_PAYOUT_EMAIL || "";
const SECURE_COOKIES = process.env.NODE_ENV === "production";

const paypal = createPayPal({
  clientId: process.env.PAYPAL_CLIENT_ID || "",
  clientSecret: process.env.PAYPAL_CLIENT_SECRET || "",
  merchantId: process.env.PAYPAL_MERCHANT_ID || "",
  env: process.env.PAYPAL_ENV === "live" ? "live" : "sandbox",
  webhookId: process.env.PAYPAL_WEBHOOK_ID || "",
});
const ai = createAI(aiConfigFromEnv());
const sessions = createSessions(process.env.SESSION_SECRET);
const store = await createStore({ dataDir: DATA_DIR, databaseUrl: process.env.DATABASE_URL || "" });
const deals = createDealEngine({ store, feeBps: FEE_BPS });
const requirements = JSON.parse(await readFile(path.join(DATA_DIR, "requirements.json"), "utf8"));
const aiLimiter = createRateLimiter({ limit: 12, windowMs: 60_000 });

const DAVIS_LISTINGS = new Set(["ww-001", "ww-013", "ww-023"]);

async function seedCatalog() {
  if (store.count("listings") > 0) return;
  const seeds = JSON.parse(await readFile(path.join(DATA_DIR, "listings.json"), "utf8"));
  for (const seed of seeds) {
    const davis = DAVIS_LISTINGS.has(seed.id);
    await store.put("listings", seed.id, {
      ...seed,
      supplier: davis ? "Davis Reclaim Co." : seed.supplier,
      supplierId: davis ? "sup-davis" : `sup-${seed.supplier.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      status: "active",
      reserved: 0,
      autoNegotiate: true,
      floorMinor: Math.round(seed.priceMinor * 0.85),
      createdAt: "2026-10-01T16:00:00.000Z",
    });
  }
}
await seedCatalog();

function publicListing(listing) {
  return { ...listing, available: available(listing) };
}

function publicDeal(deal) {
  const { createRequestId, captureRequestId, refundRequestId, payoutRequestId, ...paypalPublic } = deal.paypal || {};
  return { ...deal, paypal: paypalPublic };
}

function clientKey(request) {
  return String(request.headers["x-forwarded-for"] || request.socket.remoteAddress || "local").split(",")[0].trim();
}

function requireRole(persona, role) {
  if (persona.role !== role) throw httpError(403, `Switch to the ${role} view to do this.`);
}

function guardAi(request) {
  if (!aiLimiter(clientKey(request))) throw httpError(429, "The AI assistant is busy. Wait a minute and try again.");
}

function findDeal(id, persona) {
  const deal = store.get("deals", id);
  if (!deal) throw httpError(404, "Deal not found.");
  const mine = persona.role === "buyer" ? deal.buyerId === persona.id : deal.supplierId === persona.supplierId;
  if (!mine) throw httpError(403, "This deal belongs to another account.");
  return deal;
}

function searchListings({ need, category, quantity, location, budgetMinor, use = "" }) {
  const intent = { ...deriveIntent(need), ...(category ? { category } : {}), quantity, quantityExplicit: true, location: location || "Austin", budgetMinor: budgetMinor ?? null, use };
  const purchasable = store.list("listings").filter(isListingPurchasable);
  return rankListings(purchasable, intent);
}

// --- Listings & AI assist -------------------------------------------------------------

async function handleCreateListing(request, response, persona) {
  requireRole(persona, "supplier");
  const body = await readJsonBody(request, 1_500_000);
  const title = cleanText(body.title, 70);
  const description = cleanText(body.description, 400);
  const subtype = cleanText(body.subtype, 50, "Supplier described");
  const location = cleanText(body.location, 70);
  const category = cleanText(body.category, 20);
  const unit = cleanText(body.unit, 10);
  const condition = cleanText(body.condition, 40, "Clean · sorted");
  const quantity = Number(body.quantity);
  const priceMinor = Number(body.priceMinor);
  const floorMinor = Number(body.floorMinor) || Math.round(priceMinor * 0.85);
  const uses = (Array.isArray(body.uses) ? body.uses : []).map((use) => cleanText(use, 60)).filter(Boolean).slice(0, 4);

  if (!title || !location || !permittedCategories.has(category) || !["kg", "pieces", "meters"].includes(unit)) {
    return jsonResponse(response, 422, { error: "Add a name, allowed material family, quantity unit and pickup location." });
  }
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 100_000 || !Number.isSafeInteger(priceMinor) || priceMinor < 1 || priceMinor > 100_000_000) {
    return jsonResponse(response, 422, { error: "Quantity or price is outside the supported range." });
  }
  if (!Number.isSafeInteger(floorMinor) || floorMinor < 1 || floorMinor > priceMinor) return jsonResponse(response, 422, { error: "The negotiation floor must be between $0.01 and the list price." });
  if (body.cleanConfirmed !== true) return jsonResponse(response, 422, { error: "Confirm that the material is clean and nonhazardous before listing." });

  const aiVerdict = ["allow", "review", "block"].includes(body.aiSafety) ? body.aiSafety : undefined;
  const safety = evaluateSafety(`${title} ${description} ${subtype} ${condition}`, aiVerdict);
  if (safety.verdict === "block") return jsonResponse(response, 422, { error: `This listing cannot be published: ${safety.reasons.join("; ")}. Only clean, nonhazardous textile, wood and packaging surplus is accepted.` });

  let imageId = null;
  if (typeof body.imageDataUrl === "string" && body.imageDataUrl) {
    const match = body.imageDataUrl.match(/^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/);
    if (!match) return jsonResponse(response, 422, { error: "Photos must be sent as JPEG." });
    imageId = randomUUID();
    await store.putImage(imageId, "image/jpeg", Buffer.from(match[1], "base64"));
  }

  const listing = {
    id: `ww-${randomUUID().slice(0, 8)}`,
    title,
    category,
    subtype,
    description: description || "Supplier-described surplus material. Contact the supplier to confirm fit before purchase.",
    quantity,
    reserved: 0,
    unit,
    priceMinor,
    floorMinor,
    autoNegotiate: body.autoNegotiate !== false,
    freightMinor: 0,
    location,
    condition,
    supplier: persona.org,
    supplierId: persona.supplierId,
    uses,
    accent: category === "textile" ? "sage" : category === "wood" ? "wood" : "paper",
    imageId,
    aiAssisted: body.aiAssisted === true,
    verified: false,
    status: safety.verdict === "review" ? "review" : "active",
    safetyReasons: safety.reasons,
    createdAt: nowIso(),
  };
  await store.put("listings", listing.id, listing);
  return jsonResponse(response, 201, { listing: publicListing(listing) });
}

async function handleListingSettings(request, response, persona, id) {
  requireRole(persona, "supplier");
  const listing = store.get("listings", id);
  if (!listing || listing.supplierId !== persona.supplierId) throw httpError(404, "Listing not found in your workspace.");
  const body = await readJsonBody(request);
  if (typeof body.autoNegotiate === "boolean") listing.autoNegotiate = body.autoNegotiate;
  if (body.floorMinor !== undefined) {
    const floor = Number(body.floorMinor);
    if (!Number.isSafeInteger(floor) || floor < 1 || floor > listing.priceMinor) throw httpError(422, "The floor must be between $0.01 and the list price.");
    listing.floorMinor = floor;
  }
  await store.put("listings", listing.id, listing);
  return jsonResponse(response, 200, { listing: publicListing(listing) });
}

async function handleListingDraft(request, response, persona) {
  requireRole(persona, "supplier");
  const body = await readJsonBody(request, 1_500_000);
  const title = cleanText(body.title, 70);
  const description = cleanText(body.description, 400);
  const imageDataUrl = typeof body.imageDataUrl === "string" && /^data:image\/jpeg;base64,/.test(body.imageDataUrl) ? body.imageDataUrl : "";
  if (!title && !description && !imageDataUrl) return jsonResponse(response, 422, { error: "Add a photo, a name or a short description first." });
  if (!ai.config.enabled) return jsonResponse(response, 200, { provider: "rules", draft: null });
  guardAi(request);
  try {
    const draft = await ai.listingDraft({ title, description, imageDataUrl });
    // Re-apply the server's own rules on top of whatever the model decided.
    const safety = evaluateSafety(`${draft.title} ${draft.description} ${draft.subtype} ${draft.condition} ${title} ${description}`, draft.safety);
    return jsonResponse(response, 200, { provider: `${ai.config.provider} · ${imageDataUrl ? ai.config.visionModel : ai.config.model}`, draft: { ...draft, safety: safety.verdict, safetyReasons: safety.reasons } });
  } catch (error) {
    console.error(`[ai] listing draft failed: ${error.message}`);
    return jsonResponse(response, 200, { provider: "rules", draft: null, notice: "The AI assistant is unavailable right now, so rule-based suggestions are shown." });
  }
}

async function handleMatch(request, response) {
  const body = await readJsonBody(request);
  const query = cleanText(body.query, 300);
  if (!query) throw httpError(422, "Describe a material and what you want to make with it.");
  let intent = deriveIntent(query);
  let provider = "rules";
  let notice = "";
  if (ai.config.enabled) {
    guardAi(request);
    try {
      const extracted = await ai.extractIntent(query);
      intent = {
        ...intent,
        category: extracted.category || intent.category,
        quantity: extracted.quantity || intent.quantity,
        quantityExplicit: Boolean(extracted.quantity) || intent.quantityExplicit,
        budgetMinor: extracted.budgetMinor ?? intent.budgetMinor,
        location: extracted.location || intent.location,
        use: extracted.use,
      };
      provider = `${ai.config.provider} · ${ai.config.model}`;
    } catch (error) {
      console.error(`[ai] intent failed: ${error.message}`);
      notice = "AI unavailable; ranked with rules.";
    }
  }
  const purchasable = store.list("listings").filter(isListingPurchasable);
  const results = rankListings(purchasable, intent);
  if (provider !== "rules") {
    const top = results.filter((row) => row.eligible).slice(0, 8);
    try {
      const byId = new Map(purchasable.map((item) => [item.id, item]));
      const ranking = await ai.rerank(query, top.map((row) => ({ ...byId.get(row.id), available: available(byId.get(row.id)), landed: row.landed })));
      const aiRows = new Map(ranking.map((row) => [row.id, row]));
      for (const row of top) {
        const aiRow = aiRows.get(row.id);
        if (!aiRow) continue;
        row.ruleScore = row.score;
        row.score = Math.max(1, Math.round(row.score * 0.35 + aiRow.fit * 0.65));
        if (aiRow.reason) row.reason = aiRow.reason;
        row.aiRanked = true;
      }
      results.sort((a, b) => Number(b.eligible) - Number(a.eligible) || Number(a.overBudget || 0) - Number(b.overBudget || 0) || b.score - a.score);
    } catch (error) {
      console.error(`[ai] rerank failed: ${error.message}`);
      notice = "AI re-ranking unavailable; showing rule scores.";
    }
  }
  return jsonResponse(response, 200, { intent, results, provider, notice });
}

async function handleAgentRun(request, response, persona) {
  requireRole(persona, "buyer");
  const body = await readJsonBody(request);
  const brief = cleanText(body.brief, 400);
  if (brief.length < 8) throw httpError(422, "Tell the agent what you need, how much and your budget.");
  if (ai.config.enabled) guardAi(request);
  let aiIntent = null;
  if (ai.config.enabled) aiIntent = await ai.extractIntent(brief).catch(() => null);
  const result = await runAgent({
    brief,
    buyer: persona,
    ai: ai.config.enabled ? ai : null,
    aiIntent,
    tools: {
      search: (args) => searchListings(args).filter((row) => row.eligible).slice(0, 5).map((row) => {
        const listing = store.get("listings", row.id);
        return { ...listing, available: available(listing), fit: row.score, reason: row.reason };
      }),
      getListing: (id) => {
        const listing = store.get("listings", id);
        return isListingPurchasable(listing) ? listing : null;
      },
      makeOffer: ({ listingId, quantity, unitMinor, message, dealId }) => deals.makeOffer({ buyer: persona, listingId, quantity, unitMinor, message, via: "buyer-agent", dealId }),
      acceptCounter: (dealId) => deals.acceptCounter(findDeal(dealId, persona), "buyer-agent"),
    },
  });
  const deal = result.dealId ? store.get("deals", result.dealId) : null;
  if (deal) {
    deal.agentSummary = result.summary;
    await deals.save(deal);
  }
  return jsonResponse(response, 200, { ...result, deal: deal ? publicDeal(deal) : null });
}

// --- Deals & PayPal -------------------------------------------------------------------

async function handleCreateDeal(request, response, persona) {
  requireRole(persona, "buyer");
  const body = await readJsonBody(request);
  const deal = await deals.makeOffer({
    buyer: persona,
    listingId: cleanText(body.listingId, 60),
    quantity: normalizeQuantity(body.quantity),
    unitMinor: Number(body.unitMinor),
    message: cleanText(body.message, 160),
    via: "buyer",
  });
  return jsonResponse(response, 201, { deal: publicDeal(deal) });
}

async function refreshPayout(deal) {
  if (deal.status !== "PAYOUT_SENT" || deal.mode !== "paypal" || !deal.paypal.payoutBatchId || !paypal.enabled) return deal;
  try {
    const status = await paypal.payoutStatus(deal.paypal.payoutBatchId);
    deal.paypal.payoutItemStatus = status.itemStatus;
    if (status.itemStatus === "SUCCESS") return deals.transition(deal, "SUPPLIER_PAID", "paypal", "PayPal reports the supplier payout succeeded.", { payoutItemId: status.itemId });
    if (["FAILED", "RETURNED", "BLOCKED", "UNCLAIMED", "REFUNDED"].includes(status.itemStatus)) return deals.transition(deal, "PAYOUT_FAILED", "paypal", `Payout item ${status.itemStatus.toLowerCase()}.`);
  } catch (error) {
    console.error(`[paypal] payout status: ${error.message}`);
  }
  return deal;
}

async function sendSupplierPayout(deal) {
  if (deal.mode !== "paypal") {
    deal.paypal.payoutBatchId = `DEMO-PAYOUT-${randomUUID().slice(0, 8).toUpperCase()}`;
    return deals.transition(deal, "SUPPLIER_PAID", "system", "Demo payout recorded (no PayPal credentials configured, no money moved).");
  }
  if (!SUPPLIER_PAYOUT_EMAIL) throw httpError(503, "Set SUPPLIER_PAYOUT_EMAIL to a Sandbox account to send supplier payouts.");
  const payout = await paypal.sendPayout(deal, SUPPLIER_PAYOUT_EMAIL);
  deal.paypal.payoutBatchId = payout.batchId;
  return deals.transition(deal, "PAYOUT_SENT", "platform", `Payouts API batch ${payout.batchId} sent ${(deal.supplierNetMinor / 100).toFixed(2)} USD to the supplier.`, { batchStatus: payout.batchStatus });
}

async function handleDealAction(request, response, persona, id, action) {
  const deal = findDeal(id, persona);
  const body = await readJsonBody(request);
  let updated = deal;
  switch (action) {
    case "accept-counter":
      requireRole(persona, "buyer");
      updated = await deals.acceptCounter(deal);
      break;
    case "reoffer":
      requireRole(persona, "buyer");
      updated = await deals.makeOffer({ buyer: persona, listingId: deal.listingId, quantity: normalizeQuantity(body.quantity ?? deal.quantity), unitMinor: Number(body.unitMinor), message: cleanText(body.message, 160), dealId: deal.id });
      break;
    case "decision":
      requireRole(persona, "supplier");
      updated = await deals.supplierDecision(deal, cleanText(body.decision, 20), Number(body.counterUnitMinor));
      break;
    case "cancel":
      requireRole(persona, "buyer");
      updated = await deals.transition(deal, "CANCELLED", "buyer", "Buyer cancelled before payment.");
      break;
    case "demo-pay":
      requireRole(persona, "buyer");
      if (paypal.enabled) throw httpError(409, "PayPal Sandbox is configured; pay with PayPal instead.");
      if (deal.status !== "ACCEPTED") throw httpError(409, "Only an accepted deal can be paid.");
      deal.mode = "demo";
      deal.paypal.captureId = `DEMO-${randomUUID().slice(0, 10).toUpperCase()}`;
      updated = await deals.transition(deal, "PAID_HELD", "system", "Demo payment recorded locally. No PayPal transaction and no money moved.");
      break;
    case "paypal-order": {
      requireRole(persona, "buyer");
      if (!paypal.enabled) throw httpError(503, "PayPal Sandbox is not configured.");
      if (deal.status === "PAYMENT_PENDING" && deal.paypal.orderId) return jsonResponse(response, 200, { id: deal.paypal.orderId });
      if (deal.status !== "ACCEPTED") throw httpError(409, "Only an accepted deal can be paid.");
      const order = await paypal.createOrder(deal);
      deal.mode = "paypal";
      deal.paypal.orderId = order.id;
      await deals.transition(deal, "PAYMENT_PENDING", "platform", `PayPal order ${order.id} created for ${(deal.totalMinor / 100).toFixed(2)} USD.`);
      return jsonResponse(response, 201, { id: order.id });
    }
    case "paypal-capture": {
      requireRole(persona, "buyer");
      if (!paypal.enabled) throw httpError(503, "PayPal Sandbox is not configured.");
      if (PAID_STATES.has(deal.status)) break;
      if (deal.status !== "PAYMENT_PENDING") throw httpError(409, "This deal has no PayPal order awaiting capture.");
      const result = await paypal.captureOrder(deal);
      if (!result.ok) {
        await deals.transition(deal, "RECONCILIATION_REQUIRED", "platform", `Capture did not match the expected amount, currency or payee (status ${result.captureStatus}).`);
        throw httpError(409, "PayPal returned a capture that needs reconciliation. No paid receipt was recorded.");
      }
      deal.paypal.captureId = result.captureId;
      updated = await deals.transition(deal, "PAID_HELD", "paypal", `Capture ${result.captureId} verified: amount, currency and payee match. Funds held until pickup.`);
      break;
    }
    case "confirm-pickup":
      requireRole(persona, "buyer");
      updated = await deals.transition(deal, "PICKUP_CONFIRMED", "buyer", "Buyer confirmed pickup and material condition.");
      try {
        updated = await sendSupplierPayout(updated);
      } catch (error) {
        updated = await deals.transition(updated, "PAYOUT_FAILED", "platform", `Payout could not be sent: ${error.message}`);
      }
      break;
    case "retry-payout":
      requireRole(persona, "buyer");
      if (deal.status !== "PAYOUT_FAILED") throw httpError(409, "There is no failed payout to retry.");
      deal.paypal.payoutRequestId = undefined;
      updated = await sendSupplierPayout(deal);
      break;
    case "refund":
      requireRole(persona, "buyer");
      if (deal.status !== "PAID_HELD") throw httpError(409, "Only held payments can be refunded before payout.");
      if (deal.mode === "paypal") {
        const refund = await paypal.refundCapture(deal);
        deal.paypal.refundId = refund.refundId;
        updated = await deals.transition(deal, "REFUNDED", "paypal", `Refund ${refund.refundId} ${String(refund.status).toLowerCase()}. Stock returned to the listing.`);
      } else {
        updated = await deals.transition(deal, "REFUNDED", "system", "Demo refund recorded. Stock returned to the listing.");
      }
      break;
    default:
      throw httpError(404, "Unknown deal action.");
  }
  return jsonResponse(response, 200, { deal: publicDeal(updated) });
}

async function handleWebhook(request, response) {
  const event = await readJsonBody(request, 200_000);
  if (!paypal.enabled || !paypal.webhookConfigured) return jsonResponse(response, 503, { error: "Webhook verification is not configured." });
  const verified = await paypal.verifyWebhook(request.headers, event).catch(() => false);
  if (!verified) return jsonResponse(response, 400, { error: "Signature verification failed." });
  if (store.get("webhooks", event.id)) return jsonResponse(response, 200, { ok: true, duplicate: true });
  await store.put("webhooks", event.id, { id: event.id, type: event.event_type, receivedAt: nowIso() });

  const resource = event.resource || {};
  const all = store.list("deals");
  let deal = null;
  if (event.event_type?.startsWith("PAYMENT.CAPTURE.")) {
    const orderId = resource.supplementary_data?.related_ids?.order_id;
    deal = all.find((item) => item.paypal?.orderId === orderId || item.paypal?.captureId === resource.id || item.id === resource.custom_id);
  } else if (event.event_type?.startsWith("PAYMENT.PAYOUTS-ITEM.")) {
    deal = all.find((item) => item.paypal?.payoutBatchId === resource.payout_batch_id || item.id === resource.payout_item?.sender_item_id);
  }
  if (deal) {
    deals.addEvent(deal, "paypal-webhook", "WEBHOOK", `${event.event_type} (${event.id})`);
    if (event.event_type === "PAYMENT.CAPTURE.COMPLETED" && deal.status === "PAYMENT_PENDING" && resource.amount?.value === (deal.totalMinor / 100).toFixed(2)) {
      deal.paypal.captureId = resource.id;
      await deals.transition(deal, "PAID_HELD", "paypal-webhook", "Capture confirmed by verified webhook.");
    } else if (event.event_type === "PAYMENT.CAPTURE.REFUNDED" && deal.status === "PAID_HELD") {
      await deals.transition(deal, "REFUNDED", "paypal-webhook", "Refund confirmed by verified webhook.");
    } else if (event.event_type === "PAYMENT.PAYOUTS-ITEM.SUCCEEDED" && deal.status === "PAYOUT_SENT") {
      await deals.transition(deal, "SUPPLIER_PAID", "paypal-webhook", "Supplier payout confirmed by verified webhook.");
    } else if (/PAYOUTS-ITEM\.(FAILED|BLOCKED|RETURNED|UNCLAIMED|DENIED)/.test(event.event_type) && deal.status === "PAYOUT_SENT") {
      await deals.transition(deal, "PAYOUT_FAILED", "paypal-webhook", `${event.event_type} received.`);
    } else {
      await deals.save(deal);
    }
  }
  return jsonResponse(response, 200, { ok: true });
}

function stats() {
  const all = store.list("deals");
  const paid = all.filter((deal) => PAID_STATES.has(deal.status));
  const listings = store.list("listings");
  return {
    listedKg: listings.filter((item) => item.status === "active" && item.unit === "kg").reduce((sum, item) => sum + available(item), 0),
    activeListings: listings.filter((item) => item.status === "active").length,
    paidDeals: paid.length,
    paypalDeals: paid.filter((deal) => deal.mode === "paypal").length,
    paidKg: paid.reduce((sum, deal) => sum + deal.quantity, 0),
    paidMinor: paid.reduce((sum, deal) => sum + deal.totalMinor, 0),
    supplierPaidMinor: all.filter((deal) => deal.status === "SUPPLIER_PAID").reduce((sum, deal) => sum + deal.supplierNetMinor, 0),
    savedMinor: paid.reduce((sum, deal) => sum + Math.max(0, deal.listUnitMinor * deal.quantity - deal.materialMinor), 0),
    agentDeals: paid.filter((deal) => deal.via === "buyer-agent").length,
    byCategory: Object.fromEntries(["textile", "wood", "packaging"].map((category) => [category, paid.filter((deal) => deal.category === category).reduce((sum, deal) => sum + deal.quantity, 0)])),
  };
}

// --- HTTP -----------------------------------------------------------------------------

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

// Accepted-but-unpaid deals hold stock; release it if the buyer never pays.
const RESERVATION_TTL_MS = Number.parseInt(process.env.RESERVATION_TTL_MINUTES || "30", 10) * 60_000;
let lastExpirySweep = 0;

async function expireStaleReservations() {
  if (Date.now() - lastExpirySweep < 30_000) return;
  lastExpirySweep = Date.now();
  const cutoff = Date.now() - RESERVATION_TTL_MS;
  for (const deal of store.list("deals")) {
    if (["ACCEPTED", "PAYMENT_PENDING"].includes(deal.status) && Date.parse(deal.updatedAt || deal.createdAt) < cutoff) {
      await deals.transition(deal, "CANCELLED", "system", `Reservation expired after ${RESERVATION_TTL_MS / 60_000} minutes without payment; stock released.`).catch((error) => console.error(`[deals] expiry ${deal.id}: ${error.message}`));
    }
  }
}

async function route(request, response, url) {
  if (url.pathname.startsWith("/api/")) await expireStaleReservations();
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return jsonResponse(response, 400, { error: "Malformed URL." });
  }
  const method = request.method;
  const persona = sessions.persona(request);

  if (method === "GET" && pathname === "/api/health") return jsonResponse(response, 200, { ok: true, service: "waste2worth", storage: store.kind });
  if (method === "GET" && pathname === "/api/config") {
    return jsonResponse(response, 200, {
      paypalEnabled: paypal.enabled,
      paypalClientId: paypal.clientId,
      webhookConfigured: paypal.webhookConfigured,
      payoutsConfigured: Boolean(SUPPLIER_PAYOUT_EMAIL),
      currency: "USD",
      environment: paypal.enabled ? "sandbox" : "demo-only",
      ai: { enabled: ai.config.enabled, provider: ai.config.provider, model: ai.config.model || null, visionModel: ai.config.visionModel || null },
      storage: store.kind,
      feeBps: FEE_BPS,
      personas: PERSONAS,
      persona,
    });
  }
  if (method === "POST" && pathname === "/api/session") {
    const body = await readJsonBody(request);
    const next = PERSONAS.find((item) => item.id === body.personaId);
    if (!next) throw httpError(422, "Unknown persona.");
    return jsonResponse(response, 200, { persona: next }, { "set-cookie": sessions.cookieFor(next.id, SECURE_COOKIES) });
  }
  if (method === "GET" && pathname === "/api/listings") {
    const visible = store.list("listings").filter((item) => item.status === "active" || item.supplierId === persona.supplierId);
    return jsonResponse(response, 200, { listings: visible.map(publicListing) });
  }
  if (method === "POST" && pathname === "/api/listings") return handleCreateListing(request, response, persona);
  const settingsMatch = pathname.match(/^\/api\/listings\/([\w-]+)\/settings$/);
  if (method === "POST" && settingsMatch) return handleListingSettings(request, response, persona, settingsMatch[1]);
  const imageMatch = pathname.match(/^\/api\/images\/([0-9a-f-]{36})$/);
  if (method === "GET" && imageMatch) {
    const image = await store.getImage(imageMatch[1]);
    if (!image) return jsonResponse(response, 404, { error: "Image not found" });
    response.writeHead(200, { "content-type": image.mime, "cache-control": "public, max-age=86400", "x-content-type-options": "nosniff" });
    return response.end(image.data);
  }
  if (method === "GET" && pathname === "/api/requirements") return jsonResponse(response, 200, { requirements });
  if (method === "GET" && pathname === "/api/stats") return jsonResponse(response, 200, stats());
  if (method === "POST" && pathname === "/api/ai/listing-draft") return handleListingDraft(request, response, persona);
  if (method === "POST" && pathname === "/api/match") return handleMatch(request, response);
  if (method === "POST" && pathname === "/api/agent/run") return handleAgentRun(request, response, persona);
  if (method === "GET" && pathname === "/api/deals") {
    const mine = store.list("deals").filter((deal) => (persona.role === "buyer" ? deal.buyerId === persona.id : deal.supplierId === persona.supplierId));
    const refreshed = await Promise.all(mine.map(refreshPayout));
    return jsonResponse(response, 200, { deals: refreshed.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(publicDeal) });
  }
  if (method === "POST" && pathname === "/api/deals") return handleCreateDeal(request, response, persona);
  const dealMatch = pathname.match(/^\/api\/deals\/(D-[A-Z0-9]{8})\/([a-z-]+)$/);
  if (method === "POST" && dealMatch) return handleDealAction(request, response, persona, dealMatch[1], dealMatch[2]);
  if (method === "POST" && pathname === "/api/paypal/webhook") return handleWebhook(request, response);

  if (method === "GET" && !pathname.startsWith("/api/")) {
    const requestedPath = pathname === "/" ? "/index.html" : pathname;
    const filePath = path.resolve(PUBLIC_DIR, `.${requestedPath}`);
    const relative = path.relative(PUBLIC_DIR, filePath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return jsonResponse(response, 403, { error: "Forbidden" });
    try {
      const content = await readFile(filePath);
      response.writeHead(200, {
        "content-type": mimeTypes[path.extname(filePath)] || "application/octet-stream",
        "x-content-type-options": "nosniff",
        "referrer-policy": "strict-origin-when-cross-origin",
        "cache-control": path.extname(filePath) === ".html" ? "no-cache" : "public, max-age=300",
      });
      return response.end(content);
    } catch {
      return jsonResponse(response, 404, { error: "Not found" });
    }
  }
  return jsonResponse(response, method === "GET" ? 404 : 405, { error: method === "GET" ? "Not found" : "Method not allowed" });
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  try {
    await route(request, response, url);
  } catch (error) {
    const status = Number.isInteger(error.status) ? error.status : 500;
    if (status >= 500) console.error(`[waste2worth] ${error.stack || error.message}`);
    if (!response.headersSent) jsonResponse(response, status, { error: status >= 500 && !error.status ? "The request could not be completed. Try again." : error.message });
  }
});

server.listen(PORT, () => {
  console.log(`Waste2Worth is ready at http://localhost:${PORT}`);
  console.log(`Storage: ${store.kind} · AI: ${ai.config.enabled ? `${ai.config.provider} (${ai.config.model})` : "rules only"} · PayPal: ${paypal.enabled ? "Sandbox" : "demo receipts"}${paypal.enabled && !SUPPLIER_PAYOUT_EMAIL ? " (set SUPPLIER_PAYOUT_EMAIL for payouts)" : ""}`);
});
