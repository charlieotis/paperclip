# Maintained deployment and Astra support

## Release source
The homeservica/release branch is the maintained deployment source.
Base: upstream v2026.824.1 plus the three existing heartbeat commits.
The upgrade/astra-maintained-release PR adds upstream commit
77312ee2d96f18cd1297c0d644fcaf4b86cc5dcf (paperclipai/paperclip#12851).
This is a targeted backport, not a full upstream version upgrade.
There are no dependency, database schema, or migration changes.
The default model stays gpt-5.6-sol; Astra becomes selectable.

## Preserved customizations
- Heartbeat control-plane load and deferred handoff recovery: existing commits
  fcfc07eeb, 624add745, 60854189b; upstream PRs #12770 and #12671 remain open.
- Agent environment secret filtering: commit 31ceb6acf; upstream #12870
  remains open. Both CLI and ACP deployment bridges remain.
- Index-friendly issue run/cost queries: commit e5b074b82; upstream #12647
  remains open.
- Optional terminal-workspace sweep disable: commit d31e6ba79.
- Returned-to-do continuation and orphan settlement: commit 1eaf691d0,
  including existing tests and specification. Settlement bridge tracks #11576.
These commits capture the actual deployed behavior, rather than substituting
potentially different open-PR heads. No fix is dropped merely because a related
upstream PR exists.

## Backport resolution
NewIssueDialog resolves its selected agent and effective model for Astra efforts.
The unrelated later imported-agent warning test is excluded. Existing cheap-lane
handling is preserved. Other changes use the upstream patch.

## Upgrade procedure
1. Save agent status and runtime settings. Disable new starts.
2. Request durable work checkpoints and let active runs finish naturally.
3. Verify resumable issue records and worktrees, then manually pause agents.
4. Prepare an isolated upgrade branch from homeservica/release.
5. Merge a selected upstream release, or document a narrow backport. Reconcile
   each preserved customization and remove only proven upstream equivalents.
6. Run affected tests, repository typecheck, full tests and build. Record limits.
7. Back up the Paperclip database and service configuration. Check the dump.
8. Merge the upgrade PR, tag the tested commit, and deploy that exact source.
9. Verify health, model metadata, source identity, and paused agent states.
10. Resume only on operator instruction, restoring saved runtime settings first.

## Rollback
This backport leaves the database schema unchanged. Keep the old deployment
checkout and compiled assets intact. Revert the service working directory and
entry point to the prior checkout and restart with agents still paused.
Do not restore the database by default: that would discard later board writes.
For future schema-changing upgrades, test restoration into a separate database
and document schema compatibility before deployment. Never assume code-only
rollback is safe across a migration.

## External operations
Provider quota monitors and their pause reasons remain separate from the release.
Manual maintenance pauses must not be changed to quota-owned pauses.
Do not commit environment files, database dumps, credentials, old build output,
runtime sessions, or local backup files.

## Codex runtime requirement
The installed Codex CLI 0.146.0 returned HTTP 400 for gpt-6-astra:
the model requires a newer Codex version. CLI 0.156.0 was installed in a
separate versioned runtime directory and completed an ephemeral read-only
Astra smoke test using the existing subscription login (ASTRA_OK, exit 0).
Deployment pins that CLI through the service PATH. Keep the previous global
CLI intact for rollback. This does not switch agent models or resume agents.

## Initial verification
The 14-file focused suite passed 276 tests. The additional guard suite passed
131 tests, including both secret-filtering paths; one dependency-scheduling
test exceeded its five-second timeout during concurrent validation and requires
an isolated rerun. Repository-wide validation results are recorded in the PR.

## Fork CI
The existing PR workflow now also targets homeservica/release, so upgrades
receive the upstream build/test/typecheck gates. The commitperclip review bot
runs only in paperclipai/paperclip because its app credentials and installation
belong to upstream. Its initial fork run failed before code analysis because
dependency review was unavailable; it would also require the upstream bot key.
This upstream-only bot is not a substitute for the normal PR checks.
