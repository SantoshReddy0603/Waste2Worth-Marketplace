import { randomUUID } from "node:crypto";
import { httpError, nowIso, formatUsd } from "./util.mjs";
import { available } from "./match.mjs";
import { isListingPurchasable } from "./safety.mjs";

// One deal carries a buyer's offer all the way to the supplier payout.
export const TRANSITIONS = {
  NEGOTIATING: ["ACCEPTED", "COUNTERED", "DECLINED", "CANCELLED"],
  COUNTERED: ["NEGOTIATING", "ACCEPTED", "CANCELLED"],
  ACCEPTED: ["PAYMENT_PENDING", "PAID_HELD", "CANCELLED"],
  PAYMENT_PENDING: ["PAYMENT_PENDING", "PAID_HELD", "RECONCILIATION_REQUIRED", "CANCELLED"],
  PAID_HELD: ["PICKUP_CONFIRMED", "REFUNDED"],
  PICKUP_CONFIRMED: ["PAYOUT_SENT", "SUPPLIER_PAID", "PAYOUT_FAILED"],
  PAYOUT_SENT: ["SUPPLIER_PAID", "PAYOUT_FAILED"],
  PAYOUT_FAILED: ["PAYOUT_SENT", "SUPPLIER_PAID"],
  RECONCILIATION_REQUIRED: ["PAID_HELD", "CANCELLED"],
  DECLINED: [],
  CANCELLED: [],
  REFUNDED: [],
  SUPPLIER_PAID: [],
};

const RESERVING = new Set(["ACCEPTED", "PAYMENT_PENDING", "RECONCILIATION_REQUIRED"]);
export const PAID_STATES = new Set(["PAID_HELD", "PICKUP_CONFIRMED", "PAYOUT_SENT", "PAYOUT_FAILED", "SUPPLIER_PAID"]);

export function canTransition(from, to) {
  return (TRANSITIONS[from] || []).includes(to);
}

export function dealTotals(unitMinor, quantity, freightMinor, feeBps) {
  const materialMinor = unitMinor * quantity;
  const totalMinor = materialMinor + freightMinor;
  const platformFeeMinor = Math.round((totalMinor * feeBps) / 10_000);
  return { materialMinor, freightMinor, totalMinor, platformFeeMinor, supplierNetMinor: totalMinor - platformFeeMinor };
}

export function floorFor(listing) {
  return Number(listing.floorMinor) || Math.round(Number(listing.priceMinor) * 0.85);
}

// Supplier-side negotiation agent: deterministic rules the supplier sets once and can audit.
export function supplierRespond(listing, unitMinor, quantity) {
  const list = Number(listing.priceMinor);
  const floor = floorFor(listing);
  const bulk = quantity >= Math.max(100, Math.round(Number(listing.quantity) * 0.4));
  const midpoint = Math.round((list + floor) / 2);
  if (unitMinor >= list) return { decision: "ACCEPTED", message: "Accepted at the listed price." };
  if (unitMinor >= floor && (bulk || unitMinor >= midpoint)) {
    return { decision: "ACCEPTED", message: bulk ? "Accepted: bulk volume qualifies for this price." : "Accepted: within our negotiable range." };
  }
  if (unitMinor >= Math.round(floor * 0.8)) {
    const counter = bulk ? floor : Math.max(floor, midpoint);
    return { decision: "COUNTERED", counterUnitMinor: counter, message: `We can do ${formatUsd(counter)}/${listing.unit} for ${quantity} ${listing.unit}.` };
  }
  return { decision: "DECLINED", message: `That is below what this lot can sell for. Our best price is ${formatUsd(floor)}/${listing.unit} on bulk orders.` };
}

