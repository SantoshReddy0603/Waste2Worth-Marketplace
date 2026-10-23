import { test } from "node:test";
import assert from "node:assert/strict";
import { canTransition, createDealEngine, dealTotals, supplierRespond, TRANSITIONS } from "../lib/deals.mjs";

function memoryStore(listings) {
  const data = new Map([["listings", new Map(listings.map((item) => [item.id, structuredClone(item)]))], ["deals", new Map()]]);
  return {
    get: (collection, id) => data.get(collection)?.get(id) || null,
    list: (collection) => [...(data.get(collection)?.values() || [])],
    count: (collection) => data.get(collection)?.size || 0,
    async put(collection, id, doc) {
      if (!data.has(collection)) data.set(collection, new Map());
      data.get(collection).set(id, doc);
    },
  };
}

const listing = { id: "ww-t1", title: "Cotton offcuts", category: "textile", unit: "kg", quantity: 300, reserved: 0, priceMinor: 200, floorMinor: 170, freightMinor: 1000, status: "active", supplierId: "sup-a", supplier: "A", autoNegotiate: true, description: "Clean", condition: "Clean · sorted" };
const buyer = { id: "buyer-1", org: "Buyer Co" };

test("totals split fee from supplier net", () => {
  assert.deepEqual(dealTotals(150, 100, 1000, 500), { materialMinor: 15000, freightMinor: 1000, totalMinor: 16000, platformFeeMinor: 800, supplierNetMinor: 15200 });
});

test("supplier agent accepts list price, counters mid-range, declines lowball", () => {
  assert.equal(supplierRespond(listing, 200, 10).decision, "ACCEPTED");
  assert.equal(supplierRespond(listing, 190, 10).decision, "ACCEPTED");
  const counter = supplierRespond(listing, 175, 10);
  assert.equal(counter.decision, "COUNTERED");
  assert.equal(counter.counterUnitMinor, 185);
  assert.equal(supplierRespond(listing, 175, 150).decision, "ACCEPTED", "bulk volume accepts at or above floor");
  assert.equal(supplierRespond(listing, 100, 10).decision, "DECLINED");
});

test("only legal transitions are allowed", () => {
  assert.ok(canTransition("ACCEPTED", "PAID_HELD"));
  assert.ok(!canTransition("NEGOTIATING", "PAID_HELD"));
  assert.ok(!canTransition("SUPPLIER_PAID", "REFUNDED"));
  assert.ok(!canTransition("PAID_HELD", "SUPPLIER_PAID"), "payout must follow pickup confirmation");
  for (const terminal of ["DECLINED", "CANCELLED", "REFUNDED", "SUPPLIER_PAID"]) assert.deepEqual(TRANSITIONS[terminal], []);
});

test("accepted offers reserve stock; payment decrements; refund restocks", async () => {
  const store = memoryStore([listing]);
  const engine = createDealEngine({ store, feeBps: 500 });
  const deal = await engine.makeOffer({ buyer, listingId: "ww-t1", quantity: 100, unitMinor: 200 });
  assert.equal(deal.status, "ACCEPTED");
  assert.equal(store.get("listings", "ww-t1").reserved, 100);
  await engine.transition(deal, "PAID_HELD", "test", "paid");
  assert.equal(store.get("listings", "ww-t1").reserved, 0);
  assert.equal(store.get("listings", "ww-t1").quantity, 200);
  await engine.transition(deal, "REFUNDED", "test", "refund");
  assert.equal(store.get("listings", "ww-t1").quantity, 300);
  await assert.rejects(engine.transition(deal, "PAID_HELD", "test", "again"), /cannot move/);
});

test("cannot reserve more than available stock", async () => {
  const store = memoryStore([listing]);
  const engine = createDealEngine({ store });
  await engine.makeOffer({ buyer, listingId: "ww-t1", quantity: 250, unitMinor: 200 });
  await assert.rejects(engine.makeOffer({ buyer, listingId: "ww-t1", quantity: 100, unitMinor: 200 }), /available/);
});

test("counter then accept uses the counter price", async () => {
  const store = memoryStore([listing]);
  const engine = createDealEngine({ store, feeBps: 0 });
  const deal = await engine.makeOffer({ buyer, listingId: "ww-t1", quantity: 10, unitMinor: 175 });
  assert.equal(deal.status, "COUNTERED");
  const accepted = await engine.acceptCounter(deal);
  assert.equal(accepted.status, "ACCEPTED");
  assert.equal(accepted.totalMinor, 185 * 10 + 1000);
});

test("manual listings wait for the supplier, who can counter", async () => {
  const store = memoryStore([{ ...listing, autoNegotiate: false }]);
  const engine = createDealEngine({ store });
  const deal = await engine.makeOffer({ buyer, listingId: "ww-t1", quantity: 10, unitMinor: 150 });
  assert.equal(deal.status, "NEGOTIATING");
  const countered = await engine.supplierDecision(deal, "COUNTERED", 180);
  assert.equal(countered.status, "COUNTERED");
  assert.equal(countered.counterUnitMinor, 180);
});

test("unsafe or review listings cannot receive offers", async () => {
  const store = memoryStore([{ ...listing, id: "ww-bad", description: "oil-soaked rags" }, { ...listing, id: "ww-rev", status: "review" }]);
  const engine = createDealEngine({ store });
  await assert.rejects(engine.makeOffer({ buyer, listingId: "ww-bad", quantity: 1, unitMinor: 200 }), /not available/);
  await assert.rejects(engine.makeOffer({ buyer, listingId: "ww-rev", quantity: 1, unitMinor: 200 }), /not available/);
});
