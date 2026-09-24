import { describe, expect, it } from "vitest";
import { hasReachableBlockerWork } from "../services/blocker-live-work.js";

function graph(edges: Record<string, string[]>, statuses: Record<string, string> = {}) {
  const ids = new Set([...Object.keys(edges), ...Object.values(edges).flat()]);
  return {
    nodes: new Map([...ids].map(id => [id, { id, companyId: "company", status: statuses[id] ?? "blocked" }])),
    edges: new Map(Object.entries(edges).map(([id, targets]) => [id, targets.map(blockerIssueId => ({ blockerIssueId }))])),
  };
}
function live(g: ReturnType<typeof graph>, active = new Set<string>(), finalize = new Set<string>(), excluded = new Set<string>()) {
  return hasReachableBlockerWork("root", "company", g.nodes, g.edges, active, finalize, excluded);
}
describe("blocker live-work reachability", () => {
  it("bounds work on a reconverging graph with no live work", () => {
    const edges: Record<string, string[]> = {};
    let previous = ["root"];
    for (let depth = 0; depth < 30; depth += 1) {
      const next = [`a-${depth}`, `b-${depth}`];
      for (const id of previous) edges[id] = next;
      previous = next;
    }
    const g = graph(edges);
    let reads = 0;
    const get = g.nodes.get.bind(g.nodes);
    g.nodes.get = (id: string) => {
      if (++reads > g.nodes.size * 8) throw new Error("Repeated dependency expansion");
      return get(id);
    };
    expect(live(g)).toEqual(false);
    g.nodes.get = get;
    expect(live(g, new Set([previous[1]]))).toEqual(true);
  });

  it("finds in-progress work and active runs through shared dependencies", () => {
    const g = graph({ root: ["a", "b"], a: ["shared"], b: ["shared"] }, { shared: "in_progress" });
    expect(live(g)).toEqual(true);
    g.nodes.get("shared")!.status = "todo";
    expect(live(g, new Set(["shared"]))).toEqual(true);
    expect(live(g)).toEqual(false);
  });

  it("honors completed blockers and pending workspace finalization", () => {
    const g = graph({ root: ["done"], done: ["working"] }, { done: "done", working: "in_progress" });
    expect(live(g)).toEqual(false);
    expect(live(g, new Set(), new Set(["done"]))).toEqual(true);
  });

  it("terminates cycles, preserves root exclusions and finds other live paths", () => {
    const g = graph({ root: ["a"], a: ["root", "b"], b: ["a"] }, { root: "in_progress" });
    expect(hasReachableBlockerWork("a", "company", g.nodes, g.edges, new Set(), new Set(), new Set(["root"]))).toEqual(false);
    g.nodes.get("b")!.status = "in_progress";
    expect(hasReachableBlockerWork("a", "company", g.nodes, g.edges, new Set(), new Set(), new Set(["root"]))).toEqual(true);
  });

  it("does not cross company boundaries or follow missing nodes", () => {
    const g = graph({ root: ["foreign", "missing"], foreign: ["work"] }, { work: "in_progress" });
    g.nodes.get("foreign")!.companyId = "other";
    g.nodes.delete("missing");
    expect(live(g)).toEqual(false);
  });

  it("handles deep chains without recursive stack growth", () => {
    const edges: Record<string, string[]> = {};
    for (let i = 0; i < 20000; i += 1) edges[i === 0 ? "root" : String(i)] = [String(i + 1)];
    const g = graph(edges, { "20000": "in_progress" });
    expect(live(g)).toEqual(true);
  });
});
