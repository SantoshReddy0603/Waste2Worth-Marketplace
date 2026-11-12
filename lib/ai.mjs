import { cleanText } from "./util.mjs";
import { permittedCategories } from "./safety.mjs";

const PRESETS = {
  groq: { baseUrl: "https://api.groq.com/openai/v1", model: "openai/gpt-oss-120b", visionModel: "qwen/qwen3.8-27b" },
  ollama: { baseUrl: "http://localhost:11434/v1", model: "qwen2.5:7b", visionModel: "llama3.2-vision" },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", model: "openai/gpt-oss-120b:free", visionModel: "meta-llama/llama-4-scout:free" },
};

const CONDITIONS = ["Clean · sorted", "Dry · clean", "Untreated · dry", "Mixed · needs review"];

export function aiConfigFromEnv(env = process.env) {
  const provider = (env.AI_PROVIDER || (env.AI_API_KEY ? "groq" : "none")).toLowerCase();
  if (provider === "none") return { provider: "none", enabled: false };
  const preset = PRESETS[provider] || {};
  const baseUrl = (env.AI_BASE_URL || preset.baseUrl || "").replace(/\/$/, "");
  const model = env.AI_MODEL || preset.model || "";
  const enabled = Boolean(baseUrl && model && (env.AI_API_KEY || provider === "ollama"));
  return { provider, enabled, baseUrl, model, visionModel: env.AI_VISION_MODEL || preset.visionModel || model, apiKey: env.AI_API_KEY || "" };
}

export function parseJsonLoose(text) {
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_RETRY_WAIT_MS = 3_000;

// Free tiers rate-limit in short bursts; wait as told (capped) and try once more.
export function retryDelayMs(response) {
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, MAX_RETRY_WAIT_MS) : 1_000;
}