export function createDealEngine({ store, feeBps = 500, onChange = async () => {} }) {
  function listing(id) {
    return store.get("listings", id);
  }

  function addEvent(deal, actor, type, note, data) {
    deal.history.push({ at: nowIso(), actor, type, note, ...(data ? { data } : {}) });
  }

  async function save(deal) {
    deal.updatedAt = nowIso();
    await store.put("deals", deal.id, deal);
    await onChange(deal);
    return deal;
  }

  async function adjustStock(deal, from, to) {
    const item = listing(deal.listingId);
    if (!item) return;
    const wasReserved = RESERVING.has(from);
    const nowReserved = RESERVING.has(to);
    if (!wasReserved && nowReserved) item.reserved = Number(item.reserved || 0) + deal.quantity;
    if (wasReserved && !nowReserved) item.reserved = Math.max(0, Number(item.reserved || 0) - deal.quantity);
    if (to === "PAID_HELD" && !PAID_STATES.has(from)) item.quantity = Math.max(0, Number(item.quantity) - deal.quantity);
    if (to === "REFUNDED") item.quantity = Number(item.quantity) + deal.quantity;
    await store.put("listings", item.id, item);
  }

  async function transition(deal, to, actor, note, data) {
    if (!canTransition(deal.status, to)) throw httpError(409, `This deal cannot move from ${deal.status} to ${to}.`);
    const from = deal.status;
    if (RESERVING.has(to) && !RESERVING.has(from)) {
      const item = listing(deal.listingId);
      if (!item || deal.quantity > available(item)) throw httpError(409, "There is no longer enough stock for this deal.");
    }
    await adjustStock(deal, from, to);
    deal.status = to;
    addEvent(deal, actor, to, note, data);
    return save(deal);
  }

  function setTerms(deal, unitMinor, item) {
    Object.assign(deal, { unitMinor }, dealTotals(unitMinor, deal.quantity, Number(item.freightMinor) || 0, feeBps));
  }

  async function applySupplierRules(deal, item) {
    if (item.autoNegotiate === false) {
      addEvent(deal, "system", "AWAITING_SUPPLIER", "Supplier reviews offers manually.");
      return save(deal);
    }
    const reply = supplierRespond(item, deal.unitMinor, deal.quantity);
    deal.rounds.push({ by: "supplier-agent", decision: reply.decision, unitMinor: reply.counterUnitMinor || deal.unitMinor, message: reply.message, at: nowIso() });
    if (reply.decision === "COUNTERED") deal.counterUnitMinor = reply.counterUnitMinor;
    return transition(deal, reply.decision, "supplier-agent", reply.message, reply.counterUnitMinor ? { counterUnitMinor: reply.counterUnitMinor } : undefined);
  }

  async function makeOffer({ buyer, listingId, quantity, unitMinor, message = "", via = "buyer", dealId }) {
    const item = listing(listingId);
    if (!isListingPurchasable(item)) throw httpError(404, "This listing is not available for offers.");
    if (item.unit !== "kg") throw httpError(422, "Offers currently support kilogram listings only.");
    if (quantity > available(item)) throw httpError(409, `Only ${available(item)} ${item.unit} are available.`);
    if (!Number.isSafeInteger(unitMinor) || unitMinor < 1 || unitMinor > 10_000_00) throw httpError(422, "Offer price is outside the supported range.");

    let deal = dealId ? store.get("deals", dealId) : null;
    if (deal) {
      if (deal.buyerId !== buyer.id) throw httpError(403, "This deal belongs to another buyer.");
      if (deal.status !== "COUNTERED") throw httpError(409, "You can only re-offer after a counter-offer.");
      deal.quantity = quantity;
      setTerms(deal, unitMinor, item);
      deal.rounds.push({ by: via, decision: "OFFER", unitMinor, message, at: nowIso() });
      await transition(deal, "NEGOTIATING", via, `Revised offer: ${quantity} kg at ${formatUsd(unitMinor)}/kg.`);
    } else {
      deal = {
        id: `D-${randomUUID().slice(0, 8).toUpperCase()}`,
        listingId: item.id,
        listingTitle: item.title,
        category: item.category,
        unit: item.unit,
        supplierId: item.supplierId,
        supplierName: item.supplier,
        buyerId: buyer.id,
        buyerName: buyer.org,
        listUnitMinor: Number(item.priceMinor),
        quantity,
        status: "NEGOTIATING",
        mode: null,
        via,
        rounds: [{ by: via, decision: "OFFER", unitMinor, message, at: nowIso() }],
        history: [],
        paypal: {},
        createdAt: nowIso(),
      };
      setTerms(deal, unitMinor, item);
      addEvent(deal, via, "NEGOTIATING", `Offer: ${quantity} kg at ${formatUsd(unitMinor)}/kg${message ? ` · “${message}”` : ""}`);
      await save(deal);
    }
    return applySupplierRules(deal, item);
  }

  async function acceptCounter(deal, actor = "buyer") {
    if (deal.status !== "COUNTERED" || !deal.counterUnitMinor) throw httpError(409, "There is no counter-offer to accept.");
    const item = listing(deal.listingId);
    setTerms(deal, deal.counterUnitMinor, item);
    deal.rounds.push({ by: actor, decision: "ACCEPTED", unitMinor: deal.counterUnitMinor, message: "Counter accepted.", at: nowIso() });
    return transition(deal, "ACCEPTED", actor, `Accepted the supplier's counter of ${formatUsd(deal.counterUnitMinor)}/kg.`);
  }

  async function supplierDecision(deal, decision, counterUnitMinor) {
    const item = listing(deal.listingId);
    if (deal.status !== "NEGOTIATING") throw httpError(409, "This offer is not waiting for a supplier decision.");
    if (decision === "COUNTERED") {
      if (!Number.isSafeInteger(counterUnitMinor) || counterUnitMinor < 1) throw httpError(422, "Add a counter price.");
      deal.counterUnitMinor = counterUnitMinor;
      deal.rounds.push({ by: "supplier", decision, unitMinor: counterUnitMinor, message: "Supplier countered.", at: nowIso() });
      return transition(deal, "COUNTERED", "supplier", `Supplier countered at ${formatUsd(counterUnitMinor)}/${item.unit}.`, { counterUnitMinor });
    }
    if (!["ACCEPTED", "DECLINED"].includes(decision)) throw httpError(422, "Unknown decision.");
    deal.rounds.push({ by: "supplier", decision, unitMinor: deal.unitMinor, message: `Supplier ${decision.toLowerCase()}.`, at: nowIso() });
    return transition(deal, decision, "supplier", decision === "ACCEPTED" ? "Supplier accepted the offer." : "Supplier declined the offer.");
  }

  return { makeOffer, acceptCounter, supplierDecision, transition, addEvent, save };
}
