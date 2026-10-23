import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const PERSONAS = [
  { id: "buyer-northwind", role: "buyer", name: "Priya Shah", org: "Northwind Packaging Lab", initials: "PS" },
  { id: "supplier-davis", role: "supplier", name: "Jordan Davis", org: "Davis Reclaim Co.", initials: "JD", supplierId: "sup-davis" },
];

const COOKIE = "w2w_session";

export function createSessions(secret) {
  const key = secret || randomBytes(32).toString("hex");

  function sign(value) {
    return createHmac("sha256", key).update(value).digest("base64url");
  }

  function persona(request) {
    const cookie = String(request.headers.cookie || "").split(/;\s*/).find((part) => part.startsWith(`${COOKIE}=`));
    const [id, signature] = (cookie ? decodeURIComponent(cookie.slice(COOKIE.length + 1)) : "").split(".");
    if (id && signature) {
      const expected = Buffer.from(sign(id));
      const actual = Buffer.from(signature);
      if (expected.length === actual.length && timingSafeEqual(expected, actual)) {
        const found = PERSONAS.find((item) => item.id === id);
        if (found) return found;
      }
    }
    return PERSONAS[0];
  }

  function cookieFor(personaId, secure) {
    const value = encodeURIComponent(`${personaId}.${sign(personaId)}`);
    // Hosted builds may be embedded in an iframe (Hugging Face Spaces), which needs a
    // cross-site, partitioned cookie; local HTTP keeps the simpler Lax cookie.
    return `${COOKIE}=${value}; Path=/; HttpOnly; Max-Age=2592000; ${secure ? "SameSite=None; Secure; Partitioned" : "SameSite=Lax"}`;
  }

  return { persona, cookieFor };
}
