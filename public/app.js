const CATEGORY_NAMES = { textile: "Textile", wood: "Wood", packaging: "Packaging" };

const CATEGORY_USES = {
  textile: ["protective packaging", "craft prototyping", "upholstery samples", "reusable bags"],
  wood: ["small furniture", "shop fixtures", "display stands", "craft prototyping"],
  packaging: ["protective packaging", "shipping inserts", "product cushioning", "display stands"],
};

const CATEGORY_TERMS = {
  textile: /\b(textile|fabric|cotton|canvas|denim|fleece|felt|wool|linen|jute|cloth|upholstery|knit|woven)\b/i,
  wood: /\b(wood|hardwood|timber|lumber|plywood|oak|pine|maple|cedar|walnut|poplar|birch|dowel)\b/i,
  packaging: /\b(kraft|corrugated|cardboard|paper|pulp|honeycomb|carton|box|packaging)\b/i,
};

const BLOCKED_TEXT = /\b(chemical|solvent|asbestos|battery|batteries|medical|biohazard|contaminated|oil[- ]soaked|sharps?)\b/i;

const CATEGORY_ICONS = {
  textile: '<svg viewBox="0 0 100 72" fill="none" aria-hidden="true"><path d="M21 19 34 10l15 6 14-5 16 11-9 8v29H30V30l-9-11Z" fill="currentColor" opacity=".22"/><path d="m34 11 8 7 8-2 7-3 6 5 12 4-7 8v26H31V30l-9-11 12-8Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M39 19c1 6 6 9 11 9s10-3 11-9M31 31l10 2m27-2-10 2M42 54V41m0 0 5 5m-5-5-5 5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M16 49c5-4 7-4 12 0v12c-5-4-7-4-12 0V49Zm67-2c-5-4-7-4-12 0v13c5-4 7-4 12 0V47Z" fill="currentColor" opacity=".18" stroke="currentColor" stroke-width="1.3"/></svg>',
  wood: '<svg viewBox="0 0 100 72" fill="none" aria-hidden="true"><path d="m20 22 42-8 19 9-43 9-18-10Z" fill="currentColor" opacity=".2"/><path d="m20 22 42-8 19 9-43 9-18-10Zm0 0v28l18 10V32m0 28 43-9V23" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="m27 24 42-8M26 34l9 5m-9 2 9 5m-9 2 9 5m31-27v25m7-26v25" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M51 18c-3 3 1 4-2 7m15 3c-3 3 1 4-2 7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  packaging: '<svg viewBox="0 0 100 72" fill="none" aria-hidden="true"><path d="m22 23 28-13 29 12-29 14-28-13Z" fill="currentColor" opacity=".19"/><path d="m22 23 28-13 29 12-29 14-28-13Zm0 0v30l28 12V36m0 29V36m0 29 29-14V22" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="m37 16 29 12m-23 4v10m10-21v10m7-13v10M32 28v19m8-15v19m8-15v19m16-18v18m8-22v18" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
};

const STATUS_LABELS = {
  NEGOTIATING: ["Awaiting supplier", "pending"],
  COUNTERED: ["Counter-offer", "pending"],
  ACCEPTED: ["Accepted · ready to pay", "ready"],
  DECLINED: ["Declined", "muted"],
  CANCELLED: ["Cancelled", "muted"],
  PAYMENT_PENDING: ["Awaiting PayPal approval", "pending"],
  PAID_HELD: ["Paid · funds held", "paid"],
  PICKUP_CONFIRMED: ["Pickup confirmed", "paid"],
  PAYOUT_SENT: ["Supplier payout sent", "paid"],
  PAYOUT_FAILED: ["Payout failed", "alert"],
  SUPPLIER_PAID: ["Complete · supplier paid", "done"],
  REFUNDED: ["Refunded", "muted"],
  RECONCILIATION_REQUIRED: ["Needs reconciliation", "alert"],
};

const FLOW = ["NEGOTIATING", "ACCEPTED", "PAID_HELD", "PICKUP_CONFIRMED", "SUPPLIER_PAID"];
const FLOW_LABELS = ["Offer", "Agreed", "Paid & held", "Pickup", "Supplier paid"];

let config = { paypalEnabled: false, ai: { enabled: false }, personas: [], persona: { role: "buyer" }, feeBps: 500 };
let listings = [];
let deals = [];
let stats = null;
let activeCategory = "all";
let currentView = "discover";
let matchActive = false;
let matchResults = new Map();
let matchIntent = null;
let photoDataUrl = "";
let lastDraft = null;
let paypalScriptState = "idle";
let paypalButtonsInstance = null;

const $ = (selector) => document.querySelector(selector);
const listingGrid = $("#listing-grid");
const filterPanel = $("#filter-panel");
const filterToggle = $("#filter-toggle");
const detailDialog = $("#detail-dialog");
const checkoutDialog = $("#checkout-dialog");

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function formatMoney(minor) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format((Number(minor) || 0) / 100);
}

function formatCount(value) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(Number(value) || 0);
}

function showToast(message, kind = "success") {
  const toast = document.createElement("div");
  toast.className = `toast ${kind === "error" ? "error" : ""}`;
  toast.textContent = message;
  $("#toast-region").append(toast);
  window.setTimeout(() => toast.remove(), 4200);
}

async function api(url, payload) {
  const response = await fetch(url, payload === undefined
    ? { headers: { accept: "application/json" } }
    : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "The request could not be completed.");
  return result;
}

const isBuyer = () => config.persona.role === "buyer";
const categoryLabel = (category) => CATEGORY_NAMES[category] || "Material";
const categoryIcon = (category) => CATEGORY_ICONS[category] || CATEGORY_ICONS.packaging;
const accentFor = (listing) => (["sage", "wood", "paper", "rose"].includes(listing?.accent) ? listing.accent : "paper");
const findListing = (id) => listings.find((listing) => listing.id === id);
const marketListings = () => listings.filter((listing) => listing.status === "active");
const landed = (listing, quantity) => Number(listing.priceMinor) * quantity + (Number(listing.freightMinor) || 0);

function visualFor(listing, className = "") {
  return listing.imageId
    ? `<img class="listing-photo ${className}" src="/api/images/${escapeHtml(listing.imageId)}" alt="Photo of ${escapeHtml(listing.title)}" loading="lazy" />`
    : `<span class="visual-mark">${categoryIcon(listing.category)}</span>`;
}

// --- Catalog ------------------------------------------------------------------------

