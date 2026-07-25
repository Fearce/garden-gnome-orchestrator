import assert from "node:assert/strict";
import { acknowledgedInjection } from "../orchestrator/injection.js";

const message = "Use a new clip design and export a 3MF file.";
const prompt = acknowledgedInjection(message);

assert.match(prompt, /^\[DIRECTOR INJECTION — ACKNOWLEDGEMENT REQUIRED\]/);
assert.ok(prompt.includes(message));
assert.match(prompt, /highest-priority direction/);
assert.match(prompt, /begin your next visible response with `ACK:`/);
assert.match(prompt, /do not treat it as background context/);

console.log("injection: backend-neutral acknowledgement instructions present");
