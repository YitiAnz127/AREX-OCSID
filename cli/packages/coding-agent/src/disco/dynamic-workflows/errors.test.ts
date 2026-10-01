import { describe, expect, it } from "vitest";
import { WorkflowError, WorkflowErrorCode, wrapError } from "./errors.ts";

describe("workflow error classification", () => {
	it("classifies aborts and timeouts as recoverable", () => {
		const aborted = wrapError(new Error("Subagent was aborted"));
		expect(aborted.code).toBe(WorkflowErrorCode.WORKFLOW_ABORTED);
		expect(aborted.recoverable).toBe(true);

		const timedOut = wrapError(new Error("request timeout"), { agentLabel: "x" });
		expect(timedOut.code).toBe(WorkflowErrorCode.AGENT_TIMEOUT);
		expect(timedOut.recoverable).toBe(true);
		expect(timedOut.agentLabel).toBe("x");
	});

	it("BUG (silent failure): a genuine programming error is NON-recoverable so it surfaces instead of being retried-then-nulled", () => {
		// A TypeError in the workflow body, a schema/programming bug, or any unknown
		// runtime error must NOT be silently swallowed as a recoverable hiccup — that
		// previously sent the caller's recovery mechanism into an infinite loop over
		// the identical broken code.
		const wrapped = wrapError(new Error("Cannot read properties of undefined (reading 'foo')"));
		expect(wrapped.code).toBe(WorkflowErrorCode.AGENT_EXECUTION_ERROR);
		expect(wrapped.recoverable).toBe(false);
	});

	it("passes through an already-wrapped WorkflowError unchanged and preserves a recoverable flag set by the caller", () => {
		const original = new WorkflowError("empty output", WorkflowErrorCode.AGENT_EMPTY_OUTPUT, { recoverable: true });
		expect(wrapError(original)).toBe(original);
		expect(original.recoverable).toBe(true);
	});
});