function makeListingCard(listing) {
  const result = matchResults.get(listing.id);
  const quantity = matchIntent?.quantity || 30;
  const card = document.createElement("article");
  card.className = "listing-card";
  card.innerHTML = `
    <div class="listing-visual ${accentFor(listing)}">
      ${visualFor(listing)}
      <span class="visual-tag">${escapeHtml(categoryLabel(listing.category))} · ${escapeHtml(listing.subtype || "Supplier described")}</span>
    </div>
    <div class="card-content">
      <div class="card-topline"><span class="material-type">${escapeHtml(listing.supplier)}</span>${listing.autoNegotiate ? '<span class="agent-chip" title="Supplier agent negotiates automatically">⚡ agent</span>' : ""}</div>
      <h3 class="card-title">${escapeHtml(listing.title)}</h3>
      <p class="card-desc">${escapeHtml(listing.description)}</p>
      <div class="card-meta"><span>⌖ <b>${escapeHtml(listing.location)}</b></span><span>▤ <b>${formatCount(listing.available)} ${escapeHtml(listing.unit)}</b> ready</span></div>
      <div class="card-price-row"><div class="price-stack"><span class="price-main">${formatMoney(listing.priceMinor)} <small>/ ${escapeHtml(listing.unit)}</small></span><span class="landed-estimate">~${formatMoney(landed(listing, quantity))} for ${formatCount(quantity)} ${escapeHtml(listing.unit)} landed</span></div>${result?.eligible ? `<span class="match-score">${result.aiRanked ? "✳ AI " : ""}${result.score}% fit</span>` : ""}</div>
      ${result ? `<div class="match-reason">${result.eligible ? escapeHtml(result.reason) : `<span>Not ranked: ${escapeHtml(result.reason)}</span>`}</div>` : ""}
      <div class="card-actions"><button class="card-action" data-action="details" data-id="${escapeHtml(listing.id)}">Details</button>${isBuyer() ? `<button class="card-action buy-action" data-action="buy" data-id="${escapeHtml(listing.id)}">Make an offer <span>↗</span></button>` : ""}</div>
    </div>`;
  return card;
}

function visibleListings() {
  const query = $("#catalog-search").value.trim().toLowerCase();
  const items = marketListings().filter((listing) => {
    if (activeCategory !== "all" && listing.category !== activeCategory) return false;
    if (query && !`${listing.title} ${listing.subtype} ${listing.description} ${listing.location} ${(listing.uses || []).join(" ")} ${listing.supplier}`.toLowerCase().includes(query)) return false;
    if (matchActive && !matchResults.get(listing.id)?.eligible) return false;
    return true;
  });
  const mode = $("#sort-select").value;
  if (mode === "price") return items.sort((a, b) => a.priceMinor - b.priceMinor);
  if (mode === "quantity") return items.sort((a, b) => b.available - a.available);
  if (mode === "new") return items.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  if (matchActive) return items.sort((a, b) => (matchResults.get(b.id)?.score || 0) - (matchResults.get(a.id)?.score || 0));
  return items.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || "") || a.id.localeCompare(b.id));
}

function renderListings() {
  const items = visibleListings();
  listingGrid.replaceChildren();
  $("#listing-result-count").textContent = items.length;
  if (!items.length) {
    listingGrid.innerHTML = `<div class="empty-results"><span class="empty-icon">⌕</span><h3>No materials found</h3><p>Try a broader brief, remove a filter or lower the quantity.</p></div>`;
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const listing of items) fragment.append(makeListingCard(listing));
  listingGrid.append(fragment);
}

async function runMatch(query) {
  const button = $("#match-form button[type=submit]");
  button.disabled = true;
  button.innerHTML = "Ranking…";
  try {
    const result = await api("/api/match", { query });
    matchIntent = result.intent;
    matchActive = true;
    matchResults = new Map(result.results.map((row) => [row.id, row]));
    const eligible = result.results.filter((row) => row.eligible).length;
    const intent = result.intent;
    $("#match-summary").hidden = false;
    $("#match-summary-text").textContent = `${eligible} options for ${formatCount(intent.quantity)} kg${intent.category ? ` of ${intent.category}` : ""}${intent.budgetMinor ? ` · budget ${formatMoney(intent.budgetMinor)}` : ""}${intent.use ? ` · for ${intent.use}` : ""}. Ranked by ${result.provider === "rules" ? "transparent rules" : result.provider}.${result.notice ? ` ${result.notice}` : ""}`;
    activeCategory = intent.category || "all";
    document.querySelectorAll(".category-chip").forEach((chip) => chip.classList.toggle("selected", chip.dataset.category === activeCategory));
    $("#sort-select").value = "match";
    renderListings();
    $("#match-summary").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    button.disabled = false;
    button.innerHTML = "Find matches <span>⌕</span>";
  }
}

// --- Agent ----------------------------------------------------------------------------

const TRACE_ICONS = { plan: "◎", tool: "⌕", offer: "↗", counter: "⇄", accepted: "✓", declined: "×", guard: "⛨", note: "i", thought: "✳" };

