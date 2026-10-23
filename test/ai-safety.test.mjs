import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateSafety } from "../lib/safety.mjs";
import { createAI, parseJsonLoose, sanitizeDraft, aiConfigFromEnv } from "../lib/ai.mjs";
import { deriveIntent, rankListings } from "../lib/match.mjs";
import { runAgent } from "../lib/agent.mjs";

test("AI can tighten but never loosen the safety verdict", () => {
  assert.equal(evaluateSafety("oil-soaked cotton rags", "allow").verdict, "block");
  assert.equal(evaluateSafety("clean cotton offcuts", "review").verdict, "review");
  assert.equal(evaluateSafety("clean cotton offcuts", "allow").verdict, "allow");
  assert.equal(evaluateSafety("mixed fabric, needs review", "allow").verdict, "review");
  assert.equal(evaluateSafety("pallet offcuts, lead time two days", undefined).verdict, "allow");
});

test("draft sanitizer rejects unsupported families and clamps fields", () => {
  const draft = sanitizeDraft({ category: "metal", safety: "allow", title: "x".repeat(200), condition: "shiny", likely_uses: ["a", "b", "c", "d", "e"], confidence: "certain" });
  assert.equal(draft.category, "unsupported");
  assert.equal(draft.safety, "review");
  assert.equal(draft.title.length, 70);
  assert.equal(draft.condition, "Mixed · needs review");
  assert.equal(draft.likelyUses.length, 4);
  assert.equal(draft.confidence, "low");
});

test("loose JSON parsing tolerates prose around the object", () => {
  assert.deepEqual(parseJsonLoose('Sure! {"a":1} hope that helps'), { a: 1 });
  assert.equal(parseJsonLoose("no json here"), null);
});

test("provider config defaults to rules without a key and to Groq with one", () => {
  assert.equal(aiConfigFromEnv({}).enabled, false);
  const groq = aiConfigFromEnv({ AI_API_KEY: "k" });
  assert.equal(groq.provider, "groq");
  assert.match(groq.baseUrl, /groq\.com/);
  assert.equal(aiConfigFromEnv({ AI_PROVIDER: "ollama" }).enabled, true, "ollama needs no key");
});

test("listing draft goes through an OpenAI-compatible endpoint", async () => {
  let sent;
  const fetchImpl = async (url, options) => {
    sent = { url, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ abstain: false, title: "Canvas offcuts", category: "textile", subtype: "Cotton canvas", condition: "Clean · sorted", description: "Natural canvas strips.", likely_uses: ["tote bags"], safety: "allow", confidence: "medium" }) } }] }), { status: 200 });
  };
  const ai = createAI({ enabled: true, provider: "groq", baseUrl: "https://example.test/v1", model: "m", visionModel: "v", apiKey: "k" }, { fetchImpl });
  const draft = await ai.listingDraft({ title: "", description: "", imageDataUrl: "data:image/jpeg;base64,AAAA" });
  assert.equal(sent.url, "https://example.test/v1/chat/completions");
  assert.equal(sent.body.model, "v", "photos use the vision model");
  assert.equal(sent.body.messages[1].content[1].type, "image_url");
  assert.equal(draft.category, "textile");
});

const catalog = [
  { id: "a", title: "Cotton jersey offcuts", category: "textile", subtype: "Cotton", description: "Clean knit", uses: ["protective packaging"], unit: "kg", quantity: 400, reserved: 0, priceMinor: 125, floorMinor: 106, freightMinor: 3800, location: "Austin, TX", condition: "Clean · sorted", status: "active", supplier: "S1", autoNegotiate: true },
  { id: "b", title: "Pine trim", category: "wood", subtype: "Pine", description: "Untreated", uses: ["small furniture"], unit: "kg", quantity: 200, reserved: 0, priceMinor: 85, freightMinor: 5200, location: "Dallas, TX", condition: "Clean · untreated", status: "active", supplier: "S2", autoNegotiate: true },
];

test("intent parsing and ranking respect family, quantity and budget", () => {
  const intent = deriveIntent("200 kg cotton for protective packaging under $300 near Austin");
  assert.equal(intent.category, "textile");
  assert.equal(intent.quantity, 200);
  assert.equal(intent.budgetMinor, 30000);
  const ranked = rankListings(catalog, intent);
  assert.equal(ranked[0].id, "a");
  assert.equal(ranked.find((row) => row.id === "b").eligible, false);
});

test("rules agent negotiates within budget and the guard blocks overspending", async () => {
  const offers = [];
  const result = await runAgent({
    brief: "200 kg cotton for packaging under $260",
    buyer: { org: "Buyer" },
    ai: null,
    tools: {
      search: () => [{ ...catalog[0], available: 400, fit: 90, reason: "fit" }],
      getListing: (id) => catalog.find((item) => item.id === id),
      makeOffer: async ({ listingId, quantity, unitMinor }) => {
        offers.push({ quantity, unitMinor });
        return { id: "D-1", status: "ACCEPTED", quantity, unitMinor, listUnitMinor: 125, materialMinor: unitMinor * quantity, freightMinor: 3800, totalMinor: unitMinor * quantity + 3800, rounds: [{ by: "supplier-agent", message: "ok" }] };
      },
      acceptCounter: async () => { throw new Error("unused"); },
    },
  });
  assert.equal(result.provider, "rules");
  assert.equal(result.dealId, "D-1");
  assert.ok(offers[0].unitMinor * 200 + 3800 <= 26000, "offer stays inside the budget");
});

test("LLM agent tool calls are executed and the budget guard rejects an over-budget offer", async () => {
  const replies = [
    { tool_calls: [{ id: "1", function: { name: "search_listings", arguments: JSON.stringify({ need: "cotton", quantity_kg: 200 }) } }] },
    { tool_calls: [{ id: "2", function: { name: "make_offer", arguments: JSON.stringify({ listing_id: "a", quantity_kg: 200, unit_price_usd: 1.25 }) } }] },
    { tool_calls: [{ id: "3", function: { name: "make_offer", arguments: JSON.stringify({ listing_id: "a", quantity_kg: 200, unit_price_usd: 1.0 }) } }] },
    { tool_calls: [{ id: "4", function: { name: "finish", arguments: JSON.stringify({ deal_id: "D-9", summary: "Done" }) } }] },
  ];
  const ai = { config: { enabled: true, provider: "test", model: "m" }, chat: async () => replies.shift() };
  let offerCount = 0;
  const result = await runAgent({
    brief: "200 kg cotton under $250",
    buyer: { org: "Buyer" },
    ai,
    tools: {
      search: () => [{ ...catalog[0], available: 400, fit: 90, reason: "fit" }],
      getListing: (id) => catalog.find((item) => item.id === id),
      makeOffer: async ({ quantity, unitMinor }) => {
        offerCount += 1;
        return { id: "D-9", status: "ACCEPTED", quantity, unitMinor, freightMinor: 3800, totalMinor: unitMinor * quantity + 3800, rounds: [{ by: "supplier-agent", message: "ok" }] };
      },
      acceptCounter: async () => { throw new Error("unused"); },
    },
  });
  assert.equal(offerCount, 1, "the $1.25 offer ($288) was blocked by the $250 guard");
  assert.ok(result.trace.some((step) => step.kind === "guard"));
  assert.equal(result.dealId, "D-9");
  assert.equal(result.summary, "Done");
});
