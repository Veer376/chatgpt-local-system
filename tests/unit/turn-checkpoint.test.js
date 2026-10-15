import assert from "node:assert/strict";
import test from "node:test";

import {
  TURN_CHECKPOINT_MESSAGE,
  TurnCheckpointTracker,
} from "../../src/lib/turn-checkpoint.js";

test("checkpoint becomes available only after the threshold and only once per turn", () => {
  const tracker = new TurnCheckpointTracker({ thresholdMs: 120_000 });
  tracker.begin("thread-a", 1_000);

  assert.equal(tracker.claim("thread-a", 120_999), null);
  assert.equal(tracker.claim("thread-a", 121_000), TURN_CHECKPOINT_MESSAGE);
  assert.equal(tracker.claim("thread-a", 500_000), null);
});

test("a new turn resets the checkpoint timer and delivery state", () => {
  const tracker = new TurnCheckpointTracker({ thresholdMs: 60_000 });
  tracker.begin("thread-a", 1_000);
  assert.equal(tracker.claim("thread-a", 61_000), TURN_CHECKPOINT_MESSAGE);

  tracker.begin("thread-a", 70_000);
  assert.equal(tracker.claim("thread-a", 129_999), null);
  assert.equal(tracker.claim("thread-a", 130_000), TURN_CHECKPOINT_MESSAGE);
});

test("claim can use a live threshold override", () => {
  const tracker = new TurnCheckpointTracker({ thresholdMs: 20 * 60_000 });
  tracker.begin("thread-a", 1_000);
  assert.equal(tracker.claim("thread-a", 2_000, 60_000), null);
  assert.equal(tracker.claim("thread-a", 61_000, 60_000), TURN_CHECKPOINT_MESSAGE);
});

test("checkpoint wording requires near-immediate natural wrap-up without todo semantics", () => {
  assert.match(TURN_CHECKPOINT_MESSAGE, /nearest natural checkpoint now/);
  assert.match(TURN_CHECKPOINT_MESSAGE, /coherent and safely resumable/);
  assert.match(TURN_CHECKPOINT_MESSAGE, /do not continue toward completing the whole task/);
  assert.match(TURN_CHECKPOINT_MESSAGE, /checkpoint, not a conclusion/);
  assert.match(TURN_CHECKPOINT_MESSAGE, /do not prematurely narrow or conclude the broader investigation/);
  assert.match(TURN_CHECKPOINT_MESSAGE, /give a concise continuation summary/);
  assert.match(TURN_CHECKPOINT_MESSAGE, /runtime_memory/);
  assert.match(TURN_CHECKPOINT_MESSAGE, /objective, state, decisions, blockers, and next action/);
  assert.doesNotMatch(TURN_CHECKPOINT_MESSAGE, /todo/i);
});