function traceItem(step) {
  const li = document.createElement("li");
  li.className = `trace-step trace-${step.kind}`;
  li.innerHTML = `<span class="trace-icon">${TRACE_ICONS[step.kind] || "•"}</span><div><b>${escapeHtml(step.label)}</b><p>${escapeHtml(step.detail || "")}</p>${Array.isArray(step.data) && step.data.length ? `<ul>${step.data.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul>` : ""}</div>`;
  return li;
}

async function runAgent(brief) {
  if (!isBuyer()) return showToast("Switch to the buyer persona to send the agent.", "error");
  const panel = $("#agent-panel");
  const trace = $("#agent-trace");
  const resultBox = $("#agent-result");
  const button = $("#agent-run");
  panel.hidden = false;
  resultBox.hidden = true;
  trace.replaceChildren(traceItem({ kind: "plan", label: "Reading your brief…", detail: brief }));
  trace.firstChild.classList.add("pulse");
  $("#agent-title").textContent = "Surplus Agent is working…";
  panel.scrollIntoView({ behavior: "smooth", block: "start" });
  button.disabled = true;
  button.innerHTML = "Working…";
  try {
    const result = await api("/api/agent/run", { brief });
    trace.replaceChildren();
    for (const step of result.trace) {
      trace.append(traceItem(step));
      await new Promise((resolve) => window.setTimeout(resolve, 420));
    }
    const deal = result.deal;
    $("#agent-title").textContent = deal ? "Deal ready for your approval" : "No deal secured";
    resultBox.innerHTML = `
      <p class="agent-summary">${escapeHtml(result.summary)}</p>
      ${deal ? `<div class="agent-deal"><div><small>Negotiated</small><b>${formatCount(deal.quantity)} kg · ${formatMoney(deal.unitMinor)}/kg</b><span>list ${formatMoney(deal.listUnitMinor)}/kg</span></div><div><small>Total with freight</small><b>${formatMoney(deal.totalMinor)}</b><span>${deal.listUnitMinor > deal.unitMinor ? `saved ${formatMoney((deal.listUnitMinor - deal.unitMinor) * deal.quantity)}` : "at list price"}</span></div><div><small>Supplier</small><b>${escapeHtml(deal.supplierName)}</b><span>${escapeHtml(deal.listingTitle)}</span></div></div>
      <div class="agent-buttons"><button class="primary-button lime" data-pay="${escapeHtml(deal.id)}">Review & approve payment <span>↗</span></button><button class="text-button" data-view="orders">Open in Deals</button></div>` : ""}
      <small class="agent-provider">Agent: ${escapeHtml(result.provider)} · ${result.trace.length} steps · budget guard ${result.guard?.budgetMinor ? formatMoney(result.guard.budgetMinor) : "off"}</small>`;
    resultBox.hidden = false;
    await refreshData();
  } catch (error) {
    trace.replaceChildren(traceItem({ kind: "declined", label: "The agent could not finish", detail: error.message }));
    $("#agent-title").textContent = "Agent stopped";
  } finally {
    button.disabled = false;
    button.innerHTML = "Send agent <span>↗</span>";
  }
}

// --- Listing detail & manual offers -----------------------------------------------

function materialDetail(listing) {
  const uses = (listing.uses || []).slice(0, 4).map((use) => `<span class="detail-pill">${escapeHtml(use)}</span>`).join("");
  detailDialog.innerHTML = `
    <div class="dialog-head"><div><p>MATERIAL DETAILS</p><h2>${escapeHtml(listing.title)}</h2></div><button class="dialog-close" data-close aria-label="Close">×</button></div>
    <div class="dialog-body">
      <div class="detail-summary"><div class="detail-art ${accentFor(listing)}">${visualFor(listing, "detail-photo")}</div><div><h3>${escapeHtml(listing.subtype || "Supplier described")}</h3><p>${escapeHtml(listing.description)}</p></div></div>
      <div class="detail-pills"><span class="detail-pill">${escapeHtml(listing.condition)}</span><span class="detail-pill">${escapeHtml(categoryLabel(listing.category))}</span>${listing.aiAssisted ? '<span class="detail-pill">AI-drafted, supplier-reviewed</span>' : ""}${uses}</div>
      <div class="detail-stats"><div class="detail-stat"><small>Available</small><b>${formatCount(listing.available)} ${escapeHtml(listing.unit)}</b></div><div class="detail-stat"><small>List price</small><b>${formatMoney(listing.priceMinor)} / ${escapeHtml(listing.unit)}</b></div><div class="detail-stat"><small>Pickup</small><b>${escapeHtml(listing.location)}</b></div></div>
      <div class="evidence-note"><b>Evidence & uncertainty</b>Supplier-described demo data. Composition, cleanliness and safety have not been independently verified. Inspect at pickup before confirming; payment is held until you do.</div>
      <div class="dialog-actions"><button class="dialog-secondary" data-close>Close</button>${isBuyer() && listing.status === "active" ? `<button class="dialog-primary" data-action="buy" data-id="${escapeHtml(listing.id)}">Make an offer <span>↗</span></button>` : ""}</div>
    </div>`;
  detailDialog.showModal();
}

function offerDialog(listing) {
  const quantity = Math.min(matchIntent?.quantity || 30, listing.available);
  checkoutDialog.innerHTML = `
    <div class="dialog-head"><div><p>MAKE AN OFFER</p><h2>${escapeHtml(listing.title)}</h2></div><button class="dialog-close" data-close aria-label="Close">×</button></div>
    <div class="dialog-body">
      <div class="checkout-product"><span class="order-thumb ${accentFor(listing)}">${categoryIcon(listing.category)}</span><div><b>${escapeHtml(listing.supplier)}</b><small>${escapeHtml(listing.location)} · ${formatCount(listing.available)} kg available · ${listing.autoNegotiate ? "supplier agent replies instantly" : "supplier reviews manually"}</small></div></div>
      <div class="form-grid" style="margin-top:13px"><label class="field">Quantity (kg)<input id="offer-quantity" type="number" min="1" max="${listing.available}" step="1" value="${quantity}" /></label><label class="field">Your price per kg<div class="money-field"><span>$</span><input id="offer-price" type="number" min="0.01" step="0.01" value="${(listing.priceMinor / 100).toFixed(2)}" /></div></label></div>
      <div class="checkout-lines"><div class="checkout-line"><span>Material</span><strong id="offer-material">—</strong></div><div class="checkout-line"><span>Estimated freight</span><strong>${formatMoney(listing.freightMinor)}</strong></div><div class="checkout-line checkout-total"><span>Total in USD</span><b id="offer-total">—</b></div></div>
      <p class="checkout-caption">List price ${formatMoney(listing.priceMinor)}/kg. Offers at list are accepted immediately; lower offers go to the supplier's negotiation agent.</p>
      <div class="dialog-actions"><button class="dialog-secondary" data-close>Cancel</button><button class="dialog-primary" id="send-offer">Send offer <span>↗</span></button></div>
    </div>`;
  const refresh = () => {
    const qty = Number($("#offer-quantity").value);
    const unit = Math.round(Number($("#offer-price").value) * 100);
    const valid = Number.isSafeInteger(qty) && qty >= 1 && qty <= listing.available && unit > 0;
    $("#offer-material").textContent = valid ? formatMoney(unit * qty) : "—";
    $("#offer-total").textContent = valid ? formatMoney(unit * qty + listing.freightMinor) : "—";
    $("#send-offer").disabled = !valid;
  };
  checkoutDialog.querySelectorAll("input").forEach((input) => input.addEventListener("input", refresh));
  refresh();
  $("#send-offer").addEventListener("click", async () => {
    const button = $("#send-offer");
    button.disabled = true;
    button.textContent = "Sending…";
    try {
      const { deal } = await api("/api/deals", { listingId: listing.id, quantity: Number($("#offer-quantity").value), unitMinor: Math.round(Number($("#offer-price").value) * 100) });
      await refreshData();
      dealOutcomeDialog(deal);
    } catch (error) {
      showToast(error.message, "error");
      button.disabled = false;
      button.innerHTML = "Send offer <span>↗</span>";
    }
  });
  if (!checkoutDialog.open) checkoutDialog.showModal();
}

function dealOutcomeDialog(deal) {
  const reply = deal.rounds.at(-1);
  const bodies = {
    ACCEPTED: `<div class="receipt-state"><span class="receipt-check">✓</span><h2>Offer accepted</h2><p>${escapeHtml(reply?.message || "")}</p><div class="dialog-actions" style="justify-content:center"><button class="dialog-primary" data-pay="${escapeHtml(deal.id)}">Continue to payment <span>↗</span></button></div></div>`,
    COUNTERED: `<div class="receipt-state"><span class="receipt-check counter">⇄</span><h2>The supplier countered</h2><p>${escapeHtml(reply?.message || "")}</p><p>New total: <b>${formatMoney(deal.counterUnitMinor * deal.quantity + deal.freightMinor)}</b></p><div class="dialog-actions" style="justify-content:center"><button class="dialog-secondary" data-view="orders">Decide later</button><button class="dialog-primary" data-deal-action="accept-counter" data-id="${escapeHtml(deal.id)}">Accept ${formatMoney(deal.counterUnitMinor)}/kg</button></div></div>`,
    DECLINED: `<div class="receipt-state"><span class="receipt-check declined">×</span><h2>Offer declined</h2><p>${escapeHtml(reply?.message || "")}</p><div class="dialog-actions" style="justify-content:center"><button class="dialog-primary" data-close>Close</button></div></div>`,
    NEGOTIATING: `<div class="receipt-state"><span class="receipt-check counter">…</span><h2>Sent to the supplier</h2><p>This supplier reviews offers manually. Their reply will appear under Deals.</p><div class="dialog-actions" style="justify-content:center"><button class="dialog-primary" data-view="orders">Open Deals</button></div></div>`,
  };
  checkoutDialog.innerHTML = `<div class="dialog-head"><div><p>DEAL ${escapeHtml(deal.id)}</p><h2>${escapeHtml(deal.listingTitle)}</h2></div><button class="dialog-close" data-close aria-label="Close">×</button></div><div class="dialog-body">${bodies[deal.status] || ""}</div>`;
  if (!checkoutDialog.open) checkoutDialog.showModal();
}

// --- Payment ------------------------------------------------------------------------

function payDialog(deal) {
  const paypalReady = config.paypalEnabled && paypalScriptState === "loaded";
  const notice = config.paypalEnabled
    ? `<div class="paypal-notice"><strong>PayPal Sandbox</strong> Approve in PayPal's window. Waste2Worth captures the payment and holds it; the supplier is paid out through the PayPal Payouts API after you confirm pickup.</div>`
    : `<div class="paypal-notice"><strong>Demo payment mode</strong> No PayPal credentials are configured on this server, so payment and payout are simulated and clearly marked. Add Sandbox keys to use real PayPal checkout.</div>`;
  checkoutDialog.innerHTML = `
    <div class="dialog-head"><div><p>${config.paypalEnabled ? "PAYPAL SANDBOX CHECKOUT" : "DEMO CHECKOUT"}</p><h2>Approve payment</h2></div><button class="dialog-close" data-close aria-label="Close">×</button></div>
    <div class="dialog-body">
      <div class="checkout-product"><span class="order-thumb ${accentFor(findListing(deal.listingId))}">${categoryIcon(deal.category)}</span><div><b>${escapeHtml(deal.listingTitle)}</b><small>${escapeHtml(deal.supplierName)} · deal ${escapeHtml(deal.id)}${deal.via === "buyer-agent" ? " · negotiated by Surplus Agent" : ""}</small></div></div>
      <div class="checkout-lines"><div class="checkout-line"><span>${formatCount(deal.quantity)} kg × ${formatMoney(deal.unitMinor)}${deal.unitMinor < deal.listUnitMinor ? ` <s>${formatMoney(deal.listUnitMinor)}</s>` : ""}</span><strong>${formatMoney(deal.materialMinor)}</strong></div><div class="checkout-line"><span>Estimated freight</span><strong>${formatMoney(deal.freightMinor)}</strong></div><div class="checkout-line checkout-total"><span>Total in USD</span><b>${formatMoney(deal.totalMinor)}</b></div><div class="checkout-line fee-line"><span>Supplier receives after pickup</span><span>${formatMoney(deal.supplierNetMinor)} (fee ${formatMoney(deal.platformFeeMinor)})</span></div></div>
      ${notice}
      ${config.paypalEnabled ? `<div id="paypal-button-container" class="paypal-buttons">${paypalReady ? "" : '<div class="demo-payment-label">Loading PayPal…</div>'}</div>` : `<button class="demo-checkout-button" id="demo-pay">Simulate payment (demo)</button>`}
      <div class="dialog-actions"><button class="dialog-secondary" data-close>Cancel</button></div>
    </div>`;
  if (!checkoutDialog.open) checkoutDialog.showModal();
  checkoutDialog.dataset.dealId = deal.id;
  if (config.paypalEnabled && paypalReady) renderPayPalButtons(deal);
  $("#demo-pay")?.addEventListener("click", async () => {
    try {
      const result = await api(`/api/deals/${deal.id}/demo-pay`, {});
      await refreshData();
      receiptDialog(result.deal);
    } catch (error) {
      showToast(error.message, "error");
    }
  });
}

async function renderPayPalButtons(deal) {
  const container = $("#paypal-button-container");
  if (!container || !window.paypal?.Buttons) return;
  if (paypalButtonsInstance?.close) await paypalButtonsInstance.close().catch(() => {});
  container.replaceChildren();
  paypalButtonsInstance = window.paypal.Buttons({
    style: { layout: "vertical", color: "gold", shape: "rect", label: "paypal", height: 40 },
    createOrder: async () => (await api(`/api/deals/${deal.id}/paypal-order`, {})).id,
    onApprove: async () => {
      try {
        const result = await api(`/api/deals/${deal.id}/paypal-capture`, {});
        await refreshData();
        receiptDialog(result.deal);
      } catch (error) {
        showToast(error.message, "error");
      }
    },
    onCancel: () => showToast("PayPal approval was cancelled. Nothing was charged."),
    onError: (error) => {
      console.error("PayPal button error", error);
      showToast("PayPal Sandbox hit an error. Check the Sandbox app settings.", "error");
    },
  });
  try {
    await paypalButtonsInstance.render("#paypal-button-container");
  } catch (error) {
    console.error("PayPal render error", error);
  }
}

function receiptDialog(deal) {
  const demo = deal.mode !== "paypal";
  checkoutDialog.innerHTML = `
    <div class="dialog-head"><div><p>${demo ? "DEMO PAYMENT RECORDED" : "PAYPAL CAPTURE VERIFIED"}</p><h2>Payment held for pickup</h2></div><button class="dialog-close" data-close aria-label="Close">×</button></div>
    <div class="dialog-body"><div class="receipt-state"><span class="receipt-check">✓</span><h2>${formatMoney(deal.totalMinor)} ${demo ? "recorded" : "captured"}</h2><p>${demo ? "Simulated locally: no PayPal transaction and no money moved." : "The server matched the capture's amount, currency and payee against the deal."} The supplier is paid when you confirm pickup.</p><div class="receipt-ref"><small>${demo ? "DEMO REFERENCE" : "PAYPAL CAPTURE ID"}</small><b>${escapeHtml(deal.paypal.captureId || "")}</b></div><div class="dialog-actions" style="justify-content:center"><button class="dialog-primary" data-view="orders">Go to Deals <span>↗</span></button></div></div></div>`;
}

function loadPayPalSdk() {
  if (!config.paypalEnabled || paypalScriptState !== "idle") return;
  paypalScriptState = "loading";
  const script = document.createElement("script");
  script.src = `https://www.paypal.com/sdk/js?${new URLSearchParams({ "client-id": config.paypalClientId, currency: "USD", intent: "capture", components: "buttons" })}`;
  script.async = true;
  script.onload = () => {
    paypalScriptState = window.paypal?.Buttons ? "loaded" : "error";
    const deal = deals.find((item) => item.id === checkoutDialog.dataset.dealId);
    if (checkoutDialog.open && deal && $("#paypal-button-container")) renderPayPalButtons(deal);
  };
  script.onerror = () => {
    paypalScriptState = "error";
    showToast("Could not load the PayPal SDK.", "error");
  };
  document.head.append(script);
}

// --- Deals --------------------------------------------------------------------------

function flowBar(deal) {
  const index = deal.status === "COUNTERED" ? 0 : FLOW.indexOf(["PAYMENT_PENDING"].includes(deal.status) ? "ACCEPTED" : ["PAYOUT_SENT", "PAYOUT_FAILED"].includes(deal.status) ? "PICKUP_CONFIRMED" : deal.status);
  if (index < 0) return "";
  return `<ol class="flow-bar">${FLOW_LABELS.map((label, position) => `<li class="${position < index ? "done" : position === index ? "current" : ""}">${label}</li>`).join("")}</ol>`;
}

function dealActions(deal) {
  const id = escapeHtml(deal.id);
  if (isBuyer()) {
    switch (deal.status) {
      case "ACCEPTED":
      case "PAYMENT_PENDING":
        return `<button class="primary-button small" data-pay="${id}">Approve payment</button><button class="text-button" data-deal-action="cancel" data-id="${id}">Cancel</button>`;
      case "COUNTERED":
        return `<button class="primary-button small" data-deal-action="accept-counter" data-id="${id}">Accept ${formatMoney(deal.counterUnitMinor)}/kg</button><button class="text-button" data-reoffer="${id}">Counter back</button><button class="text-button" data-deal-action="cancel" data-id="${id}">Walk away</button>`;
      case "NEGOTIATING":
        return `<button class="text-button" data-deal-action="cancel" data-id="${id}">Withdraw offer</button>`;
      case "PAID_HELD":
        return `<button class="primary-button small" data-deal-action="confirm-pickup" data-id="${id}">Confirm pickup & release payout</button><button class="text-button" data-deal-action="refund" data-id="${id}">Problem? Refund</button>`;
      case "PAYOUT_FAILED":
        return `<button class="primary-button small" data-deal-action="retry-payout" data-id="${id}">Retry payout</button>`;
      default:
        return "";
    }
  }
  if (deal.status === "NEGOTIATING") {
    return `<button class="primary-button small" data-decision="ACCEPTED" data-id="${id}">Accept</button><button class="outline-button" data-decision="COUNTERED" data-id="${id}">Counter…</button><button class="text-button" data-decision="DECLINED" data-id="${id}">Decline</button>`;
  }
  return "";
}

function dealCard(deal) {
  const [label, tone] = STATUS_LABELS[deal.status] || [deal.status, "muted"];
  const saved = Math.max(0, (deal.listUnitMinor - deal.unitMinor) * deal.quantity);
  const counterpart = isBuyer() ? deal.supplierName : deal.buyerName;
  const refs = [deal.paypal?.orderId && `Order ${deal.paypal.orderId}`, deal.paypal?.captureId && `Capture ${deal.paypal.captureId}`, deal.paypal?.payoutBatchId && `Payout ${deal.paypal.payoutBatchId}`, deal.paypal?.refundId && `Refund ${deal.paypal.refundId}`].filter(Boolean);
  return `
    <article class="deal-card">
      <div class="deal-top">
        <span class="order-thumb ${accentFor(findListing(deal.listingId))}">${categoryIcon(deal.category)}</span>
        <div class="deal-title"><b>${escapeHtml(deal.listingTitle)}</b><small>${escapeHtml(counterpart)} · ${escapeHtml(deal.id)}${deal.via === "buyer-agent" ? ' · <span class="agent-chip">✳ agent-negotiated</span>' : ""}${deal.mode === "demo" ? ' · <span class="demo-chip">demo payment</span>' : deal.mode === "paypal" ? ' · <span class="pp-chip">PayPal Sandbox</span>' : ""}</small></div>
        <div class="deal-money"><b>${formatMoney(deal.totalMinor)}</b><small>${formatCount(deal.quantity)} kg × ${formatMoney(deal.unitMinor)}${saved ? ` · saved ${formatMoney(saved)}` : ""}</small></div>
        <span class="deal-status ${tone}">${escapeHtml(label)}</span>
      </div>
      ${flowBar(deal)}
      ${deal.agentSummary && ["ACCEPTED", "PAYMENT_PENDING"].includes(deal.status) ? `<p class="deal-note">✳ ${escapeHtml(deal.agentSummary)}</p>` : ""}
      <details class="deal-history"><summary>Audit trail · ${deal.history.length} events${refs.length ? ` · ${escapeHtml(refs.join(" · "))}` : ""}</summary><ol>${deal.history.map((event) => `<li><time>${new Date(event.at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</time><b>${escapeHtml(event.actor)}</b> ${escapeHtml(event.note || event.type)}</li>`).join("")}</ol></details>
      <div class="deal-actions">${dealActions(deal)}</div>
    </article>`;
}

function renderDeals() {
  const paid = deals.filter((deal) => ["PAID_HELD", "PICKUP_CONFIRMED", "PAYOUT_SENT", "PAYOUT_FAILED", "SUPPLIER_PAID"].includes(deal.status));
  const open = deals.filter((deal) => ["NEGOTIATING", "COUNTERED", "ACCEPTED", "PAYMENT_PENDING"].includes(deal.status));
  $("#orders-copy").textContent = isBuyer() ? "Every offer, counter, PayPal capture, pickup and supplier payout, with a full audit trail." : "Deals on your listings: offers, payments held for pickup, and payouts to you.";
  $("#orders-summary").innerHTML = `
    <article class="order-summary-card"><span>Open negotiations</span><b>${open.length}</b></article>
    <article class="order-summary-card"><span>${isBuyer() ? "Paid deals" : "Sold deals"}</span><b>${paid.length}</b></article>
    <article class="order-summary-card"><span>${isBuyer() ? "Saved vs list price" : "Paid out to you"}</span><b>${isBuyer() ? formatMoney(paid.reduce((sum, deal) => sum + Math.max(0, (deal.listUnitMinor - deal.unitMinor) * deal.quantity), 0)) : formatMoney(deals.filter((deal) => deal.status === "SUPPLIER_PAID").reduce((sum, deal) => sum + deal.supplierNetMinor, 0))}</b></article>`;
  $("#deal-list").innerHTML = deals.map(dealCard).join("");
  $("#orders-empty").hidden = deals.length > 0;
  const navCount = $("#nav-deal-count");
  navCount.hidden = !open.length;
  navCount.textContent = open.length;
}

// --- Supplier -----------------------------------------------------------------------

function renderSupplierView() {
  const own = listings.filter((listing) => listing.supplierId === config.persona.supplierId);
  const inbox = deals.filter((deal) => deal.status === "NEGOTIATING");
  const sold = deals.filter((deal) => ["PAID_HELD", "PICKUP_CONFIRMED", "PAYOUT_SENT", "SUPPLIER_PAID"].includes(deal.status));
  $("#seller-stats").innerHTML = `
    <article class="seller-stat"><span>Active listings</span><strong>${own.filter((listing) => listing.status === "active").length}</strong></article>
    <article class="seller-stat"><span>Sold through agents</span><strong>${formatCount(sold.reduce((sum, deal) => sum + deal.quantity, 0))} <small>kg</small></strong></article>
    <article class="seller-stat"><span>Needs safety review</span><strong>${own.filter((listing) => listing.status === "review").length}</strong></article>`;
  $("#inbox-count").textContent = inbox.length;
  const badge = $("#nav-inbox-count");
  badge.hidden = !inbox.length;
  badge.textContent = inbox.length;
  $("#offer-inbox").innerHTML = inbox.length ? inbox.map(dealCard).join("") : `<div class="empty-results slim"><p>No offers waiting. Listings with auto-negotiate on are answered by your agent instantly.</p></div>`;
  $("#seller-listing-count").textContent = own.length;
  $("#seller-list").innerHTML = own.length ? own.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || "")).map((listing) => `
    <article class="seller-row">
      <span class="seller-thumb ${accentFor(listing)}">${listing.imageId ? `<img src="/api/images/${escapeHtml(listing.imageId)}" alt="" />` : listing.category === "textile" ? "⌁" : listing.category === "wood" ? "▱" : "▤"}</span>
      <div class="seller-product"><b>${escapeHtml(listing.title)}</b><small>${escapeHtml(categoryLabel(listing.category))} · ${escapeHtml(listing.subtype || "Supplier described")}${listing.status === "review" ? ` · ${escapeHtml((listing.safetyReasons || []).join("; ") || "needs review")}` : ""}</small></div>
      <div class="seller-cell"><b>${formatCount(listing.available)} ${escapeHtml(listing.unit)}</b><small>${listing.reserved ? `${formatCount(listing.reserved)} reserved` : "available"}</small></div>
      <div class="seller-cell"><b>${formatMoney(listing.priceMinor)}</b><small>floor ${formatMoney(listing.floorMinor)}</small></div>
      <label class="auto-toggle"><input type="checkbox" data-auto="${escapeHtml(listing.id)}" ${listing.autoNegotiate ? "checked" : ""} /> <span>Agent</span></label>
      <span class="status-chip ${listing.status === "review" ? "review" : ""}">${listing.status === "review" ? "Needs review" : "Live"}</span>
    </article>`).join("") : `<div class="empty-results"><span class="empty-icon">▧</span><h3>Your first listing starts here</h3><p>Snap a photo of your surplus and let the AI draft it.</p><button class="primary-button" data-view="new-listing">＋ Post a material</button></div>`;
}

// --- New listing with AI draft ------------------------------------------------------

async function resizePhoto(file) {
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) throw new Error("That image format could not be read. Try a JPEG or PNG.");
  const scale = Math.min(1, 1024 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.8);
}

