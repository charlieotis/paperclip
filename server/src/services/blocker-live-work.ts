type BlockerWorkNode = { id: string; companyId: string; status: string };
type BlockerWorkEdge = { blockerIssueId: string };

/** Test reachability, without expanding each distinct path through shared blockers. */
export function hasReachableBlockerWork(
  nodeId: string,
  companyId: string,
  nodesById: ReadonlyMap<string, BlockerWorkNode>,
  edgesByIssueId: ReadonlyMap<string, readonly BlockerWorkEdge[]>,
  activeIssueIds: ReadonlySet<string>,
  pendingFinalizeBlockerIssueIds: ReadonlySet<string>,
  excludedIds: ReadonlySet<string>,
): boolean {
  const seen = new Set(excludedIds);
  const pending = [nodeId];
  while (pending.length > 0) {
    const currentId = pending.pop()!;
    if (seen.has(currentId)) continue;
    seen.add(currentId);
    const node = nodesById.get(currentId);
    if (!node || node.companyId !== companyId) continue;
    if (node.status === "in_progress" || activeIssueIds.has(node.id)) return true;
    for (const edge of edgesByIssueId.get(node.id) ?? []) {
      const blocker = nodesById.get(edge.blockerIssueId);
      if (blocker?.status === "done" && !pendingFinalizeBlockerIssueIds.has(edge.blockerIssueId)) continue;
      pending.push(edge.blockerIssueId);
    }
  }
  return false;
}
