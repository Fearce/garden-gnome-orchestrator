import assert from "node:assert/strict";
import { verifiedGoogleEmail } from "../auth.js";

const now = 1_800_000_000;
const clientId = "client.example.com";
const valid = {
  iss: "https://accounts.google.com",
  aud: clientId,
  exp: now + 60,
  email: "alex@example.com",
  email_verified: true,
};

assert.equal(verifiedGoogleEmail(valid, clientId, now), valid.email);
assert.equal(verifiedGoogleEmail({ ...valid, iss: "accounts.google.com" }, clientId, now), valid.email);
for (const claims of [
  null,
  [],
  { ...valid, iss: "https://example.com" },
  { ...valid, aud: "other-client" },
  { ...valid, exp: now },
  { ...valid, exp: "9999999999" },
  { ...valid, email_verified: false },
  { ...valid, email_verified: undefined },
  { ...valid, email: 42 },
  { ...valid, email: "" },
]) {
  assert.equal(verifiedGoogleEmail(claims, clientId, now), null);
}
assert.equal(verifiedGoogleEmail(valid, undefined, now), null);
console.log("Google ID token identity claims: passed");