function rulesDraft() {
  const text = `${$("#listing-title").value} ${$("#listing-description").value}`;
  const category = $("#listing-category").value || ["textile", "wood", "packaging"].find((candidate) => CATEGORY_TERMS[candidate].test(text)) || "";
  return {
    rules: true,
    category: category || "unsupported",
    likelyUses: category ? CATEGORY_USES[category].slice(0, 3) : [],
    safety: BLOCKED_TEXT.test(text) ? "block" : "allow",
    safetyReasons: BLOCKED_TEXT.test(text) ? ["Mentions a restricted material"] : [],
    unknowns: ["composition", "contamination history", "exact dimensions"],
    confidence: category ? "medium" : "low",
  };
}

async function suggestDetails() {
  const button = $("#enrich-button");
  button.disabled = true;
  button.textContent = photoDataUrl ? "Looking at the photo…" : "Drafting…";
  try {
    const result = await api("/api/ai/listing-draft", { title: $("#listing-title").value, description: $("#listing-description").value, imageDataUrl: photoDataUrl });
    lastDraft = result.draft ? { ...result.draft, provider: result.provider } : rulesDraft();
    if (result.notice) showToast(result.notice, "error");
    renderDraft(lastDraft);
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    button.disabled = false;
    button.innerHTML = "Suggest details <span>↗</span>";
  }
}

