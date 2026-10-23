export const permittedCategories = new Set(["textile", "wood", "packaging"]);
export const blockedMaterialText = /\b(chemical|solvent|asbestos|battery|batteries|medical|biohazard|contaminated|oil[- ]soaked|painted|unknown waste|sharps?|lead paint|mercury|pesticide|treated with|creosote|syringe|needle)\b/i;
const reviewText = /\b(mixed|needs review|unknown|stained|damp|wet|mold|mould)\b/i;

const RANK = { allow: 0, review: 1, block: 2 };

export function stricter(a, b) {
  return RANK[a] >= RANK[b] ? a : b;
}

// The rule verdict is a floor: an AI verdict can only make a listing stricter, never looser.
export function evaluateSafety(text, aiVerdict) {
  let verdict = "allow";
  const reasons = [];
  if (blockedMaterialText.test(text)) {
    verdict = "block";
    reasons.push(`Mentions a restricted term ("${text.match(blockedMaterialText)[0]}")`);
  } else if (reviewText.test(text)) {
    verdict = "review";
    reasons.push(`Condition needs a human check ("${text.match(reviewText)[0]}")`);
  }
  if (aiVerdict && aiVerdict in RANK && RANK[aiVerdict] > RANK[verdict]) {
    verdict = aiVerdict;
    reasons.push(`AI assistant flagged this listing as "${aiVerdict}"`);
  }
  return { verdict, reasons };
}

export function listingText(listing) {
  return `${listing.title || ""} ${listing.description || ""} ${listing.subtype || ""} ${listing.condition || ""}`;
}

export function isListingPurchasable(listing) {
  return Boolean(listing) && listing.status === "active" && !blockedMaterialText.test(listingText(listing));
}
