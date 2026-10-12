// B1 step 2: toolCallId correlation — controller unit test (no server, no model).
// Verifies nextToolCallId format/stability and that started/output/completed
// carry the SAME id for one call, and distinct ids across calls.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AgentLoopController, nextToolCallId } from "../../src/core/agent-loop-controller.js";

function makeController() {
  const seen = [];
  const gateway = { addEvent: (event, payload) => seen.push({ event, payload }) };
  const ctrl = new AgentLoopController({
    gateway,
    run: { id: "run_test123" },
    session: { id: "sess_test" },
    agent: { id: "main" },
  });
  return { ctrl, seen };
}

describe("nextToolCallId", () => {
  it("formats tc_<runId>_<n> and increments per run", () => {
    const run = { id: "run_abc" };
    assert.equal(nextToolCallId(run), "tc_run_abc_1");
    assert.equal(nextToolCallId(run), "tc_run_abc_2");
    assert.equal(nextToolCallId({ id: "run_xyz" }), "tc_run_xyz_1");
  });
});

describe("tool event correlation", () => {
  it("stamps the caller-minted id on started/output/completed", () => {
    const { ctrl, seen } = makeController();
    const call = { tool: "read_file", input: { path: "a.txt" }, toolCallId: "tc_run_test123_7" };
    const returned = ctrl.toolStarted(call);
    assert.equal(returned, "tc_run_test123_7");
    ctrl.toolOutput(call, { ok: true });
    ctrl.toolCompleted(call, { ok: true });
    const ids = seen.map((e) => e.payload.toolCallId);
    assert.deepEqual(ids, ["tc_run_test123_7", "tc_run_test123_7", "tc_run_test123_7"]);
    assert.deepEqual(seen.map((e) => e.event), ["tool.started", "tool.output", "tool.completed"]);
  });

  it("mints a fallback id when the caller passes none", () => {
    const { ctrl, seen } = makeController();
    const id = ctrl.toolStarted({ tool: "exec", input: {} });
    assert.match(id, /^tc_/);
    assert.equal(seen[0].payload.toolCallId, id);
  });

  it("marks failures as tool.failed with the same id", () => {
    const { ctrl, seen } = makeController();
    const call = { tool: "exec", input: {}, toolCallId: "tc_run_test123_9" };
    ctrl.toolStarted(call);
    ctrl.toolCompleted(call, { error: true, message: "boom" });
    assert.equal(seen[1].event, "tool.failed");
    assert.equal(seen[1].payload.toolCallId, "tc_run_test123_9");
  });
});