function renderDraft(draft) {
  const box = $("#suggestion-box");
  const safetyText = { allow: "No safety concerns noted", review: "Needs human review before it can be sold", block: "Cannot be listed" }[draft.safety];
  const list = (items) => (items || []).map((item) => `<span class="detail-pill">${escapeHtml(item)}</span>`).join("");
  box.className = `suggestion-box draft-${draft.safety}`;
  box.innerHTML = draft.abstain
    ? `<b>The assistant abstained</b><p>${escapeHtml(draft.abstainReason || "The photo and notes were not clear enough to describe safely.")} Add a clearer photo or describe the material.</p>`
    : `<div class="draft-head"><b>${draft.rules ? "Rule-based suggestion" : `AI draft · ${escapeHtml(draft.provider)}`}</b><span class="draft-confidence">${escapeHtml(draft.confidence)} confidence</span></div>
      ${draft.title ? `<p class="draft-title">${escapeHtml(draft.title)}</p>` : ""}${draft.description ? `<p>${escapeHtml(draft.description)}</p>` : ""}
      <p><b>Family:</b> ${escapeHtml(draft.category === "unsupported" ? "not a supported family" : categoryLabel(draft.category))}${draft.subtype ? ` · ${escapeHtml(draft.subtype)}` : ""}${draft.condition ? ` · ${escapeHtml(draft.condition)}` : ""}</p>
      ${draft.visibleAttributes?.length ? `<div class="draft-row"><small>Visible</small>${list(draft.visibleAttributes)}</div>` : ""}
      ${draft.likelyUses?.length ? `<div class="draft-row"><small>Likely uses</small>${list(draft.likelyUses)}</div>` : ""}
      ${draft.unknowns?.length ? `<div class="draft-row"><small>Buyer should confirm</small>${list(draft.unknowns)}</div>` : ""}
      <p class="draft-safety"><b>Safety:</b> ${escapeHtml(safetyText)}${draft.safetyReason ? ` · ${escapeHtml(draft.safetyReason)}` : ""}${draft.safetyReasons?.length ? ` · ${escapeHtml(draft.safetyReasons.join("; "))}` : ""}</p>
      ${draft.safety !== "block" && draft.category !== "unsupported" ? `<button type="button" class="outline-button" id="apply-draft">Apply to form</button>` : ""}`;
  box.hidden = false;
  $("#apply-draft")?.addEventListener("click", () => {
    if (draft.title) $("#listing-title").value = draft.title;
    if (draft.category && draft.category !== "unsupported") $("#listing-category").value = draft.category;
    if (draft.subtype) $("#listing-subtype").value = draft.subtype;
    if (draft.description) $("#listing-description").value = draft.description;
    if (draft.condition) $("#listing-condition").value = draft.condition;
    showToast("Draft applied. Review and edit every field before publishing.");
  });
}

