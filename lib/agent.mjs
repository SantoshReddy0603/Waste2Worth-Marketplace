import { deriveIntent } from "./match.mjs";
import { formatUsd, toMinor } from "./util.mjs";

const MAX_STEPS = 10;

// Models often answer in Markdown; the UI renders plain text.
function plainText(value) {
  return String(value || "").replace(/\*\*|__|`|^#+\s*/gm, "").replace(/\s+/g, " ").trim().slice(0, 600);
}

const TOOL_SPECS = [
  {
    type: "function",
    function: {
      name: "search_listings",
      description: "Search the surplus marketplace. Returns the best-fitting purchasable listings with list price, availability and estimated landed cost.",
      parameters: {
        type: "object",
        properties: {
          need: { type: "string", description: "What the buyer wants to make or the material they need" },
          category: { type: "string", enum: ["textile", "wood", "packaging", ""] },
          quantity_kg: { type: "integer", minimum: 1 },
          location: { type: "string" },
        },
        required: ["need", "quantity_kg"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "make_offer",
      description: "Send a binding offer to the supplier's negotiation agent. The reply is ACCEPTED, COUNTERED (with a counter price) or DECLINED. Pass deal_id to revise an offer after a counter.",
      parameters: {
        type: "object",
        properties: {
          listing_id: { type: "string" },
          quantity_kg: { type: "integer", minimum: 1 },
          unit_price_usd: { type: "number", description: "Offered price per kg in USD" },
          message: { type: "string", description: "Short note to the supplier" },
          deal_id: { type: "string" },
        },
        required: ["listing_id", "quantity_kg", "unit_price_usd"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "accept_counter",
      description: "Accept the supplier's counter-offer on a deal.",
      parameters: { type: "object", properties: { deal_id: { type: "string" } }, required: ["deal_id"] },
    },
  },
  {
    type: "function",
    function: {
      name: "finish",
      description: "End the task. Call once a deal is ACCEPTED (it will be handed to the buyer for PayPal approval), or when no deal fits the constraints.",
      parameters: {
        type: "object",
        properties: { deal_id: { type: "string" }, summary: { type: "string", description: "2-3 plain-text sentences (no Markdown) for the buyer: what was secured, the price versus list, and anything to verify at pickup." } },
        required: ["summary"],
      },
    },
  },
];

function systemPrompt(buyer, guard) {
  return `You are Surplus Agent, a procurement agent acting for ${buyer.org}. You source reusable industrial surplus (clean textile offcuts, untreated wood offcuts, packaging scraps) on the Waste2Worth marketplace and negotiate with suppliers' agents.
Rules:
- Use the tools; do not invent listings, prices or stock.
- Start by searching. Pick the best practical fit, not merely the cheapest.
- Open below the list price (about 85-90% of list) and negotiate for at most 3 rounds. Be courteous and brief in messages.
- ${guard.budgetMinor ? `HARD LIMIT: the total including freight must not exceed ${formatUsd(guard.budgetMinor)}.` : "No budget was given; aim for a fair discount on list."}
- Quantity should be ${guard.quantity} kg unless stock is insufficient.
- You cannot pay. When a deal is ACCEPTED, call finish with its deal_id; the buyer approves payment in PayPal.
- If nothing fits, call finish without a deal_id and explain why.`;
}

export async function runAgent({ brief, buyer, ai, tools, aiIntent }) {
  const ruleIntent = deriveIntent(brief);
  const guard = {
    budgetMinor: aiIntent?.budgetMinor ?? ruleIntent.budgetMinor,
    quantity: aiIntent?.quantity ?? ruleIntent.quantity,
    category: aiIntent?.category || ruleIntent.category,
    location: aiIntent?.location || ruleIntent.location,
  };
  const trace = [];
  const state = { dealId: null, deals: new Map(), searches: 0 };
  const executor = createExecutor({ tools, guard, trace, state, buyer });

  if (ai?.config.enabled) {
    try {
      const result = await llmLoop({ brief, buyer, ai, guard, executor, trace, state });
      return { ...result, trace, provider: `${ai.config.provider} · ${ai.config.model}`, guard };
    } catch (error) {
      trace.push({ kind: "note", label: "Switched to the rules agent", detail: `The AI provider failed (${error.message.slice(0, 120)}). The deterministic agent continues with the same tools.` });
    }
  }
  const result = await rulesAgent({ brief, guard, executor, trace, state });
  return { ...result, trace, provider: "rules", guard };
}

function createExecutor({ tools, guard, trace, state, buyer }) {
  return async function execute(name, args) {
    if (name === "search_listings") {
      state.searches += 1;
      const results = await tools.search({ need: String(args.need || ""), category: args.category || guard.category, quantity: Number(args.quantity_kg) || guard.quantity, location: args.location || guard.location, budgetMinor: guard.budgetMinor });
      trace.push({ kind: "tool", label: "Searched the marketplace", detail: `${results.length} purchasable matches for “${String(args.need || "").slice(0, 80)}”`, data: results.slice(0, 3).map((row) => `${row.title} · ${formatUsd(row.priceMinor)}/kg · ${row.location} · fit ${row.fit}`) });
      return { results: results.map((row) => ({ listing_id: row.id, title: row.title, supplier: row.supplier, location: row.location, list_price_usd_per_kg: row.priceMinor / 100, freight_usd: row.freightMinor / 100, available_kg: row.available, fit: row.fit, reason: row.reason })), ...(state.searches > 1 ? { note: "You have already searched. Make an offer on one of these listings, accept a counter, or call finish if nothing fits the budget." } : {}) };
    }
    if (name === "make_offer") {
      const quantity = Math.round(Number(args.quantity_kg));
      const unitMinor = toMinor(args.unit_price_usd);
      const listing = tools.getListing(String(args.listing_id || ""));
      if (!listing) return { error: "Unknown listing_id. Use an id from search_listings." };
      if (!Number.isSafeInteger(quantity) || quantity < 1) return { error: "quantity_kg must be a positive whole number." };
      if (!Number.isSafeInteger(unitMinor)) return { error: "unit_price_usd must be a positive number." };
      const total = unitMinor * quantity + Number(listing.freightMinor || 0);
      if (guard.budgetMinor && total > guard.budgetMinor) {
        trace.push({ kind: "guard", label: "Budget guard blocked an offer", detail: `${quantity} kg at ${formatUsd(unitMinor)}/kg would total ${formatUsd(total)}, above the ${formatUsd(guard.budgetMinor)} budget.` });
        return { error: `Rejected by budget guard: total ${formatUsd(total)} exceeds budget ${formatUsd(guard.budgetMinor)}. Offer less or choose another listing.` };
      }
      try {
        const deal = await tools.makeOffer({ listingId: listing.id, quantity, unitMinor, message: String(args.message || "").slice(0, 160), dealId: args.deal_id && state.deals.has(args.deal_id) ? args.deal_id : undefined });
        state.deals.set(deal.id, deal);
        const reply = deal.rounds.at(-1);
        trace.push({ kind: "offer", label: `Offered ${formatUsd(unitMinor)}/kg for ${quantity} kg`, detail: `${listing.title} (list ${formatUsd(listing.priceMinor)}/kg)${args.message ? ` · “${String(args.message).slice(0, 120)}”` : ""}` });
        trace.push({ kind: deal.status === "ACCEPTED" ? "accepted" : deal.status === "COUNTERED" ? "counter" : "declined", label: `Supplier agent: ${deal.status.toLowerCase()}`, detail: reply?.by?.startsWith("supplier") ? reply.message : "Waiting for the supplier to review manually." });
        if (deal.status === "ACCEPTED") state.dealId = deal.id;
        return { deal_id: deal.id, status: deal.status, supplier_message: reply?.message || "", counter_unit_price_usd: deal.status === "COUNTERED" ? deal.counterUnitMinor / 100 : undefined, total_usd: deal.totalMinor / 100 };
      } catch (error) {
        return { error: error.message };
      }
    }
    if (name === "accept_counter") {
      const deal = state.deals.get(String(args.deal_id || ""));
      if (!deal) return { error: "Unknown deal_id." };
      const total = deal.counterUnitMinor * deal.quantity + deal.freightMinor;
      if (guard.budgetMinor && total > guard.budgetMinor) return { error: `Rejected by budget guard: accepting would total ${formatUsd(total)}.` };
      try {
        const updated = await tools.acceptCounter(deal.id);
        state.deals.set(updated.id, updated);
        state.dealId = updated.id;
        trace.push({ kind: "accepted", label: `Accepted counter at ${formatUsd(updated.unitMinor)}/kg`, detail: `Total ${formatUsd(updated.totalMinor)} including ${formatUsd(updated.freightMinor)} freight.` });
        return { deal_id: updated.id, status: updated.status, total_usd: updated.totalMinor / 100 };
      } catch (error) {
        return { error: error.message };
      }
    }
    return { error: `Unknown tool ${name}.` };
  };
}

// Open-weight models occasionally emit a malformed or invented tool call, which the provider
// rejects with a 400. Sampling again almost always produces a valid call.
async function chatWithRetry(ai, messages, attempts = 3) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await ai.chat({ messages, tools: TOOL_SPECS, maxTokens: 700 });
    } catch (error) {
      if (attempt >= attempts || !/tool call validation|failed to call a function|tool_use_failed/i.test(error.message)) throw error;
    }
  }
}

async function llmLoop({ brief, buyer, ai, guard, executor, trace, state }) {
  const messages = [
    { role: "system", content: systemPrompt(buyer, guard) },
    { role: "user", content: brief },
  ];
  trace.push({ kind: "plan", label: "Understood the brief", detail: `${guard.quantity} kg${guard.category ? ` of ${guard.category}` : ""}${guard.budgetMinor ? ` · budget ${formatUsd(guard.budgetMinor)}` : ""}${guard.location ? ` · near ${guard.location}` : ""}` });
  for (let step = 0; step < MAX_STEPS; step += 1) {
    const message = await chatWithRetry(ai, messages);
    const calls = message.tool_calls || [];
    messages.push({ role: "assistant", content: message.content || null, ...(calls.length ? { tool_calls: calls } : {}) });
    if (message.content && calls.length) trace.push({ kind: "thought", label: "Reasoning", detail: message.content.slice(0, 280) });
    if (!calls.length) {
      return { dealId: state.dealId, summary: plainText(message.content) || "The agent ended without a summary." };
    }
    for (const call of calls) {
      let args = {};
      try {
        args = JSON.parse(call.function?.arguments || "{}");
      } catch {
        args = {};
      }
      if (call.function?.name === "finish") {
        const dealId = args.deal_id && state.deals.get(args.deal_id)?.status === "ACCEPTED" ? args.deal_id : state.dealId;
        return { dealId, summary: plainText(args.summary) };
      }
      const result = await executor(call.function?.name, args);
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }
  return { dealId: state.dealId, summary: "Reached the step limit. Review the trace for the latest offer." };
}

// Deterministic strategy with the same tools: open at ~88% of list, accept a counter inside budget,
// otherwise try the next best listing.
async function rulesAgent({ brief, guard, executor, trace, state }) {
  trace.push({ kind: "plan", label: "Understood the brief", detail: `${guard.quantity} kg${guard.category ? ` of ${guard.category}` : ""}${guard.budgetMinor ? ` · budget ${formatUsd(guard.budgetMinor)}` : ""} · near ${guard.location}` });
  const { results } = await executor("search_listings", { need: brief, quantity_kg: guard.quantity, category: guard.category, location: guard.location });
  for (const candidate of results.slice(0, 3)) {
    const listMinor = Math.round(candidate.list_price_usd_per_kg * 100);
    const freight = Math.round(candidate.freight_usd * 100);
    const quantity = Math.min(guard.quantity, candidate.available_kg);
    let unitMinor = Math.round(listMinor * 0.88);
    if (guard.budgetMinor) unitMinor = Math.min(unitMinor, Math.floor((guard.budgetMinor - freight) / quantity));
    if (unitMinor < 1) {
      trace.push({ kind: "note", label: `Skipped ${candidate.title}`, detail: "Freight alone uses up the budget." });
      continue;
    }
    const offer = await executor("make_offer", { listing_id: candidate.listing_id, quantity_kg: quantity, unit_price_usd: unitMinor / 100, message: `Hi! We'd like ${quantity} kg for a reuse project and can collect promptly. Could you do ${formatUsd(unitMinor)}/kg?` });
    if (offer.status === "ACCEPTED") return finishRules(state, offer.deal_id, candidate, offer);
    if (offer.status === "COUNTERED") {
      const accepted = await executor("accept_counter", { deal_id: offer.deal_id });
      if (accepted.status === "ACCEPTED") return finishRules(state, accepted.deal_id, candidate, accepted);
    }
    if (offer.status === "NEGOTIATING") {
      return { dealId: null, summary: `Sent an offer on ${candidate.title}; the supplier reviews offers manually. You'll see their reply under Orders.` };
    }
  }
  return { dealId: state.dealId, summary: state.dealId ? "Deal secured." : "No listing could be secured within your constraints. Try a larger budget, smaller quantity or another material." };
}

function finishRules(state, dealId, candidate, result) {
  const deal = state.deals.get(dealId);
  const saved = deal ? deal.listUnitMinor * deal.quantity - deal.materialMinor : 0;
  return {
    dealId,
    summary: `Secured ${deal?.quantity ?? ""} kg of ${candidate.title} from ${candidate.supplier} for ${formatUsd(Math.round(result.total_usd * 100))} including freight${saved > 0 ? `, ${formatUsd(saved)} below list` : ""}. Approve the payment in PayPal; funds are held until you confirm pickup.`,
  };
}
