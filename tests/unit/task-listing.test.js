import test from "node:test";
import assert from "node:assert/strict";
import { selectTaskPage } from "../../src/tools/process.js";

function record(index, { running = false } = {}) {
  return { id: `p_${index}`, command: `echo ${index}`, running };
}

test("manage_task listings are bounded and never drop a running task", () => {
  // Records are kept for two weeks; a long-lived bridge accumulates hundreds,
  // and returning all of them costs the model tens of thousands of tokens.
  const history = Array.from({ length: 502 }, (_, index) => record(index));
  const page = selectTaskPage(history);
  assert.equal(page.selected.length, 20);
  assert.equal(page.total, 502);
  assert.equal(page.omitted, 482);

  // A running task buried at the end of the history is still actionable, so it
  // must survive the cut that discards finished ones.
  const buried = [...Array.from({ length: 60 }, (_, index) => record(index)), record(999, { running: true })];
  const withRunning = selectTaskPage(buried);
  assert.equal(withRunning.running, 1);
  assert.equal(withRunning.selected[0].id, "p_999");
  assert.equal(withRunning.selected.length, 20);

  const short = selectTaskPage([record(1), record(2, { running: true })]);
  assert.equal(short.omitted, 0);
  assert.equal(short.selected.length, 2);
  assert.deepEqual(selectTaskPage([]), { selected: [], total: 0, running: 0, omitted: 0 });
});