async function submitNewListing(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const button = form.querySelector("button[type=submit]");
  button.disabled = true;
  button.textContent = "Publishing…";
  const priceMinor = Math.round(Number($("#listing-price").value) * 100);
  const floorValue = Number($("#listing-floor").value);
  try {
    const result = await api("/api/listings", {
      title: $("#listing-title").value.trim(),
      category: $("#listing-category").value,
      subtype: $("#listing-subtype").value.trim() || "Supplier described",
      description: $("#listing-description").value.trim(),
      quantity: Number($("#listing-quantity").value),
      unit: $("#listing-unit").value,
      priceMinor,
      floorMinor: floorValue > 0 ? Math.round(floorValue * 100) : Math.round(priceMinor * 0.85),
      location: $("#listing-location").value.trim(),
      condition: $("#listing-condition").value,
      autoNegotiate: $("#listing-auto").checked,
      cleanConfirmed: $("#clean-declaration").checked,
      imageDataUrl: photoDataUrl,
      uses: lastDraft?.likelyUses || [],
      aiSafety: lastDraft && !lastDraft.rules ? lastDraft.safety : undefined,
      aiAssisted: Boolean(lastDraft && !lastDraft.rules),
    });
    form.reset();
    photoDataUrl = "";
    lastDraft = null;
    $("#photo-preview").hidden = true;
    $("#photo-filename").textContent = "";
    $("#suggestion-box").hidden = true;
    await refreshData();
    setView("listings");
    showToast(result.listing.status === "review" ? "Saved for safety review; buyers cannot see it yet." : "Your material is live. Buyer agents can now find it.");
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    button.disabled = false;
    button.innerHTML = "Review & publish <span>↗</span>";
  }
}