export function createAI(config, { fetchImpl = fetch, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  async function chat({ messages, tools, json = false, vision = false, maxTokens = 900, timeoutMs = 30_000 }) {
    if (!config.enabled) throw new Error("AI provider is not configured.");
    const model = vision ? config.visionModel : config.model;
    const body = {
      model,
      messages,
      temperature: 0.2,
      max_tokens: maxTokens,
      ...(tools ? { tools, tool_choice: "auto" } : {}),
      ...(json && !tools ? { response_format: { type: "json_object" } } : {}),
      ...(/gpt-oss/.test(model) ? { reasoning_effort: "low" } : {}),
    };
    const send = () => fetchImpl(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    let response = await send();
    if (RETRYABLE_STATUS.has(response.status)) {
      await sleep(retryDelayMs(response));
      response = await send();
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`AI provider returned ${response.status}: ${payload?.error?.message || "unknown error"}`);
    const message = payload.choices?.[0]?.message;
    if (!message) throw new Error("AI provider returned no message.");
    return message;
  }

  async function chatJson(options) {
    const message = await chat({ ...options, json: true });
    const parsed = parseJsonLoose(message.content);
    if (!parsed || typeof parsed !== "object") throw new Error("AI provider returned invalid JSON.");
    return parsed;
  }

  // Photo and/or text to a listing draft. Every field is validated; the model may abstain.
  async function listingDraft({ title, description, imageDataUrl }) {
    const instructions = `You help suppliers list clean industrial surplus on a reuse marketplace that ONLY accepts clean, nonhazardous textile offcuts, untreated wood offcuts and packaging scraps.
Describe only what is visible or stated. Never claim certifications, lab composition or safety you cannot see.
If the material is not one of the three families, or looks contaminated, painted, treated, oily, wet, moldy, mixed with other waste, or hazardous, set "safety" to "review" or "block".
If the image/text is too unclear to describe, set "abstain": true.
Reply with ONLY a JSON object:
{"abstain":boolean,"abstain_reason":string,"title":string (max 70 chars),"category":"textile"|"wood"|"packaging"|"unsupported","subtype":string (max 50),"condition":${JSON.stringify(CONDITIONS.join("|"))},"description":string (max 380, factual, buyer-facing),"likely_uses":[up to 4 short strings],"visible_attributes":[up to 5 short strings],"unknowns":[up to 4 things a buyer should confirm],"safety":"allow"|"review"|"block","safety_reason":string,"confidence":"low"|"medium"|"high"}`;
    const userText = `Supplier notes:\nTitle: ${title || "(none)"}\nDescription: ${description || "(none)"}${imageDataUrl ? "\nA photo of the material is attached." : ""}`;
    const content = imageDataUrl
      ? [{ type: "text", text: userText }, { type: "image_url", image_url: { url: imageDataUrl } }]
      : userText;
    const raw = await chatJson({ messages: [{ role: "system", content: instructions }, { role: "user", content }], vision: Boolean(imageDataUrl), maxTokens: 700 });
    return sanitizeDraft(raw);
  }

  async function extractIntent(query) {
    const raw = await chatJson({
      maxTokens: 300,
      messages: [
        { role: "system", content: `Extract a buyer's surplus-material request. Reply with ONLY JSON: {"category":"textile"|"wood"|"packaging"|"","quantity_kg":number|null,"budget_usd":number|null,"location":string,"use":string}. category is "" when unclear. location is a city name or "".` },
        { role: "user", content: query },
      ],
    });
    return {
      category: permittedCategories.has(raw.category) ? raw.category : "",
      quantity: Number.isSafeInteger(Math.round(raw.quantity_kg)) && raw.quantity_kg > 0 && raw.quantity_kg <= 100_000 ? Math.round(raw.quantity_kg) : null,
      budgetMinor: Number(raw.budget_usd) > 0 ? Math.round(Number(raw.budget_usd) * 100) : null,
      location: cleanText(raw.location, 40),
      use: cleanText(raw.use, 120),
    };
  }

  async function rerank(query, candidates) {
    const compact = candidates.map((item) => ({ id: item.id, title: item.title, subtype: item.subtype, condition: item.condition, description: item.description, uses: item.uses, location: item.location, price_per_kg: item.priceMinor / 100, available_kg: item.available, landed_usd: item.landed / 100 }));
    const raw = await chatJson({
      maxTokens: 900,
      messages: [
        { role: "system", content: `You rank surplus listings for a buyer. Judge practical fit for the stated use, condition, location and cost. Be specific and honest about trade-offs; never invent properties. Reply with ONLY JSON: {"ranking":[{"id":string,"fit":0-100,"reason":string (max 140 chars)}]} covering every listing id given.` },
        { role: "user", content: `Buyer request: ${query}\nListings: ${JSON.stringify(compact)}` },
      ],
    });
    const ids = new Set(candidates.map((item) => item.id));
    return (Array.isArray(raw.ranking) ? raw.ranking : [])
      .filter((row) => ids.has(row.id))
      .map((row) => ({ id: row.id, fit: Math.max(0, Math.min(100, Math.round(Number(row.fit) || 0))), reason: cleanText(row.reason, 160) }));
  }

  return { config, chat, chatJson, listingDraft, extractIntent, rerank };
}

export function sanitizeDraft(raw) {
  const list = (value, max, length) => (Array.isArray(value) ? value : []).map((item) => cleanText(item, length)).filter(Boolean).slice(0, max);
  const category = permittedCategories.has(raw.category) ? raw.category : "unsupported";
  const safety = ["allow", "review", "block"].includes(raw.safety) ? raw.safety : "review";
  return {
    abstain: raw.abstain === true,
    abstainReason: cleanText(raw.abstain_reason, 200),
    title: cleanText(raw.title, 70),
    category,
    subtype: cleanText(raw.subtype, 50),
    condition: CONDITIONS.includes(raw.condition) ? raw.condition : "Mixed · needs review",
    description: cleanText(raw.description, 380),
    likelyUses: list(raw.likely_uses, 4, 60),
    visibleAttributes: list(raw.visible_attributes, 5, 60),
    unknowns: list(raw.unknowns, 4, 80),
    // An unsupported family can never be "allow", whatever the model said.
    safety: category === "unsupported" && safety === "allow" ? "review" : safety,
    safetyReason: cleanText(raw.safety_reason, 200),
    confidence: ["low", "medium", "high"].includes(raw.confidence) ? raw.confidence : "low",
  };
}
