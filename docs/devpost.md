# Devpost submission text

Paste each section into the matching Devpost field.

## Project name
Waste2Worth: Surplus Agent

## Elevator pitch (200 characters)
An AI agent that buys reusable industrial surplus for you: it finds the lot, negotiates with the supplier's agent, and settles through PayPal, holding funds until pickup.

## Inspiration
Small manufacturers pay to landfill clean offcuts that other small makers would happily buy. The material isn't the problem. The work is: finding a 200 kg lot nearby, haggling over a few dollars, and trusting a stranger with payment. Agents are good at exactly that kind of tedious, rule-bound work, and PayPal already solves trust between strangers.

## What it does
- **Buyer brief.** A buyer types one sentence, for example "200 kg clean cotton fabric for protective packaging, under $300, near Austin".
- **Surplus Agent.** It searches the marketplace, opens an offer below list price, and negotiates with the supplier's agent. That agent answers within the floor price the supplier set, and bulk orders unlock the floor. Every step is shown live.
- **Budget guard.** A server-side guard makes it impossible for the agent to offer above budget.
- **PayPal checkout.** The buyer approves the negotiated amount in PayPal. The server captures it and checks the amount, currency and payee before marking it paid.
- **Funds held until pickup.** Waste2Worth holds the money until the buyer confirms pickup. Then the PayPal Payouts API sends the supplier their share minus a 5% platform fee. If the material isn't as described, the buyer gets a refund through the PayPal Refunds API and the stock returns to the listing.
- **Webhooks.** Verified PayPal webhooks keep capture, refund and payout state in sync.
- **Photo listings.** Suppliers list material by snapping a photo. An open-weight vision model drafts the listing and flags safety concerns, and it can abstain. The server's own safety rules always run, and AI can only make them stricter.

## How we built it
- **Server:** Node.js with no framework, and a vanilla JS front end with no build step.
- **Agent:** an OpenAI-compatible tool-calling loop (`search_listings`, `make_offer`, `accept_counter`, `finish`) running on Groq's free tier with the open-weight gpt-oss-120b. Qwen3.8 (open weights) handles vision. Ollama is supported for fully local, open-source runs. With no key, a deterministic rules agent uses the same tools, so the app always works.
- **PayPal:** Orders v2 with the JS SDK Buttons, idempotent create and capture, capture reconciliation, the Refunds API, the Payouts API with status polling, and webhook signature verification.
- **Deals:** one deal state machine with stock reservation and a full audit log of who did what (buyer, buyer agent, supplier agent, PayPal, webhook).
- **Storage:** Postgres (Neon) or a JSON file, including photos. Hosted on Render.
- **Tests:** 31 `node --test` tests, covering the state machine, the safety gate, the agent with mocked LLM tool calls, PayPal against a mocked API, storage and rate limiting. GitHub Actions runs them on Node 20 and 22.

## Challenges we ran into
- **Keeping an LLM inside hard limits.** We moved the budget, the safety gate and payee checks out of the prompt and into server code the model can't override. The agent can propose; only code and the human can commit money.
- **Marketplace semantics on a single platform account.** Capturing to the platform, holding the funds, then paying out through Payouts gave us real escrow-like behaviour that the Sandbox can demonstrate end to end.

## Accomplishments that we're proud of
- A complete agent-to-agent commerce loop, from a one-sentence brief to a supplier payout, where every transition is auditable.
- It costs nothing to run: open-weight models on free tiers, the PayPal Sandbox, and free hosting.

## What we learned
Agentic commerce needs a clear split. The model decides *what to offer*. Deterministic code decides *what is allowed*. The human approves *what is paid*. PayPal's hosted approval makes that last step natural.

## What's next for Waste2Worth
- Real supplier onboarding with per-supplier payout accounts (PayPal for Marketplaces).
- Pickup verification with a photo at handover.
- Carrier quotes instead of freight estimates.
- Recurring sourcing agents that watch for new lots that match a buyer's needs.

## Built with
paypal-orders-v2, paypal-payouts, paypal-refunds, paypal-webhooks, paypal-js-sdk, github-actions, groq, gpt-oss, qwen, ollama, node.js, postgresql, neon, render, javascript

## Tools section (required by the rules)
- **PayPal Orders v2 and JS SDK Buttons:** the buyer approves the negotiated amount, and the server captures it and reconciles the amount, currency and payee.
- **PayPal Payouts API:** sends the supplier's net amount after pickup is confirmed.
- **PayPal Refunds API:** refunds a held capture before payout.
- **PayPal Webhooks:** keeps capture, refund and payout events in sync, checked with verify-webhook-signature.
- **Groq free tier with gpt-oss-120b (open weights):** the buyer agent's tool-calling loop, intent extraction and re-ranking listings with reasons.
- **Groq with Qwen3.8 (open weights, vision):** turns supplier photos into listing drafts with safety flags.
- **Ollama:** optional, for fully local open-source runs.
- **Render and Neon:** hosting and Postgres persistence.

## Testing instructions for judges
- **Code:** https://github.com/SantoshReddy0603/Waste2Worth-Marketplace
- **Hosted demo:** `<RENDER_URL>`. The PayPal Sandbox buyer login is `<SANDBOX_BUYER_EMAIL>` / `<SANDBOX_BUYER_PASSWORD>`.
- **Run it locally:** follow the README (`npm install && npm start`). It works with no keys, using the rules agent and clearly marked demo payments.
