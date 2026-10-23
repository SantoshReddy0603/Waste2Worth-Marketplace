# Demo video: script and shot list (target 2:45)

**Setup before recording:**
- Use the hosted app or `npm start` with the Groq and PayPal Sandbox keys set.
- Start from a fresh database: delete `data/runtime.json` locally, or truncate the tables in Neon.
- Open a second browser profile already signed in to the **Sandbox personal (buyer)** account.
- Open the Sandbox **supplier** account's activity page (sandbox.paypal.com) in another tab.
- Browser at 1366×768, zoom 110%. No music, or royalty-free music only. Don't show third-party logos.

| Time | Screen | Voiceover |
|---|---|---|
| 0:00–0:15 | Title card, then a photo of offcut bins | "Small factories pay to throw away clean fabric, wood and cardboard that other small makers would buy. The material isn't the problem. Finding it, haggling over it and trusting a stranger with payment is." |
| 0:15–0:25 | Discover page, hero and brief | "Waste2Worth gives that job to an agent. I'm Priya, a packaging lab buyer, and this is my whole brief." |
| 0:25–0:55 | Click **Send agent**. The trace animates: Understood brief → Searched → Offered $1.10/kg → Supplier agent accepted | "The Surplus Agent, running on open-weight gpt-oss through Groq's free tier, searches the marketplace, picks the best fit near Austin, and opens below list price. On the other side, the supplier's own agent answers inside the floor the supplier set. A budget guard in our server code, not in the prompt, blocks any offer over my $300." |
| 0:55–1:20 | Click **Review & approve payment** → PayPal button → Sandbox popup → approve | "The agent can negotiate, but it can't spend. I approve the negotiated $258 in PayPal. Our server captures it with Orders v2 and checks the amount, currency and payee before it calls the deal paid." |
| 1:20–1:40 | Deals page: flow bar at *Paid & held*, open the audit trail | "The money is held by the platform, not the supplier, until I've seen the material. Every step is in the audit trail, including who acted: me, my agent, the supplier's agent, or PayPal." |
| 1:40–2:00 | Click **Confirm pickup & release payout**. Status goes to *Supplier paid*. Cut to the supplier's Sandbox activity showing the payout | "After pickup I release it, and the PayPal Payouts API pays the supplier $245.10: the total minus a 5% platform fee. If something's wrong, one click refunds through PayPal and the stock goes back on the market." |
| 2:00–2:25 | Switch persona to **Supplier**, open **Post material**, upload a photo, click **Suggest details**, show the draft. Then type "oil-soaked rags" and show it blocked | "Suppliers just snap a photo. An open-weight Qwen vision model drafts the listing and says what a buyer should check. Safety is enforced in code: the AI can make a listing stricter, but it can never approve something our rules block." |
| 2:25–2:45 | Impact page, then the GitHub README | "Every kilogram here moved through a real PayPal transaction. It's open source, free to run, and the agent negotiates while people stay in charge of the money. That's Waste2Worth." |

**Checklist:**
- Under 3:00.
- Upload to YouTube as Public.
- Paste the link into Devpost.
- Say "PayPal Sandbox" out loud at least once, so it's clear the payments are test transactions.