// --- Impact & chrome ----------------------------------------------------------------

function renderImpact() {
  if (!stats) return;
  $("#impact-potential").innerHTML = `${formatCount(stats.paidKg)} <small>kg</small>`;
  $("#impact-sub").textContent = `${stats.paidDeals} paid reuse deals${stats.agentDeals ? `, ${stats.agentDeals} negotiated by the agent` : ""}. ${formatCount(stats.listedKg)} kg more is listed and available.`;
  $("#impact-cards").innerHTML = `
    <article class="impact-card"><span>Buyer payments captured</span><strong>${formatMoney(stats.paidMinor)}</strong><small>${stats.paypalDeals} via PayPal Sandbox · ${stats.paidDeals - stats.paypalDeals} demo</small></article>
    <article class="impact-card"><span>Paid out to suppliers</span><strong>${formatMoney(stats.supplierPaidMinor)}</strong><small>Payouts API after pickup</small></article>
    <article class="impact-card"><span>Buyer savings vs list</span><strong>${formatMoney(stats.savedMinor)}</strong><small>From negotiated deals</small></article>
    ${["textile", "wood", "packaging"].map((category) => `<article class="impact-card"><span>${categoryLabel(category)} reused</span><strong>${formatCount(stats.byCategory[category])} kg</strong><small>Paid deal quantities</small></article>`).join("")}`;
}

