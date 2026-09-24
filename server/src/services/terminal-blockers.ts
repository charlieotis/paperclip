/**
 * Return each reachable terminal blocker once. A path-local visited set expands
 * reconverging dependency graphs exponentially before callers can deduplicate.
 * Only reachability matters here, so share one visited set for the whole root.
 */
export function collectTerminalBlockers<T extends { id: string; status: string }>(
  rootId: string,
  nodesById: ReadonlyMap<string, T>,
  edgesByIssueId: ReadonlyMap<string, readonly string[]>,
): T[] {
  const seen = new Set<string>();
  const pending = [rootId];
  const terminal: T[] = [];
  while (pending.length > 0) {
    const issueId = pending.pop()!;
    if (seen.has(issueId)) continue;
    seen.add(issueId);
    const node = nodesById.get(issueId);
    if (!node || node.status === "done") continue;
    const downstreamIds = edgesByIssueId.get(issueId) ?? [];
    if (downstreamIds.length === 0) {
      terminal.push(node);
      continue;
    }
    // Preserve depth-first edge order; the caller sorts the final summaries.
    for (let index = downstreamIds.length - 1; index >= 0; index -= 1) {
      pending.push(downstreamIds[index]!);
    }
  }
  return terminal;
}
