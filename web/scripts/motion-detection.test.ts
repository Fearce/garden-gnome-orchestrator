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

function patchPicture(width: number, contrast: number): Uint8ClampedArray {
  const pixels = picture();
  for (let y = 0; y < 24; y++) for (let x = 0; x < width; x++) {
    pixels.set([50 + contrast, 50 + contrast, 50 + contrast, 255], (y * 32 + x) * 4);
  }
  return pixels;
}
function detects(width: number, contrast: number, sensitivity: "low" | "medium" | "high"): boolean {
  const detector = new MotionDetector();
  detector.sample(picture(), 100_000);
  return detector.sample(patchPicture(width, contrast), 101_000, 30_000, sensitivity);
}
assert.equal(detects(4, 80, "medium"), true, "original sensitivity detects a modest changed area");
assert.equal(detects(4, 80, "low"), false, "low suppresses modest changed areas");
assert.equal(detects(8, 40, "medium"), true, "original sensitivity detects lower contrast changes");
assert.equal(detects(8, 40, "low"), false, "low suppresses lower contrast changes");
assert.equal(detects(8, 130, "low"), true, "low still detects substantial movement");
assert.equal(detects(2, 40, "medium"), false, "standard ignores small movements");
assert.equal(detects(2, 40, "high"), true, "high picks up small movements");
for (const sensitivity of ["low", "medium", "high"] as const) {
  const detector = new MotionDetector();
  detector.sample(picture(), 100_000);
  assert.equal(detector.sample(picture(40), 101_000, 30_000, sensitivity), false);
  assert.equal(detector.sample(picture(40, true), 102_000, 30_000, sensitivity), true);
  assert.equal(detector.sample(picture(40), 103_000, 30_000, sensitivity), false, "all levels retain cooldown");
  assert.equal(detector.sample(picture(), 200_000, 30_000, sensitivity), false, "all levels rebaseline after sleep");
}
console.log("Sensitivity regressions passed");
