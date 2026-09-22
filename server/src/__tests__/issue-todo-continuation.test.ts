import { describe, expect, it } from "vitest";
import { isAgentTodoReturn, canContinueReturnedTodo, todoContinuationAttempt } from "../services/issue-todo-continuation.js";
const before = { id: "issue", companyId: "company", status: "in_progress", assigneeAgentId: "agent", executionState: null };
const after = { ...before, status: "todo" };
const actor = { actorType: "agent", actorId: "agent", agentId: "agent", runId: "run" };
describe("agent todo continuation eligibility", () => {
  it("accepts an assignee returning its own work to todo", () => {
    expect(isAgentTodoReturn(before, after, actor)).toBe(true);
  });
  it.each(["todo", "backlog", "blocked", "in_review", "done", "cancelled"])("does not treat %s as an agent yield", (status) => {
    expect(isAgentTodoReturn({ ...before, status }, after, actor)).toBe(false);
  });
  it("does not turn a board edit into autonomous work", () => {
    expect(isAgentTodoReturn(before, after, { ...actor, actorType: "user" })).toBe(false);
  });
  it("requires the authenticated agent and run", () => {
    expect(isAgentTodoReturn(before, after, { ...actor, runId: null })).toBe(false);
    expect(isAgentTodoReturn(before, after, { ...actor, agentId: null })).toBe(false);
  });
  it("does not wake a reassigned or unassigned ticket", () => {
    expect(isAgentTodoReturn(before, { ...after, assigneeAgentId: "other" }, actor)).toBe(false);
    expect(isAgentTodoReturn(before, { ...after, assigneeAgentId: null }, actor)).toBe(false);
  });
  it("does not override execution policy", () => {
    expect(isAgentTodoReturn(before, { ...after, executionState: {} } as any, actor)).toBe(false);
  });
  it.each([null, -1, 0.5, "2", Number.NaN])("fails closed for malformed attempt %s", (attempt) => {
    expect(todoContinuationAttempt({ agentTodoContinuationAttempt: attempt })).toBe(3);
  });
  it("starts a new explicit wake at zero and preserves valid attempts", () => {
    expect(todoContinuationAttempt(null)).toBe(0);
    expect(todoContinuationAttempt({})).toBe(0);
    expect(todoContinuationAttempt({ agentTodoContinuationAttempt: 2 })).toBe(2);
  });
  it.each(["running", "failed", "cancelled", "timed_out"])("does not promote a follow-up from a %s run", (sourceStatus) => {
    expect(canContinueReturnedTodo({ issue: after, companyId: "company", agentId: "agent", sourceStatus, promoting: true })).toBe(false);
  });
  it("allows deferral during a run, and promotion only after success", () => {
    expect(canContinueReturnedTodo({ issue: after, companyId: "company", agentId: "agent", sourceStatus: "running", promoting: false })).toBe(true);
    expect(canContinueReturnedTodo({ issue: after, companyId: "company", agentId: "agent", sourceStatus: "succeeded", promoting: true })).toBe(true);
  });
  it.each(["done", "cancelled", "in_progress", "in_review", "blocked"])("cancels a deferred continuation when its ticket becomes %s", (status) => {
    expect(canContinueReturnedTodo({ issue: { ...after, status }, companyId: "company", agentId: "agent", sourceStatus: "succeeded", promoting: true })).toBe(false);
  });
});
