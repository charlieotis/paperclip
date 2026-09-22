import { enqueueAgentTodoContinuation, AGENT_TODO_CONTINUATION_REASON } from "../services/issue-todo-continuation.js";
import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companies,
  companySkills,
  createDb,
  environmentLeases,
  environments,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { runningProcesses } from "../adapters/index.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Issue rewake throttle test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue rewake throttle tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("agent todo continuation", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-issue-rewake-throttle-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    mockAdapterExecute.mockClear();
    runningProcesses.clear();
    // Await every in-flight background heartbeat run to quiescence before the
    // deletes below. A wakeup claims a run and dispatches its execution
    // fire-and-forget, and that run can dispatch a follow-up wakeup, so a run or
    // wakeup can still write heartbeat_runs and issues rows when teardown starts
    // and would race the deletes (a heartbeat_runs delete deadlocks on the ON
    // DELETE SET NULL cascade to issues). The shared drain also awaits an
    // in-flight wakeup that is still before run registration, which a plain run
    // table status poll cannot see.
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    // Post-run bookkeeping (run-event records, follow-up wake scheduling) can
    // still write for a moment after a run reaches a terminal status, so a
    // single delete sweep can hit a foreign-key violation when a late insert
    // lands between two deletes. Retry the sweep until it goes through clean.
    for (let attempt = 0; ; attempt += 1) {
      try {
        await db.delete(environmentLeases);
        await db.delete(issueComments);
        await db.delete(issues);
        await db.delete(heartbeatRunEvents);
        await db.delete(activityLog);
        await db.delete(heartbeatRuns);
        await db.delete(agentWakeupRequests);
        await db.delete(agentRuntimeState);
        await db.delete(agents);
        await db.delete(environments);
        await db.delete(executionWorkspaces);
        await db.delete(companySkills);
        await db.delete(companies);
        break;
      } catch (error) {
        if (attempt >= 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    mockAdapterExecute.mockReset();
    mockAdapterExecute.mockResolvedValue({ exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "Completed.", provider: "test", model: "test-model" });
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });


  async function seed(attempt = 0) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Todo continuation test",
      issuePrefix: "T" + companyId.replace(/-/g, "").slice(0, 6), requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "responsible-user" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Engineer", role: "engineer",
      status: "active", adapterType: "codex_local", adapterConfig: {}, permissions: {},
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 8 } } });
    const [issue] = await db.insert(issues).values({ id: issueId, companyId, title: "Continue bounded work",
      status: "todo", priority: "medium", responsibleUserId: "responsible-user", assigneeAgentId: agentId }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId,
      invocationSource: "assignment", status: "running", responsibleUserId: "responsible-user", startedAt: new Date(),
      contextSnapshot: { issueId, agentTodoContinuationAttempt: attempt } }).returning();
    return { issue, run, actor: { actorType: "agent", actorId: agentId, agentId, runId: run.id } };
  }

  function fakeWake() {
    return vi.fn(async (agentId: string, opts: any) => {
      const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
      await db.insert(agentWakeupRequests).values({ companyId: agent.companyId, agentId,
        source: opts.source, reason: opts.reason, payload: opts.payload,
        status: "deferred_issue_execution", idempotencyKey: opts.idempotencyKey });
      return null;
    });
  }

  it("serializes duplicate returns from the same source run and preserves the attempt", async () => {
    const { issue, actor } = await seed(1);
    const wakeup = fakeWake(), onExhausted = vi.fn();
    const input = { before: { ...issue, status: "in_progress" }, after: issue, actor, wakeup, onExhausted };
    const results = await Promise.all([
      enqueueAgentTodoContinuation(db, input), enqueueAgentTodoContinuation(db, input),
    ]);
    expect(results.sort()).toEqual(["duplicate", "requested"]);
    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(wakeup.mock.calls[0][1].contextSnapshot).toMatchObject({
      wakeReason: AGENT_TODO_CONTINUATION_REASON, agentTodoContinuationAttempt: 2,
      agentTodoContinuationSourceRunId: actor.runId,
    });
    expect(onExhausted).not.toHaveBeenCalled();
  });

  it("stops at three follow-ups and reports exhaustion only once", async () => {
    const { issue, actor } = await seed(3);
    const wakeup = fakeWake(), onExhausted = vi.fn(async () => undefined);
    const input = { before: { ...issue, status: "in_progress" }, after: issue, actor, wakeup, onExhausted };
    expect(await enqueueAgentTodoContinuation(db, input)).toBe("exhausted");
    expect(await enqueueAgentTodoContinuation(db, input)).toBe("duplicate");
    expect(wakeup).not.toHaveBeenCalled();
    expect(onExhausted).toHaveBeenCalledTimes(1);
  });

  it.each(["done", "blocked", "in_review"])("does not wake work changed to %s", async (status) => {
    const { issue, actor } = await seed();
    await db.update(issues).set({ status }).where(eq(issues.id, issue.id));
    const wakeup = fakeWake();
    expect(await enqueueAgentTodoContinuation(db, {
      before: { ...issue, status: "in_progress" }, after: issue, actor, wakeup, onExhausted: vi.fn(),
    })).toBe("ignored");
    expect(wakeup).not.toHaveBeenCalled();
  });

  it("rejects a source run from another company", async () => {
    const first = await seed(), second = await seed();
    const wakeup = fakeWake();
    expect(await enqueueAgentTodoContinuation(db, {
      before: { ...first.issue, status: "in_progress" }, after: first.issue,
      actor: { ...first.actor, runId: second.run.id }, wakeup, onExhausted: vi.fn(),
    })).toBe("ignored");
    expect(wakeup).not.toHaveBeenCalled();
  });

  it.each(["continue", "done", "blocked", "in_review", "reassigned", "failed"])("handles a deferred follow-up when the source outcome is %s", async (outcome) => {
    const { issue, run: seedRun } = await seed();
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, seedRun.id));
    let finishSource!: () => void;
    const sourceFinished = new Promise<void>((resolve) => { finishSource = resolve; });
    mockAdapterExecute.mockImplementationOnce(async () => {
      await sourceFinished;
      return { exitCode: outcome === "failed" ? 1 : 0, signal: null, timedOut: false, errorMessage: null, summary: "Committed a bounded slice.", provider: "test", model: "test-model" };
    }).mockImplementationOnce(async () => {
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, issue.id));
      return { exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "Completed the remaining work.", provider: "test", model: "test-model" };
    });
    const source = await heartbeat.wakeup(issue.assigneeAgentId!, {
      source: "on_demand", reason: "issue_commented", requestedByActorType: "user", requestedByActorId: "test",
      payload: { issueId: issue.id }, contextSnapshot: { issueId: issue.id, wakeReason: "issue_commented" },
    });
    expect(source).not.toBeNull();
    try {
      await vi.waitFor(() => expect(mockAdapterExecute).toHaveBeenCalled(), { timeout: 10000 });
      await db.update(issues).set({ status: "todo" }).where(eq(issues.id, issue.id));
      expect(await enqueueAgentTodoContinuation(db, {
        before: { ...issue, status: "in_progress" }, after: issue,
        actor: { actorType: "agent", actorId: issue.assigneeAgentId!, agentId: issue.assigneeAgentId, runId: source!.id },
        wakeup: heartbeat.wakeup, onExhausted: vi.fn(),
      })).toBe("requested");
      const pending = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey,
        AGENT_TODO_CONTINUATION_REASON + ":" + issue.id + ":" + source!.id));
      expect(pending[0]?.status).toBe("deferred_issue_execution");
      expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
      if (["done", "blocked", "in_review"].includes(outcome)) {
        await db.update(issues).set({ status: outcome }).where(eq(issues.id, issue.id));
      } else if (outcome === "reassigned") {
        await db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, issue.id));
      }
      finishSource();
      if (outcome !== "continue") {
        await vi.waitFor(async () => {
          const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, pending[0].id));
          expect(wake.status).toBe("cancelled");
        }, { timeout: 15000 });
        return;
      }
      await vi.waitFor(() => expect(mockAdapterExecute).toHaveBeenCalledTimes(2), { timeout: 15000 });
      const followups = await db.select().from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, issue.companyId),
        sql`${heartbeatRuns.contextSnapshot} ->> 'agentTodoContinuationSourceRunId' = ${source!.id}`,
      ));
      expect(followups).toHaveLength(1);
      expect(followups[0].contextSnapshot).toMatchObject({ agentTodoContinuationAttempt: 1 });
    } finally { finishSource(); }
  }, 30000);
});
