---
name: incremental-commits
description: Commit work in small, focused, verified increments instead of one large commit at the end. Use during any multi-step coding task — features, refactors, bug fixes, migrations — to commit at each logical checkpoint (a passing test, a self-contained change) with a clear message. Triggers when a change spans multiple steps or files, or when the user says "commit as you go", "smaller commits", "commit often", or "checkpoint".
---

# Incremental commits

Work in small, reviewable steps and commit each one the moment it stands on its own.
Many small commits beat one giant commit — easier to review, revert, bisect, and
understand later.

## When to commit
Commit at every logical checkpoint, for example:
- a test passes for a new unit of behavior
- a self-contained change compiles / typechecks cleanly
- you finished one item before starting the next
- right before a risky or large operation (refactor, dependency bump, file move/rename)
- before switching context to a different concern

Rule of thumb: a commit roughly every cohesive change — not one commit at the end of a
big multi-part task.

## Rules
- **One logical change per commit.** Don't bundle unrelated edits. If the message needs
  "and" to describe it, split it.
- **Verify before committing.** Run the cheapest relevant check first (typecheck → unit
  tests → lint → build). Don't commit known-broken code unless you're deliberately
  checkpointing work-in-progress, and then prefix the message `wip:`.
- **Stage explicitly.** `git add <specific paths>` for this change — avoid `git add -A` so
  unrelated working-tree changes (and never secrets/artifacts) don't ride along.
- **Clear messages.** Imperative subject ≤ ~72 chars with a conventional prefix where it
  fits (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`, `build:`). Add a body
  only when the *why* isn't obvious from the diff.
- **Keep diffs small.** A reviewer should grasp a single commit in under a minute.
- **Don't push unless asked.** Commit locally as you go; push when the user requests it. If
  you're on the default branch and the change is non-trivial, branch first.

## Anti-patterns
- One 50-file commit dumped at the end of a session.
- `wip` / `stuff` / `fixes` messages that carry no signal.
- Committing build artifacts, generated files, or secrets (respect `.gitignore`).
- Mixing formatting-only churn with logic changes in the same commit.

## Rhythm
`change → verify → git add <paths> → commit (focused message) → repeat`
