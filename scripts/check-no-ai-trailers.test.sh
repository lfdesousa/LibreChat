#!/usr/bin/env bash
#
# Acceptance matrix for the no-AI-trailer guard (scripts/check-no-ai-trailers.sh).
#
# Every case runs against a throwaway git repository and asserts a SIDE EFFECT
# — was the commit actually created? did the remote ref actually move? — never
# an exit code alone. A case that only checked the exit status would stay green
# if the guard were deleted and something else happened to fail.
#
# The three enforcement layers are exercised separately, because a guard proven
# at one layer is one `--no-verify` away from decorative:
#
#   A. commit-msg hook   (.husky/commit-msg)   — refuses the commit
#   B. pre-push hook     (.husky/pre-push)     — refuses the push
#   C. range mode        (the CI job)          — refuses the PR
#
# To prove any single layer non-vacuous, neuter THAT layer alone (comment out
# the invocation in its hook, or one alternative in the predicate), re-run, and
# confirm the matching positive control flips to ACCEPTED. Never neuter more
# than one at a time: a batch neuter cannot tell a live guard from a dead one.
#
# Usage: scripts/check-no-ai-trailers.test.sh        (no arguments)

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GUARD="$REPO_ROOT/scripts/check-no-ai-trailers.sh"
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

PASS_COUNT=0
FAIL_COUNT=0
REPO=''


TRAILER_CLAUDE='Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>'
TRAILER_DEPENDABOT='Co-Authored-By: dependabot[bot] <support@github.com>'
TRAILER_HUMAN='Co-Authored-By: A Human <human@example.com>'
TRAILER_SESSION='Claude-Session: https://claude.ai/code/session_01HNoc4HvEPH5HPpBPnjrZ9u'
TRAILER_LOWER='co-authored-by: Claude Opus 5 <noreply@anthropic.com>'
TRAILER_MIXED='CO-AuThOrEd-By: Claude Opus 5 <noreply@anthropic.com>'
PROSE_FALSE_POSITIVE='No Co-Authored-By. No push.'
PROSE_MID_SENTENCE='The reviewer asked whether Co-Authored-By: lines are ever allowed.'

ok() {
  PASS_COUNT=$((PASS_COUNT + 1))
  printf 'PASS  %s\n' "$1"
}

ko() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  printf 'FAIL  %s\n      %s\n' "$1" "$2"
}

section() {
  printf '\n== %s\n' "$1"
}

