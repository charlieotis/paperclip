import { and, eq, sql } from "drizzle-orm";
import { activityLog, agentWakeupRequests, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import type { heartbeatService } from "./heartbeat.js";
import { withRecoveryModelProfileHint } from "./recovery/model-profile-hint.js";

export const AGENT_TODO_CONTINUATION_REASON = "issue_agent_returned_to_todo";
export const MAX_AGENT_TODO_CONTINUATIONS = 3;
type Issue = Pick<typeof issues.$inferSelect, "id" | "companyId" | "status" | "assigneeAgentId" | "executionState">;
type Actor = { actorType: string; actorId: string; agentId: string | null; runId: string | null };
type Wakeup = ReturnType<typeof heartbeatService>["wakeup"];

export function isAgentTodoReturn(before: Issue, after: Issue, actor: Actor): boolean {
  return actor.actorType === "agent" && Boolean(actor.agentId && actor.runId)
    && before.id === after.id && before.companyId === after.companyId
    && before.status === "in_progress" && after.status === "todo"
    && before.assigneeAgentId === actor.agentId && after.assigneeAgentId === actor.agentId
    && !after.executionState;
}

export function todoContinuationAttempt(context: Record<string, unknown> | null): number {
  const attempt = context?.agentTodoContinuationAttempt;
  if (attempt === undefined) return 0;
  // Malformed persisted counters fail closed rather than resetting a loop.
  return typeof attempt === "number" && Number.isSafeInteger(attempt) && attempt >= 0
    ? attempt : MAX_AGENT_TODO_CONTINUATIONS;
}

export function canContinueReturnedTodo(input: {
  issue: Pick<Issue, "companyId" | "status" | "assigneeAgentId" | "executionState">;
  companyId: string;
  agentId: string;
  sourceStatus: string;
  promoting: boolean;
}): boolean {
  return input.issue.companyId === input.companyId
    && input.issue.status === "todo"
    && input.issue.assigneeAgentId === input.agentId
    && !input.issue.executionState
    && (input.sourceStatus === "succeeded" || (!input.promoting && input.sourceStatus === "running"));
}

/** Serialize repeated requests for one source run; execution remains in the native queue. */
export async function enqueueAgentTodoContinuation(db: Db, input: {
  before: Issue;
  after: Issue;
  actor: Actor;
  wakeup: Wakeup;
  onExhausted: () => Promise<unknown>;
}): Promise<"ignored" | "duplicate" | "exhausted" | "requested"> {
  const { before, after, actor } = input;
  if (!isAgentTodoReturn(before, after, actor)) return "ignored";
  const key = `${AGENT_TODO_CONTINUATION_REASON}:${after.id}:${actor.runId}`;
  return db.transaction(async (tx) => {
    // This dedicated advisory lock does not acquire issue row locks. The native
    // wakeup owns those locks and can therefore run on its own DB connection.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${after.companyId + ":" + key}, 0))`);
    const [source] = await tx.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, actor.runId!),
      eq(heartbeatRuns.companyId, after.companyId),
      eq(heartbeatRuns.agentId, actor.agentId!),
    )).limit(1);
    const [current] = await tx.select().from(issues).where(and(
      eq(issues.id, after.id), eq(issues.companyId, after.companyId),
    )).limit(1);
    const context = source?.contextSnapshot as Record<string, unknown> | null;
    if (!source || context?.issueId !== after.id || !current || !canContinueReturnedTodo({
      issue: current, companyId: after.companyId, agentId: actor.agentId!,
      sourceStatus: source.status, promoting: false,
    })) return "ignored";
    const [existingWake] = await tx.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, after.companyId),
      eq(agentWakeupRequests.idempotencyKey, key),
    )).limit(1);
    const [existingAudit] = await tx.select({ id: activityLog.id }).from(activityLog).where(and(
      eq(activityLog.companyId, after.companyId),
      eq(activityLog.entityId, after.id),
      eq(activityLog.runId, source.id),
      eq(activityLog.action, "issue.todo_continuation_decided"),
    )).limit(1);
    if (existingWake || existingAudit) return "duplicate";
    const attempt = todoContinuationAttempt(context);
    if (attempt >= MAX_AGENT_TODO_CONTINUATIONS) {
      // Service-level system comment: visible to the board, without a comment wake.
      await input.onExhausted();
      await tx.insert(activityLog).values({
        companyId: after.companyId, actorType: "system", actorId: "todo-continuation",
        runId: source.id, action: "issue.todo_continuation_decided",
        entityType: "issue", entityId: after.id,
        details: { outcome: "exhausted", attempt, maxAttempts: MAX_AGENT_TODO_CONTINUATIONS },
      });
      return "exhausted";
    }
    const nextAttempt = attempt + 1;
    const continuation = withRecoveryModelProfileHint({
      issueId: after.id, taskId: after.id,
      wakeReason: AGENT_TODO_CONTINUATION_REASON,
      agentTodoContinuationAttempt: nextAttempt,
      agentTodoContinuationSourceRunId: source.id,
      source: "issue.agent_returned_to_todo",
    }, "normal_model");
    await input.wakeup(actor.agentId!, {
      source: "automation", triggerDetail: "system",
      reason: AGENT_TODO_CONTINUATION_REASON,
      idempotencyKey: key,
      requestedByActorType: "agent", requestedByActorId: actor.agentId,
      payload: continuation, contextSnapshot: continuation,
    });
    await tx.insert(activityLog).values({
      companyId: after.companyId, actorType: "system", actorId: "todo-continuation",
      runId: source.id, action: "issue.todo_continuation_decided",
      entityType: "issue", entityId: after.id,
      details: { outcome: "requested", attempt: nextAttempt, maxAttempts: MAX_AGENT_TODO_CONTINUATIONS },
    });
    return "requested";
  });
}
