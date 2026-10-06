import assert from "node:assert/strict";
import { MotionDetector } from "../src/components/modules/motionDetection.js";

function picture(offset = 0, movement = false): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(32 * 24 * 4);
  for (let i = 0; i < pixels.length / 4; i++) {
    const value = (movement && i % 32 < 8 ? 180 : 50) + offset;
    pixels.set([value, value, value, 255], i * 4);
  }
  return pixels;
}
const detector = new MotionDetector();
assert.equal(detector.sample(picture(), 100_000), false, "first frame is a baseline");
assert.equal(detector.sample(picture(), 101_000), false, "still picture stays quiet");
assert.equal(detector.sample(picture(40), 102_000), false, "uniform lighting changes stay quiet");
assert.equal(detector.sample(picture(40, true), 103_000), true, "local movement alerts");
assert.equal(detector.sample(picture(40, false), 104_000), false, "cooldown suppresses repeated movement");
assert.equal(detector.sample(picture(40, true), 133_000), true, "movement after cooldown alerts again");
assert.equal(detector.sample(picture(), 133_000), false, "duplicate frame is ignored");
assert.equal(detector.sample(picture(), 132_000), false, "older frame is ignored");
assert.equal(detector.sample(picture(), 200_000), false, "reconnect after a long gap is a baseline");
const other = new MotionDetector();
assert.equal(other.sample(picture(), 100_000), false);
assert.equal(other.sample(picture(0, true), 101_000), true, "another camera has its own cooldown");
console.log("Motion detection checks passed");
