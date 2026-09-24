import { describe, expect, it } from "vitest";
import { collectTerminalBlockers } from "../services/terminal-blockers.js";

function graph(edges: Record<string, string[]>, statuses: Record<string, string> = {}) {
  const ids = new Set([...Object.keys(edges), ...Object.values(edges).flat()]);
  return {
    nodes: new Map([...ids].map(id => [id, { id, status: statuses[id] ?? "blocked" }])),
    edges: new Map(Object.entries(edges)),
  };
}

describe("terminal blocker traversal", () => {
  it("returns shared terminal blockers once without losing sibling leaves", () => {
    const g = graph({ root: ["left", "right"], left: ["shared", "other"], right: ["shared"] });
    expect(collectTerminalBlockers("root", g.nodes, g.edges).map(n => n.id)).toEqual(["shared", "other"]);
  });

  it("bounds work on a layered, reconverging graph", () => {
    const edges: Record<string, string[]> = {};
    let previous = ["root"];
    for (let depth = 0; depth < 30; depth += 1) {
      const next = [`a-${depth}`, `b-${depth}`];
      for (const id of previous) edges[id] = next;
      previous = next;
    }
    const g = graph(edges);
    let reads = 0;
    const originalGet = g.nodes.get.bind(g.nodes);
    g.nodes.get = (id: string) => {
      // A deterministic guard makes the old exponential traversal fail fast,
      // rather than hanging the test process or relying on wall-clock timing.
      if (++reads > g.nodes.size * 4) throw new Error("Repeated dependency expansion");
      return originalGet(id);
    };
    expect(collectTerminalBlockers("root", g.nodes, g.edges).map(n => n.id)).toEqual(previous);
    expect(reads).toBeLessThanOrEqual(g.nodes.size);
  });

  it("terminates cycles and still finds exits without treating the cycle as a leaf", () => {
    const g = graph({ root: ["a"], a: ["b"], b: ["a", "leaf"] });
    expect(collectTerminalBlockers("root", g.nodes, g.edges).map(n => n.id)).toEqual(["leaf"]);
    const cycle = graph({ root: ["a"], a: ["root"] });
    expect(collectTerminalBlockers("root", cycle.nodes, cycle.edges)).toEqual([]);
  });

  it("keeps cancelled blockers and excludes done or missing nodes", () => {
    const g = graph({ root: ["done", "cancelled", "missing"], done: ["hidden"] }, { done: "done", cancelled: "cancelled" });
    g.nodes.delete("missing");
    expect(collectTerminalBlockers("root", g.nodes, g.edges).map(n => n.id)).toEqual(["cancelled"]);
  });

  it("keeps traversal state independent for each root", () => {
    const g = graph({ first: ["shared"], second: ["shared"] });
    expect(collectTerminalBlockers("first", g.nodes, g.edges).map(n => n.id)).toEqual(["shared"]);
    expect(collectTerminalBlockers("second", g.nodes, g.edges).map(n => n.id)).toEqual(["shared"]);
  });

  it("handles deep chains without recursive stack growth", () => {
    const edges: Record<string, string[]> = {};
    for (let i = 0; i < 20000; i += 1) edges[String(i)] = [String(i + 1)];
    const g = graph(edges);
    expect(collectTerminalBlockers("0", g.nodes, g.edges).map(n => n.id)).toEqual(["20000"]);
  });
});