function updateChrome() {
  const persona = config.persona;
  document.body.dataset.role = persona.role;
  $("#user-avatar").textContent = persona.initials;
  $("#user-name").textContent = persona.name;
  $("#user-org").textContent = `${persona.org} · ${persona.role}`;
  $("#role-select").innerHTML = config.personas.map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === persona.id ? "selected" : ""}>${item.role === "buyer" ? "Buyer" : "Supplier"} · ${escapeHtml(item.org)}</option>`).join("");
  const aiLabel = config.ai.enabled ? `${config.ai.provider} · ${String(config.ai.model).split("/").pop()}` : "rules (no key)";
  $("#ai-pill").innerHTML = `<i class="${config.ai.enabled ? "on" : ""}"></i> AI: ${escapeHtml(aiLabel)}`;
  $("#agent-provider").textContent = config.ai.enabled ? escapeHtml(config.ai.provider.toUpperCase()) : "RULES";
  $("#paypal-pill").innerHTML = `<i class="${config.paypalEnabled ? "on" : ""}"></i> ${config.paypalEnabled ? "PayPal Sandbox" : "Demo payments"}`;
  $("#enrich-caption").textContent = config.ai.enabled ? `Uses ${config.ai.visionModel ? "a vision model on your photo" : "your notes"} plus your notes. It never verifies composition or safety.` : "No AI key on this server, so suggestions are rule-based.";
  const market = marketListings();
  $("#metric-materials").textContent = market.length;
  $("#nav-listing-count").textContent = market.length;
  $("#metric-kg").innerHTML = `${(market.filter((listing) => listing.unit === "kg").reduce((sum, listing) => sum + listing.available, 0) / 1000).toFixed(1)}<span>t</span>`;
  $("#metric-deals").textContent = stats?.paidDeals ?? 0;
}

async function refreshData() {
  const [catalog, dealData, statData] = await Promise.all([api("/api/listings"), api("/api/deals"), api("/api/stats")]);
  listings = catalog.listings;
  deals = dealData.deals;
  stats = statData;
  updateChrome();
  renderListings();
  renderDeals();
  renderImpact();
  if (!isBuyer()) renderSupplierView();
}

function setView(view) {
  if (!document.querySelector(`#view-${CSS.escape(view)}`)) view = "discover";
  if (isBuyer() && ["listings", "new-listing"].includes(view)) view = "discover";
  currentView = view;
  document.querySelectorAll(".view").forEach((section) => section.classList.toggle("active", section.id === `view-${view}`));
  const labels = { discover: "Discover", listings: "My listings", "new-listing": "Post a material", orders: "Deals", impact: "Impact" };
  $("#crumb-current").textContent = labels[view];
  document.querySelectorAll(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  if (view === "listings") renderSupplierView();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function switchPersona(personaId) {
  try {
    const { persona } = await api("/api/session", { personaId });
    config.persona = persona;
    matchActive = false;
    matchResults.clear();
    $("#match-summary").hidden = true;
    $("#agent-panel").hidden = true;
    await refreshData();
    setView(persona.role === "supplier" ? "listings" : "discover");
    showToast(persona.role === "supplier" ? `Now acting as ${persona.org} (supplier).` : `Now acting as ${persona.org} (buyer).`);
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function dealAction(id, action, payload = {}) {
  try {
    const { deal } = await api(`/api/deals/${id}/${action}`, payload);
    await refreshData();
    if (checkoutDialog.open) {
      if (deal.status === "ACCEPTED") payDialog(deal);
      else checkoutDialog.close();
    }
    const messages = {
      SUPPLIER_PAID: `Pickup confirmed. ${formatMoney(deal.supplierNetMinor)} paid out to the supplier.`,
      PAYOUT_SENT: `Pickup confirmed. PayPal payout of ${formatMoney(deal.supplierNetMinor)} sent to the supplier.`,
      PAYOUT_FAILED: "Pickup confirmed, but the payout failed. See the audit trail.",
      REFUNDED: "Refund issued and stock returned to the listing.",
      ACCEPTED: "Deal accepted.",
      COUNTERED: "Counter-offer sent.",
      DECLINED: "Offer declined.",
      CANCELLED: "Deal cancelled.",
      NEGOTIATING: "Revised offer sent.",
    };
    showToast(messages[deal.status] || `Deal is now ${deal.status.toLowerCase()}.`, deal.status === "PAYOUT_FAILED" ? "error" : "success");
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function initialize() {
  try {
    config = await api("/api/config");
    await refreshData();
    setView(isBuyer() ? "discover" : "listings");
    loadPayPalSdk();
  } catch (error) {
    showToast("The app server is unavailable. Run npm start to load the marketplace.", "error");
  }
}

// --- Events -------------------------------------------------------------------------

document.addEventListener("click", (event) => {
  const target = event.target;
  const viewButton = target.closest("[data-view]");
  if (viewButton) {
    viewButton.closest("dialog")?.close();
    return setView(viewButton.dataset.view);
  }
  const viewLink = target.closest("[data-view-link]");
  if (viewLink) {
    event.preventDefault();
    return setView(viewLink.dataset.viewLink);
  }
  if (target.closest("[data-close]")) return target.closest("dialog")?.close();
  const payButton = target.closest("[data-pay]");
  if (payButton) {
    const deal = deals.find((item) => item.id === payButton.dataset.pay);
    if (deal) payDialog(deal);
    return;
  }
  const actionButton = target.closest("[data-deal-action]");
  if (actionButton) {
    if (actionButton.dataset.dealAction === "refund" && !window.confirm("Refund this payment through PayPal and return the stock?")) return;
    return dealAction(actionButton.dataset.id, actionButton.dataset.dealAction);
  }
  const reofferButton = target.closest("[data-reoffer]");
  if (reofferButton) {
    const deal = deals.find((item) => item.id === reofferButton.dataset.reoffer);
    const value = window.prompt(`Your new price per kg (supplier countered at ${formatMoney(deal.counterUnitMinor)}):`, ((deal.unitMinor + deal.counterUnitMinor) / 200).toFixed(2));
    if (value) dealAction(deal.id, "reoffer", { unitMinor: Math.round(Number(value) * 100) });
    return;
  }
  const decisionButton = target.closest("[data-decision]");
  if (decisionButton) {
    const decision = decisionButton.dataset.decision;
    let counterUnitMinor;
    if (decision === "COUNTERED") {
      const deal = deals.find((item) => item.id === decisionButton.dataset.id);
      const value = window.prompt("Counter price per kg:", ((deal.unitMinor + deal.listUnitMinor) / 200).toFixed(2));
      if (!value) return;
      counterUnitMinor = Math.round(Number(value) * 100);
    }
    return dealAction(decisionButton.dataset.id, "decision", { decision, counterUnitMinor });
  }
  const listingButton = target.closest("[data-action]");
  if (listingButton) {
    const listing = findListing(listingButton.dataset.id);
    if (!listing) return showToast("This material is no longer available.", "error");
    if (listingButton.dataset.action === "details") return materialDetail(listing);
    if (detailDialog.open) detailDialog.close();
    if (listing.unit !== "kg") return showToast("Offers for pieces and meters are not supported yet.", "error");
    return offerDialog(listing);
  }
  const chip = target.closest(".category-chip");
  if (chip) {
    activeCategory = chip.dataset.category;
    document.querySelectorAll(".category-chip").forEach((button) => button.classList.toggle("selected", button === chip));
    return renderListings();
  }
  if (target.closest("#filter-toggle")) {
    filterPanel.hidden = !filterPanel.hidden;
    return filterToggle.setAttribute("aria-expanded", String(!filterPanel.hidden));
  }
  if (target.closest("#clear-search")) {
    $("#catalog-search").value = "";
    return renderListings();
  }
  if (target.closest("#clear-match")) {
    matchActive = false;
    matchResults.clear();
    matchIntent = null;
    activeCategory = "all";
    $("#match-summary").hidden = true;
    document.querySelectorAll(".category-chip").forEach((button) => button.classList.toggle("selected", button.dataset.category === "all"));
    return renderListings();
  }
  if (target.closest("#agent-close")) {
    $("#agent-panel").hidden = true;
    return;
  }
  if (target.closest("#agent-run")) {
    const brief = $("#need-input").value.trim();
    if (!brief) return showToast("Write a brief: material, use, quantity and budget.", "error");
    return runAgent(brief);
  }
  const promptButton = target.closest("[data-prompt]");
  if (promptButton) {
    $("#need-input").value = promptButton.dataset.prompt;
    runMatch(promptButton.dataset.prompt);
  }
});

document.addEventListener("change", async (event) => {
  const toggle = event.target.closest("[data-auto]");
  if (!toggle) return;
  try {
    await api(`/api/listings/${toggle.dataset.auto}/settings`, { autoNegotiate: toggle.checked });
    await refreshData();
    showToast(toggle.checked ? "Your agent now answers offers on this listing." : "Offers on this listing now wait for you.");
  } catch (error) {
    toggle.checked = !toggle.checked;
    showToast(error.message, "error");
  }
});

$("#match-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const query = $("#need-input").value.trim();
  if (!query) return showToast("Describe a material and what you want to make with it.", "error");
  runMatch(query);
});
$("#catalog-search").addEventListener("input", renderListings);
$("#sort-select").addEventListener("change", renderListings);
$("#role-select").addEventListener("change", (event) => switchPersona(event.target.value));
$("#new-listing-form").addEventListener("submit", submitNewListing);
$("#enrich-button").addEventListener("click", suggestDetails);
$("#listing-photo").addEventListener("change", async (event) => {
  const [file] = event.target.files || [];
  if (!file) return;
  try {
    photoDataUrl = await resizePhoto(file);
    $("#photo-preview").src = photoDataUrl;
    $("#photo-preview").hidden = false;
    $("#photo-filename").textContent = `${file.name} · ${Math.round((photoDataUrl.length * 0.75) / 1024)} KB after resize`;
  } catch (error) {
    photoDataUrl = "";
    showToast(error.message, "error");
  }
});
for (const dialog of [detailDialog, checkoutDialog]) {
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
}
checkoutDialog.addEventListener("close", () => {
  if (paypalButtonsInstance?.close) paypalButtonsInstance.close().catch(() => {});
  paypalButtonsInstance = null;
  delete checkoutDialog.dataset.dealId;
});

initialize();
