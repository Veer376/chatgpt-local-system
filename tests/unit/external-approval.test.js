import test from "node:test";
import assert from "node:assert/strict";

test("destructive approval exposes no replay-token or external-verifier API", async () => {
  const policy = await import("../../src/lib/policy.js");
  for (const name of ["queueDestructive", "takeDestructive", "rejectDestructive", "listPending"]) {
    assert.equal(policy[name], undefined, name);
  }
});
