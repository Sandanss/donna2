---
name: commit-process
description: Donna commit & PR workflow. Use whenever the user asks to commit, ship, push, merge, or create a PR for changes intended for `main`. Codifies the two-step flow — commit to the developer's personal `<name>dev` integration branch first, then PR from there to `main`. Branch protection on `main` rejects direct pushes; this skill is the only safe path.
---

# Commit & PR Process

Donna's `main` branch is GitHub-protected: direct pushes are rejected with `GH013` because two status checks are required. Every change reaches `main` via a PR from a developer's **personal integration branch**.

## Branch naming

Each contributor has a long-lived integration branch named `<lowercase-first-name>dev`:

- David Zuluaga → `zuludev`
- Facu (Facundo) → `facudev`

That branch is where you commit. The PR is `<name>dev → main`.

## When this skill applies

Invoke whenever the user says any of:

- "commit", "commit this", "commit and push"
- "ship it", "merge it", "merge to main"
- "push", "open a PR", "create a PR"
- Any phrasing that implies sending changes to `main`

It applies to changes already in the working tree or just authored in this session.

## The flow

### 1. Identify the developer's dev branch

```bash
git config user.name        # → "David Zuluaga" or "Facundo …"
git branch | grep -E 'dev$'  # → list of local *dev branches
```

Map name → branch:

- First word of `user.name`, lowercased + `dev` (e.g., `david` → `zuludev` is non-obvious; David uses `zuludev` not `daviddev`. The mapping is per-person — verify with the local branch list.)
- If `zuludev` is a local branch and there's no other `*dev` branch, you're David.
- If `facudev` is local, you're Facu.
- If ambiguous (multiple `*dev` branches, none matches), ask the user once.

If the branch doesn't exist locally yet, fetch it: `git fetch origin <name>dev && git checkout <name>dev`. If it doesn't exist on `origin` either, ask before creating it — that's an organizational change.

### 2. Stage explicitly, never `git add -A`

Stage only the files relevant to the work you just did:

```bash
git add path/to/file1 path/to/file2
```

Inspect `git status` for unrelated modifications (other people's in-progress work, generated files, `.env`). Do **not** bundle them into your commit. If unsure whether a file is part of the change, ask.

### 3. Commit on the dev branch

```bash
git checkout <name>dev
# stage as above
git commit -m "$(cat <<'EOF'
<type>: <specific, descriptive subject>

<optional body explaining the why>

Co-Authored-By: <agent attribution if generated>
EOF
)"
```

Commit subject style (matches recent `git log`): `<type>: <what changed and why>`. Be specific — `feat: surface follow-up suggestions from call analysis in system prompt` is good; `feat: update memory system` is bad.

If a pre-commit hook fails, fix the underlying issue and create a **new** commit. Never use `--no-verify`. Never `--amend` after a failed hook — the commit didn't happen, and `--amend` would rewrite the previous one.

### 4. Push the dev branch

```bash
git push origin <name>dev
```

If the push is rejected because remote `<name>dev` has diverged, do **not** force-push without asking — someone else may have pushed work to it. Investigate first (`git fetch && git log origin/<name>dev..HEAD` and `git log HEAD..origin/<name>dev`).

### 5. Open a PR only after explicit confirmation

PR creation is visible to others. Even after the user said "ship it", confirm before running `gh pr create` unless they explicitly authorized PR creation in advance.

```bash
gh pr create \
  --base main \
  --head <name>dev \
  --title "<type>: <specific subject>" \
  --body "$(cat <<'EOF'
## Summary

<1-3 bullets on what changed>

## Test plan

- [ ] <testable checks>

EOF
)"
```

If a PR from `<name>dev → main` is already open, **do not open a second one** — the new commits will appear in the existing PR automatically once pushed. Surface the existing PR URL instead.

## Guardrails

- **Never `git push origin main`** directly. It will be rejected, and even attempting it suggests the wrong mental model.
- **Never `git push --force` to `main`** under any circumstance.
- **Never `--no-verify`**, `--no-gpg-sign`, or any signature/hook bypass unless the user has explicitly asked for it in this session.
- **Never bundle unrelated working-tree modifications** into a commit.
- **Never amend a published commit** without the user asking.
- **Never delete or rebase `<name>dev`** without asking — it's long-lived.
- If a destructive operation seems necessary (`git reset --hard`, branch delete, force-push to a feature branch), pause and confirm with the user first.

## Exceptions

These are valid reasons to deviate, but call them out:

- **Topic branch off `main`** (e.g., `docs/foo`, `fix/bar`) when the user explicitly wants to isolate work from their dev branch — useful for hotfixes that shouldn't carry along other in-flight dev-branch changes.
- **Existing topic branch already open as a PR** (like `docs/audit-logs-partitioning-roadmap` from PR #292) — keep using it; don't migrate mid-flight.

If you deviate, say so in the user-facing summary.

## After the PR is open

- Report the PR URL.
- Note the 2 required status checks must pass before merge.
- Don't auto-merge. Wait for the user.
- After the PR merges, the next change starts fresh: rebase `<name>dev` on the new `main` (`git checkout <name>dev && git fetch origin && git rebase origin/main`) before continuing work.
