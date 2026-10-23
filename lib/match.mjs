import { isListingPurchasable } from "./safety.mjs";

const MATERIAL_WORDS = {
  textile: /\b(cotton|fabric|textile|canvas|denim|fleece|felt|wool|linen|jute|cloth|knit|woven|fiber|fibre|upholstery)\b/i,
  wood: /\b(wood|hardwood|timber|lumber|plywood|oak|pine|maple|cedar|walnut|poplar|beech|birch|ash|dowel|joinery|woodturning)\b/i,
  packaging: /\b(kraft|corrugate|corrugated|cardboard|paper|pulp|honeycomb|carton|box|packaging|edge board|shipping insert)\b/i,
};
const CITIES = /\b(Austin|Dallas|Houston|San Antonio|Fort Worth|Round Rock|Waco|San Marcos|El Paso),?\s*(TX)?\b/i;
const STOP_WORDS = new Set(["for", "the", "and", "with", "from", "that", "small", "clean", "material", "need", "want", "use", "using", "prototype", "prototypes", "under", "near", "about", "some"]);

export function deriveIntent(query) {
  const text = String(query || "").trim();
  const category = ["textile", "wood", "packaging"].find((candidate) => MATERIAL_WORDS[candidate].test(text)) || "";
  const quantityMatch = text.match(/\b(\d{1,6})\s*(?:kg|kilos?|kilograms?)\b/i);
  const budgetMatch = text.match(/(?:under|below|budget(?:\s+of)?|less than|max(?:imum)?(?:\s+of)?|up to)\s*\$\s?(\d+(?:\.\d{1,2})?)/i)
    || text.match(/\$\s?(\d+(?:\.\d{1,2})?)\s*(?:max|maximum|budget)/i);
  const locationMatch = text.match(CITIES);
  return {
    text,
    category,
    quantity: quantityMatch ? Number(quantityMatch[1]) : 30,
    quantityExplicit: Boolean(quantityMatch),
    budgetMinor: budgetMatch ? Math.round(Number(budgetMatch[1]) * 100) : null,
    location: locationMatch ? locationMatch[1].replace(/\b\w/g, (part) => part.toUpperCase()) : "Austin",
    use: "",
  };
}

export function tokens(value) {
  return (String(value).toLowerCase().match(/[a-z0-9]+/g) || []).filter((word) => word.length > 2 && !STOP_WORDS.has(word));
}

export function available(listing) {
  return Math.max(0, Number(listing.quantity) - Number(listing.reserved || 0));
}

export function estimateLanded(listing, quantity) {
  return (Number(listing.priceMinor) || 0) * quantity + (Number(listing.freightMinor) || 0);
}

export function scoreListing(listing, intent) {
  const amount = intent.quantity;
  const landed = estimateLanded(listing, amount);
  const blockers = [];
  if (!isListingPurchasable(listing)) blockers.push("Safety evidence needs review");
  if (intent.category && listing.category !== intent.category) blockers.push(`Material family differs from ${intent.category}`);
  if (intent.quantityExplicit && listing.unit !== "kg") blockers.push("Quantity unit does not match your kilogram request");
  if (amount > available(listing)) blockers.push(`Only ${available(listing)} ${listing.unit} available`);
  if (blockers.length) return { id: listing.id, score: 0, blockers, reason: blockers[0], eligible: false, landed };

  const promptTokens = new Set(tokens(`${intent.text} ${intent.use || ""}`));
  const uses = listing.uses || [];
  const listingTokens = new Set(tokens(`${listing.title} ${listing.subtype} ${listing.description} ${uses.join(" ")}`));
  const overlap = [...promptTokens].filter((word) => listingTokens.has(word)).length;
  const matchedUse = uses.find((use) => tokens(use).some((word) => promptTokens.has(word))
    || (use.includes("protective packaging") && /package|shipping|cushion|insert/i.test(intent.text)));
  const useOverlap = uses.filter((use) => tokens(use).some((word) => promptTokens.has(word))).length + (matchedUse ? 1 : 0);
  const condition = String(listing.condition || "").toLowerCase();
  const materialFit = intent.category ? 0.4 : 0.19;
  const applicationFit = Math.min(0.32, useOverlap * 0.12 + Math.min(overlap, 3) * 0.035);
  const attributeFit = condition.includes("clean") || condition.includes("dry") ? 0.14 : 0.07;
  const nearby = String(listing.location).toLowerCase().includes(intent.location.toLowerCase()) ? 0.08 : 0.035;
  const budget = intent.budgetMinor;
  const costFit = budget ? (landed <= budget ? 0.15 : -0.25) : 0.06;
  const score = Math.max(30, Math.min(97, Math.round(((materialFit + applicationFit + attributeFit + 0.09 + nearby + costFit) / 1.18) * 100)));
  let reason = matchedUse ? `Possible use fit: ${matchedUse}` : "Compatible material family and clean supplier-described condition";
  if (nearby > 0.05) reason += ` · near ${intent.location}`;
  // Over budget at list price is still worth surfacing: the agent can negotiate toward the budget.
  if (budget && landed > budget) reason = `List price lands above your $${(budget / 100).toFixed(2)} budget; negotiable`;
  return { id: listing.id, score, blockers, reason, eligible: true, overBudget: Boolean(budget && landed > budget), landed };
}

export function rankListings(listings, intent) {
  return listings
    .map((listing) => scoreListing(listing, intent))
    .sort((a, b) => Number(b.eligible) - Number(a.eligible) || Number(a.overBudget || 0) - Number(b.overBudget || 0) || b.score - a.score);
}