# A sandbox repo with the REAL hook files installed via core.hooksPath and the
# REAL guard script. (husky's .husky/_ wrapper only re-executes the same hook
# file under `sh -e`; it is generated, gitignored, and absent in CI, so the
# hooks are invoked directly here.)
# Refuse to touch anything outside the throwaway workdir. An empty or
# unexpected repo path would make `git -C` operate on the REAL repository:
# during development of this harness exactly that happened and pushed two junk
# refs to the fork's origin. Every helper that takes a repo path asserts first.
assert_sandbox() {
  case "${1:-}" in
    "$WORKDIR"/*) ;;
    *)
      printf 'FATAL: refusing to operate on %s (outside %s)\n' "${1:-<empty>}" "$WORKDIR" >&2
      exit 1
      ;;
  esac
}

new_repo() {
  local name="${1:-}"
  if [ -z "$name" ]; then
    printf 'FATAL: new_repo called without a name\n' >&2
    exit 1
  fi
  local repo="$WORKDIR/$name"
  assert_sandbox "$repo"
  mkdir -p "$repo/.githooks" "$repo/scripts"
  git -C "$repo" init --quiet --initial-branch=main
  git -C "$repo" config user.name 'Guard Test'
  git -C "$repo" config user.email 'guard-test@example.invalid'
  git -C "$repo" config commit.gpgsign false
  cp "$REPO_ROOT/.husky/commit-msg" "$repo/.githooks/commit-msg"
  cp "$REPO_ROOT/.husky/pre-push" "$repo/.githooks/pre-push"
  cp "$GUARD" "$repo/scripts/check-no-ai-trailers.sh"
  chmod +x "$repo/.githooks/commit-msg" "$repo/.githooks/pre-push" \
    "$repo/scripts/check-no-ai-trailers.sh"
  git -C "$repo" config core.hooksPath .githooks
  printf 'seed\n' >"$repo/seed.txt"
  git -C "$repo" add seed.txt
  # --no-verify on the seed so a neutered guard cannot change the baseline.
  git -C "$repo" commit --quiet --no-verify -m 'chore: seed' >/dev/null 2>&1
  # A sandbox that failed to seed would make every "refused" assertion pass
  # for the wrong reason. Fail the whole run instead.
  if [ "$(git -C "$repo" rev-list --count HEAD 2>/dev/null || echo 0)" != 1 ]; then
    printf 'FATAL: sandbox repo %s failed to seed\n' "$repo" >&2
    exit 1
  fi
  REPO="$repo"
}

commit_count() {
  git -C "$1" rev-list --count HEAD 2>/dev/null || echo 0
}

# Try to commit a staged change with the given message body. Echoes "created"
# or "refused" based on the SIDE EFFECT (did the commit count move?), not on
# git's exit code.
try_commit() {
  local repo="$1" body="$2" before after
  assert_sandbox "$repo"
  before="$(commit_count "$repo")"
  printf '%s\n' "$RANDOM$RANDOM" >>"$repo/seed.txt"
  git -C "$repo" add seed.txt
  printf '%s\n' "$body" >"$repo/.git/TEST_MSG"
  git -C "$repo" commit --quiet -F "$repo/.git/TEST_MSG" >/dev/null 2>&1
  after="$(commit_count "$repo")"
  if [ "$after" -gt "$before" ]; then
    echo created
  else
    git -C "$repo" reset --quiet HEAD -- seed.txt
    git -C "$repo" checkout --quiet -- seed.txt
    echo refused
  fi
}

expect_commit_refused() {
  local label="$1" body="$2" repo result
  new_repo "$(tr -dc 'a-z0-9' </dev/urandom | head -c 12)"
  repo="$REPO"
  result="$(try_commit "$repo" "$body")"
  if [ "$result" = refused ]; then
    ok "$label"
  else
    ko "$label" "commit WAS created; the guard did not refuse it"
  fi
}

expect_commit_created() {
  local label="$1" body="$2" repo result
  new_repo "$(tr -dc 'a-z0-9' </dev/urandom | head -c 12)"
  repo="$REPO"
  result="$(try_commit "$repo" "$body")"
  if [ "$result" = created ]; then
    ok "$label"
  else
    ko "$label" "commit was REFUSED; the guard fired on a legitimate message"
  fi
}

# Push $branch to a bare remote and report the SIDE EFFECT: did the remote ref
# actually move to the local tip?
# Give a sandbox a bare remote seeded with the baseline commit only. Call this
# BEFORE creating the commits under test: the pre-push scan excludes commits
# already on the remote, so seeding afterwards would hide them.
attach_remote() {
  local repo="$1"
  assert_sandbox "$repo"
  local remote="$repo-remote.git"
  git init --quiet --bare "$remote"
  git -C "$repo" remote add origin "$remote"
  git -C "$repo" push --quiet --no-verify origin "HEAD:refs/heads/base" >/dev/null 2>&1
}

try_push() {
  local repo="$1" branch="${2:-main}" remote_before remote_after local_tip
  assert_sandbox "$repo"
  local remote="$repo-remote.git"
  remote_before="$(git -C "$remote" rev-parse "refs/heads/$branch" 2>/dev/null || echo none)"
  git -C "$repo" push --quiet origin "$branch:refs/heads/$branch" >/dev/null 2>&1
  remote_after="$(git -C "$remote" rev-parse "refs/heads/$branch" 2>/dev/null || echo none)"
  local_tip="$(git -C "$repo" rev-parse "$branch")"
  if [ "$remote_after" = "$local_tip" ] && [ "$remote_after" != "$remote_before" ]; then
    echo pushed
  else
    echo rejected
  fi
}

# Commit bypassing the commit-msg hook — the real-world shape this layer
# exists for: a trailer that got past (or predates) the local hook.
commit_bypassing_hook() {
  local repo="$1" body="$2"
  assert_sandbox "$repo"
  printf '%s\n' "$RANDOM$RANDOM" >>"$repo/seed.txt"
  git -C "$repo" add seed.txt
  printf '%s\n' "$body" >"$repo/.git/TEST_MSG"
  git -C "$repo" commit --quiet --no-verify -F "$repo/.git/TEST_MSG" >/dev/null 2>&1
}

# ---------------------------------------------------------------------------
section 'LAYER A - commit-msg hook: positive controls (must be REFUSED)'
# ---------------------------------------------------------------------------
expect_commit_refused 'A1 Claude trailer refused' \
  "feat: thing

$TRAILER_CLAUDE"
expect_commit_refused 'A2 dependabot trailer refused (no allow-list)' \
  "chore(deps): bump thing

$TRAILER_DEPENDABOT"
expect_commit_refused 'A3 human co-author trailer refused (no allow-list)' \
  "feat: thing

$TRAILER_HUMAN"
expect_commit_refused 'A4 Claude-Session trailer refused' \
  "feat: thing

$TRAILER_SESSION"
expect_commit_refused 'A5 lower-case key refused' \
  "feat: thing

$TRAILER_LOWER"
expect_commit_refused 'A6 mixed-case key refused' \
  "feat: thing

$TRAILER_MIXED"
expect_commit_refused 'A7 indented trailer refused' \
  "feat: thing

   $TRAILER_CLAUDE"
expect_commit_refused 'A8 trailer buried mid-body refused' \
  "feat: thing

$TRAILER_CLAUDE

Refs: #1"

# ---------------------------------------------------------------------------
section 'LAYER A - commit-msg hook: negative controls (must PASS unblocked)'
# ---------------------------------------------------------------------------
expect_commit_created 'A9 clean commit passes' \
  'feat: a perfectly ordinary commit'
expect_commit_created 'A10 PROSE "No Co-Authored-By. No push." passes' \
  "feat: thing

Handoff rules: $PROSE_FALSE_POSITIVE"
expect_commit_created 'A11 mid-sentence mention passes' \
  "feat: thing

$PROSE_MID_SENTENCE"
expect_commit_created 'A12 body word "Co-Authored-By" without a colon passes' \
  'docs: explain why Co-Authored-By trailers are banned'
expect_commit_created 'A13 body LINE STARTING "Co-Authored-By" without a colon passes' \
  "docs: document the guard

Co-Authored-By trailers are banned in this repo, whoever is named."

# ---------------------------------------------------------------------------
section 'LAYER B - pre-push hook (must reject the push / let it through)'
# ---------------------------------------------------------------------------
new_repo push-positive
B_REPO="$REPO"
attach_remote "$B_REPO"
commit_bypassing_hook "$B_REPO" "feat: sneaks past the local hook

$TRAILER_CLAUDE"
if [ "$(try_push "$B_REPO")" = rejected ]; then
  ok 'B1 push of a --no-verify trailer commit rejected (remote ref did not move)'
else
  ko 'B1 push of a --no-verify trailer commit rejected' 'the remote ref MOVED; the push was accepted'
fi

new_repo push-stale-tip
B_REPO2="$REPO"
attach_remote "$B_REPO2"
commit_bypassing_hook "$B_REPO2" "feat: the trailer-bearing commit

$TRAILER_SESSION"
commit_bypassing_hook "$B_REPO2" 'feat: a clean commit on top'
if [ "$(try_push "$B_REPO2")" = rejected ]; then
  ok 'B2 trailer deeper in the push range rejected (not just the tip)'
else
  ko 'B2 trailer deeper in the push range rejected' 'the remote ref MOVED; the range scan missed it'
fi

new_repo push-clean
B_REPO3="$REPO"
attach_remote "$B_REPO3"
commit_bypassing_hook "$B_REPO3" 'feat: an ordinary commit'
if [ "$(try_push "$B_REPO3")" = pushed ]; then
  ok 'B3 clean push accepted'
else
  ko 'B3 clean push accepted' 'the push was REJECTED; the guard fired on a clean range'
fi

new_repo push-prose
B_REPO4="$REPO"
attach_remote "$B_REPO4"
commit_bypassing_hook "$B_REPO4" "feat: thing

Handoff rules: $PROSE_FALSE_POSITIVE"
if [ "$(try_push "$B_REPO4")" = pushed ]; then
  ok 'B4 push of a PROSE "No Co-Authored-By" commit accepted'
else
  ko 'B4 push of a PROSE "No Co-Authored-By" commit accepted' 'the push was REJECTED on prose'
fi

new_repo push-new-branch
B_REPO5="$REPO"
attach_remote "$B_REPO5"
commit_bypassing_hook "$B_REPO5" "feat: thing

$TRAILER_HUMAN"
git -C "$B_REPO5" checkout --quiet -b feature/new
if [ "$(try_push "$B_REPO5" feature/new)" = rejected ]; then
  ok 'B5 first push of a NEW branch (zero remote oid) rejected'
else
  ko 'B5 first push of a NEW branch (zero remote oid) rejected' 'the remote ref MOVED'
fi

# ---------------------------------------------------------------------------
section 'LAYER C - range mode (what the CI job runs)'
# ---------------------------------------------------------------------------
new_repo range-scope
C_REPO="$REPO"
# Pre-existing history carrying a trailer, as an upstream merge could import.
commit_bypassing_hook "$C_REPO" "docs: an inherited upstream commit

$TRAILER_HUMAN"
BASE_SHA="$(git -C "$C_REPO" rev-parse HEAD)"
git -C "$C_REPO" checkout --quiet -b feature/pr
commit_bypassing_hook "$C_REPO" 'feat: a clean PR commit'
commit_bypassing_hook "$C_REPO" "feat: another clean PR commit

Handoff rules: $PROSE_FALSE_POSITIVE"
HEAD_SHA="$(git -C "$C_REPO" rev-parse HEAD)"

if (cd "$C_REPO" && ./scripts/check-no-ai-trailers.sh --range "$BASE_SHA..$HEAD_SHA" >/dev/null 2>&1); then
  ok 'C1 PR-scoped range passes over inherited history (history control)'
else
  ko 'C1 PR-scoped range passes over inherited history' 'the PR-scoped scan FAILED on a clean PR'
fi

if (cd "$C_REPO" && ./scripts/check-no-ai-trailers.sh --range "$HEAD_SHA" >/dev/null 2>&1); then
  ko 'C2 full history WOULD fail (proves C1 is scoping, not luck)' \
    'the full-history scan passed; C1 proves nothing about scoping'
else
  ok 'C2 full history WOULD fail (proves C1 is scoping, not luck)'
fi

commit_bypassing_hook "$C_REPO" "feat: a PR commit with a trailer

$TRAILER_CLAUDE"
DIRTY_HEAD="$(git -C "$C_REPO" rev-parse HEAD)"
if (cd "$C_REPO" && ./scripts/check-no-ai-trailers.sh --range "$BASE_SHA..$DIRTY_HEAD" >/dev/null 2>&1); then
  ko 'C3 PR-scoped range fails on a trailer in the PR' 'the scan PASSED a trailer-bearing PR'
else
  ok 'C3 PR-scoped range fails on a trailer in the PR'
fi

C4_OUTPUT="$( (cd "$C_REPO" && ./scripts/check-no-ai-trailers.sh --range "$BASE_SHA..$DIRTY_HEAD") 2>&1 )"
if printf '%s' "$C4_OUTPUT" | grep -qF "$DIRTY_HEAD"; then
  ok 'C4 the report names the offending commit'
else
  ko 'C4 the report names the offending commit' 'the offending sha is not in the output'
fi

# ---------------------------------------------------------------------------
section 'MESSAGE NORMALIZATION - git --verbose diffs must not false-positive'
# ---------------------------------------------------------------------------
VERBOSE_MSG="$WORKDIR/verbose-msg"
{
  printf 'feat: edit the guard fixtures\n\n'
  printf '# Please enter the commit message for your changes.\n'
  printf '# %s\n' "$TRAILER_CLAUDE"
  printf '# ------------------------ >8 ------------------------\n'
  printf 'diff --git a/x b/x\n'
  printf ' %s\n' "$TRAILER_CLAUDE"
  printf '+%s\n' "$TRAILER_SESSION"
} >"$VERBOSE_MSG"
if (cd "$REPO_ROOT" && "$GUARD" --message "$VERBOSE_MSG" >/dev/null 2>&1); then
  ok 'N1 commented lines and the verbose diff below the scissors are ignored'
else
  ko 'N1 commented lines and the verbose diff below the scissors are ignored' \
    'the guard fired on text git itself strips from the message'
fi

REAL_MSG="$WORKDIR/real-msg"
{
  printf 'feat: edit the guard fixtures\n\n'
  printf '%s\n' "$TRAILER_CLAUDE"
  printf '# ------------------------ >8 ------------------------\n'
  printf 'diff --git a/x b/x\n'
} >"$REAL_MSG"
if (cd "$REPO_ROOT" && "$GUARD" --message "$REAL_MSG" >/dev/null 2>&1); then
  ko 'N2 a real trailer ABOVE the scissors is still caught' 'the normalizer swallowed a real trailer'
else
  ok 'N2 a real trailer ABOVE the scissors is still caught'
fi

# ---------------------------------------------------------------------------
section 'WIRING - each layer actually invokes the guard'
# ---------------------------------------------------------------------------
WORKFLOW="$REPO_ROOT/.github/workflows/no-ai-trailers.yml"
if grep -qE 'check-no-ai-trailers\.sh --range' "$WORKFLOW"; then
  ok 'W1 CI workflow invokes the guard with a range'
else
  ko 'W1 CI workflow invokes the guard with a range' 'the CI step no longer calls the guard'
fi
if grep -qE '^ *paths:' "$WORKFLOW"; then
  ko 'W2 CI workflow has no paths filter' 'a paths filter lets a PR skip the check entirely'
else
  ok 'W2 CI workflow has no paths filter'
fi
if grep -qE 'check-no-ai-trailers\.sh" --message' "$REPO_ROOT/.husky/commit-msg"; then
  ok 'W3 commit-msg hook invokes the guard'
else
  ko 'W3 commit-msg hook invokes the guard' 'the commit-msg hook no longer calls the guard'
fi
if grep -qE 'check-no-ai-trailers\.sh" --pre-push' "$REPO_ROOT/.husky/pre-push"; then
  ok 'W4 pre-push hook invokes the guard'
else
  ko 'W4 pre-push hook invokes the guard' 'the pre-push hook no longer calls the guard'
fi

printf '\n%s\n' '-----------------------------------------------'
printf 'no-ai-trailer guard: %d passed, %d failed\n' "$PASS_COUNT" "$FAIL_COUNT"
[ "$FAIL_COUNT" -eq 0 ] || exit 1
