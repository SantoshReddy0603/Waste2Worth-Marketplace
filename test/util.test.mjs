import { test } from "node:test";
import assert from "node:assert/strict";
import { clientAddress, createRateLimiter } from "../lib/util.mjs";

test("rate limiter allows up to the limit per window and then resets", () => {
  let time = 0;
  const allow = createRateLimiter({ limit: 2, windowMs: 1000, now: () => time });
  assert.equal(allow("a"), true);
  assert.equal(allow("a"), true);
  assert.equal(allow("a"), false);
  assert.equal(allow("b"), true, "limits are per client");
  time = 1500;
  assert.equal(allow("a"), true, "a new window starts after windowMs");
});

test("rate limiter forgets clients whose window has expired", () => {
  let time = 0;
  const allow = createRateLimiter({ limit: 5, windowMs: 1000, now: () => time });
  for (let index = 0; index < 50; index += 1) allow(`client-${index}`);
  assert.equal(allow.size(), 50);
  time = 2500;
  allow("fresh");
  assert.equal(allow.size(), 1);
});

test("client address ignores spoofable forwarded headers unless a proxy is trusted", () => {
  const request = { headers: { "x-forwarded-for": "1.1.1.1, 10.0.0.7" }, socket: { remoteAddress: "10.0.0.1" } };
  assert.equal(clientAddress(request), "10.0.0.1");
  assert.equal(clientAddress(request, true), "10.0.0.7", "the entry added by our proxy, not the client's");
  assert.equal(clientAddress({ headers: {}, socket: { remoteAddress: "10.0.0.1" } }, true), "10.0.0.1");
});
