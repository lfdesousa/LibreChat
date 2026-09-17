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
# Two further groups exist because a guard can fail without firing:
#
#   N/S. normalization — the text the guard declines to scan. S1-S4 are real
#        `git commit` side-effect controls for message shapes git KEEPS; S5
#        pins the one boundary layer 1 leaves open and proves layer 2 covers it.
#   FC.  fail-closed — a scan set the guard could not enumerate must be
#        REFUSED. These reach the error branches through the environment (an
#        unresolvable oid, a stubbed tool, a pass-through `git` stub that fails
#        for one argument shape only), never by editing the guard. FC9 and FC10
#        each carry a companion control (FC9c, FC10c) fixing the refusal to the
#        intended branch rather than to a broken stub.
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
    # `..` is rejected before the prefix test: "$WORKDIR/../../etc" has the
    # right prefix and is not in the sandbox.
    *..*)
      printf 'FATAL: refusing a path containing "..": %s\n' "${1:-<empty>}" >&2
      exit 1
      ;;
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

# git's literal cut line, byte-for-byte as wt_status_locate_end() matches it:
# the comment character, a space, then the marker. Built here independently of
# the guard so the controls do not inherit the guard's own idea of it.
GIT_CUT_LINE='# ------------------------ >8 ------------------------'

# Run the guard directly in a sandbox repo and report refused/accepted by exit
# status. Used for the fail-closed branches, whose observable IS the refusal:
# there is no commit to count when the guard declines to enumerate a range.
run_guard() {
  local repo="$1"
  shift
  assert_sandbox "$repo"
  if (cd "$repo" && ./scripts/check-no-ai-trailers.sh "$@" >/dev/null 2>&1); then
    echo accepted
  else
    echo refused
  fi
}

expect_guard_refuses() {
  local label="$1" repo="$2"
  shift 2
  if [ "$(run_guard "$repo" "$@")" = refused ]; then
    ok "$label"
  else
    ko "$label" 'the guard exited 0; an unenumerable scan set was reported clean'
  fi
}

# Feed git's pre-push protocol to the REAL hook, exactly as git does.
run_pre_push_hook() {
  local repo="$1" line="$2"
  assert_sandbox "$repo"
  if printf '%s\n' "$line" | (cd "$repo" && ./.githooks/pre-push origin >/dev/null 2>&1); then
    echo accepted
  else
    echo refused
  fi
}

# Put a stub earlier in PATH so a named tool fails, then run the guard. This is
# how the "the scanner itself errored" branches are reached without touching
# the guard: the failure is injected into the environment, not the code.
run_guard_with_broken_tool() {
  local repo="$1" tool="$2"
  shift 2
  assert_sandbox "$repo"
  # A FRESH stub directory per call. Sharing one directory let the previous
  # call's stub stay on PATH, so the next control passed because of the WRONG
  # broken tool.
  local bindir="$repo/brokenbin-$tool"
  rm -rf "$bindir"
  mkdir -p "$bindir"
  printf '#!/bin/sh\nexit 2\n' >"$bindir/$tool"
  chmod +x "$bindir/$tool"
  if (cd "$repo" && PATH="$bindir:$PATH" ./scripts/check-no-ai-trailers.sh "$@" >/dev/null 2>&1); then
    echo accepted
  else
    echo refused
  fi
}

# The real git binary, resolved once, so a stub can forward to it.
REAL_GIT="$(command -v git)"
GUARD_STDERR="$WORKDIR/guard-stderr"

# Build a PASS-THROUGH `git` stub in $1 that forwards every invocation to the
# real binary EXCEPT one whose argument list contains $2, which fails.
# run_guard_with_broken_tool breaks a tool outright; that is too blunt for
# `git`, which this guard calls several times before it reaches the branches
# under test. The failure is still injected through PATH, never by editing the
# guard.
make_partial_git() {
  local bindir="$1" failarg="$2"
  rm -rf "$bindir"
  mkdir -p "$bindir"
  {
    printf '#!/bin/sh\n'
    printf 'for a in "$@"; do\n'
    printf '  if [ "$a" = %s ]; then\n' "'$failarg'"
    printf '    echo "stub: refusing %s" >&2\n' "$failarg"
    printf '    exit 1\n'
    printf '  fi\n'
    printf 'done\n'
    printf 'exec %s "$@"\n' "'$REAL_GIT'"
  } >"$bindir/git"
  chmod +x "$bindir/git"
}

# Run the guard with that stub on PATH. Stderr is kept so a control can assert
# WHICH fail-closed branch refused: an over-broken stub would make an earlier
# branch refuse and the control would pass for the wrong reason.
run_guard_with_partial_git() {
  local repo="$1" failarg="$2"
  shift 2
  assert_sandbox "$repo"
  local bindir="$repo/partialbin-git"
  make_partial_git "$bindir" "$failarg"
  : >"$GUARD_STDERR"
  if (cd "$repo" && PATH="$bindir:$PATH" ./scripts/check-no-ai-trailers.sh "$@" >/dev/null 2>"$GUARD_STDERR"); then
    echo accepted
  else
    echo refused
  fi
}

# Same stub, but driving git's real pre-push protocol through the REAL hook.
run_pre_push_hook_with_partial_git() {
  local repo="$1" failarg="$2" line="$3"
  assert_sandbox "$repo"
  local bindir="$repo/partialbin-git"
  make_partial_git "$bindir" "$failarg"
  : >"$GUARD_STDERR"
  if printf '%s\n' "$line" | (cd "$repo" && PATH="$bindir:$PATH" ./.githooks/pre-push origin >/dev/null 2>"$GUARD_STDERR"); then
    echo accepted
  else
    echo refused
  fi
}

guard_stderr_has() {
  grep -qF "$1" "$GUARD_STDERR" 2>/dev/null
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
section 'MESSAGE NORMALIZATION - drop only what git drops, never a real trailer'
# ---------------------------------------------------------------------------
# Verified against git 2.43 in a sandbox: the commit-msg hook is handed the
# `git commit -v` message WITH the diff still attached (git truncates after the
# hook runs), so the below-the-cut-line drop is load-bearing for N1. Equally
# verified: `git commit -F` runs cleanup=whitespace, under which git keeps a
# scissors-SHAPED line, keeps a real cut line, and keeps comment lines — which
# is what S1-S4 and FC7 pin.
VERBOSE_MSG="$WORKDIR/verbose-msg"
{
  printf 'feat: edit the guard fixtures\n\n'
  printf '# Please enter the commit message for your changes.\n'
  printf '# %s\n' "$TRAILER_CLAUDE"
  printf '%s\n' "$GIT_CUT_LINE"
  printf 'diff --git a/x b/x\n'
  printf ' %s\n' "$TRAILER_CLAUDE"
  printf '+%s\n' "$TRAILER_SESSION"
} >"$VERBOSE_MSG"
if (cd "$REPO_ROOT" && "$GUARD" --message "$VERBOSE_MSG" >/dev/null 2>&1); then
  ok 'N1 commented lines and the verbose diff below git cut line are ignored'
else
  ko 'N1 commented lines and the verbose diff below git cut line are ignored' \
    'the guard fired on text git itself strips from the message'
fi

REAL_MSG="$WORKDIR/real-msg"
{
  printf 'feat: edit the guard fixtures\n\n'
  printf '%s\n' "$TRAILER_CLAUDE"
  printf '%s\n' "$GIT_CUT_LINE"
  printf 'diff --git a/x b/x\n'
} >"$REAL_MSG"
if (cd "$REPO_ROOT" && "$GUARD" --message "$REAL_MSG" >/dev/null 2>&1); then
  ko 'N2 a real trailer ABOVE the cut line is still caught' 'the normalizer swallowed a real trailer'
else
  ok 'N2 a real trailer ABOVE the cut line is still caught'
fi

# S1-S4 are SIDE-EFFECT controls: a real `git commit`, asserting the commit was
# never created. Each is a message shape git KEEPS in full, so a trailer under
# it is a real, git-recognised, attributable trailer.
expect_commit_refused 'S1 trailer below an UNCOMMENTED scissors-shaped line refused' \
  "feat: a perfectly normal looking change

------------------------ >8 ------------------------

$TRAILER_CLAUDE"
expect_commit_refused 'S2 trailer below a no-space scissors lookalike refused' \
  "feat: a perfectly normal looking change

-------->8

$TRAILER_CLAUDE"
expect_commit_refused 'S3 trailer below an em-dash scissors lookalike refused' \
  "feat: a perfectly normal looking change

--------— >8 --------

$TRAILER_SESSION"
expect_commit_refused 'S4 column-0 trailer below git REAL cut line refused (-F keeps it)' \
  "feat: a perfectly normal looking change

$GIT_CUT_LINE
diff --git a/x b/x

$TRAILER_CLAUDE"

# S5 pins the DISCLOSED boundary rather than asserting it away: layer 1 lets a
# blank-indented trailer below both a real cut line and a real `diff --git`
# line through (it is not distinguishable from diff context), and layer 2
# refuses it. The assertion is the side effect on BOTH halves: the commit is
# created, and the remote ref does not move.
new_repo s5-boundary
S5_REPO="$REPO"
attach_remote "$S5_REPO"
S5_BODY="feat: a perfectly normal looking change

$GIT_CUT_LINE
diff --git a/x b/x
 $TRAILER_CLAUDE"
if [ "$(try_commit "$S5_REPO" "$S5_BODY")" = created ]; then
  ok 'S5a layer 1 boundary is where it is documented (indented trailer under a real diff)'
else
  ko 'S5a layer 1 boundary is where it is documented' \
    'layer 1 refused it; the disclosed boundary no longer matches the code'
fi
if [ "$(try_push "$S5_REPO")" = rejected ]; then
  ok 'S5b layer 2 refuses the S5a shape (remote ref did not move)'
else
  ko 'S5b layer 2 refuses the S5a shape' 'the remote ref MOVED; the boundary is not covered downstream'
fi

# S6 pins the OTHER side of the same condition: without a `diff --git ` line
# below the cut line there is no diff to be confused with, so nothing is
# dropped and the indented trailer is refused. S5a and S6 together fix the
# boundary at exactly one place instead of leaving it a matter of taste.
expect_commit_refused 'S6 indented trailer below a cut line with NO diff refused' \
  "feat: a perfectly normal looking change

$GIT_CUT_LINE

 $TRAILER_CLAUDE"

# S7 pins the WHOLE-LINE match against git's literal cut line. An approximate
# marker match ("looks like scissors") would open the S5a boundary to any
# lookalike an author can type; requiring git's own line keeps that boundary to
# the one marker git itself acts on. Same shape as S5a, lookalike marker.
expect_commit_refused 'S7 indented trailer below a LOOKALIKE marker + diff refused' \
  "feat: a perfectly normal looking change

------------------------ >8 ------------------------
diff --git a/x b/x
 $TRAILER_CLAUDE"

# ---------------------------------------------------------------------------
section 'FAIL-CLOSED - an unenumerable scan set is refused, never passed'
# ---------------------------------------------------------------------------
new_repo failclosed
FC_REPO="$REPO"
attach_remote "$FC_REPO"
commit_bypassing_hook "$FC_REPO" "feat: the trailer-bearing tip

$TRAILER_CLAUDE"
FC_TIP="$(git -C "$FC_REPO" rev-parse HEAD)"
FC_UNKNOWN='0123456789012345678901234567890123456789'

expect_guard_refuses 'FC1 --range over an unresolvable range refused' \
  "$FC_REPO" --range "$FC_UNKNOWN..$FC_TIP"

if [ "$(run_pre_push_hook "$FC_REPO" "refs/heads/main $FC_TIP refs/heads/main $FC_UNKNOWN")" = refused ]; then
  ok 'FC2 --pre-push with an unknown remote oid refused (the F-2 shape)'
else
  ko 'FC2 --pre-push with an unknown remote oid refused' \
    'the hook exited 0; the push would be allowed with the range unscanned'
fi

FC_ZERO='0000000000000000000000000000000000000000'
if [ "$(run_pre_push_hook "$FC_REPO" "refs/heads/x $FC_UNKNOWN refs/heads/x $FC_ZERO")" = refused ]; then
  ok 'FC3 --pre-push first push with an unknown local oid refused'
else
  ko 'FC3 --pre-push first push with an unknown local oid refused' 'the hook exited 0'
fi

expect_guard_refuses 'FC4 --commit on an unresolvable rev refused' \
  "$FC_REPO" --commit "$FC_UNKNOWN"

# FC8: an oid that EXISTS but is not a commit. `git show -s --format=%B <blob>`
# exits 0 and prints the blob's CONTENT, so a scan that skipped the
# object-type check would happily scan a file and call the result a clean
# commit message.
FC_BLOB="$(git -C "$FC_REPO" rev-parse HEAD:seed.txt)"
expect_guard_refuses 'FC8 --commit on a non-commit object refused' \
  "$FC_REPO" --commit "$FC_BLOB"

# Control: the SAME hook invocation with the correct remote oid still refuses
# because of the trailer, so FC2 is about enumeration and not about the shape.
if [ "$(run_pre_push_hook "$FC_REPO" "refs/heads/main $FC_TIP refs/heads/main $(git -C "$FC_REPO" rev-parse HEAD~1)")" = refused ]; then
  ok 'FC2c the correct-oid control also refuses (on the trailer)'
else
  ko 'FC2c the correct-oid control also refuses' 'the trailer-bearing range was accepted'
fi

FC_CLEAN_MSG="$WORKDIR/fc-clean-msg"
printf 'feat: a perfectly ordinary commit\n' >"$FC_CLEAN_MSG"
if [ "$(run_guard_with_broken_tool "$FC_REPO" grep --message "$FC_CLEAN_MSG")" = refused ]; then
  ok 'FC5 a scanner error refuses (a clean message, unscannable)'
else
  ko 'FC5 a scanner error refuses' 'the guard exited 0 on a stream it never read'
fi
if [ "$(run_guard_with_broken_tool "$FC_REPO" awk --message "$FC_CLEAN_MSG")" = refused ]; then
  ok 'FC6 a normalizer error refuses (a clean message, unnormalizable)'
else
  ko 'FC6 a normalizer error refuses' 'the guard exited 0 on a message it never normalized'
fi

# FC9: `git rev-parse` can succeed and the MESSAGE READ still fail. scan_commit
# checks that status separately; without the check `body` would be the empty
# string, the scan would find nothing in it, and the commit would be reported
# CLEAN. The target here is the trailer-bearing tip, so "accepted" would mean
# the guard cleared a commit that really does carry `Co-Authored-By: Claude`.
#
# Reached through a PASS-THROUGH `git` stub that fails only for `--format=%B`,
# so every other git call the guard makes still works. The assertion names the
# branch via its diagnostic as well as the exit status: a stub that broke git
# outright would make `git rev-parse` fail and FC4's branch would refuse for
# the wrong reason, leaving this control vacuous.
if [ "$(run_guard_with_partial_git "$FC_REPO" '--format=%B' --commit "$FC_TIP")" = refused ] \
  && guard_stderr_has 'unable to read the message of'; then
  ok 'FC9 --commit refuses when the commit body read itself fails'
else
  ko 'FC9 --commit refuses when the commit body read itself fails' \
    'the guard exited 0, or refused on a different branch; an unread message was treated as empty'
fi

# FC9c is the control FOR FC9, in the same shape as FC2c: the SAME pass-through
# stub failing a format the guard deliberately tolerates (`--format=%s`, read
# with `|| true` because the subject is only used to label the report) must let
# the guard run all the way to the scan and refuse on the TRAILER. That fixes
# FC9's refusal to the body-read branch rather than to a broken stub.
if [ "$(run_guard_with_partial_git "$FC_REPO" '--format=%s' --commit "$FC_TIP")" = refused ] \
  && guard_stderr_has 'forbidden AI-attribution trailer'; then
  ok 'FC9c the same stub failing --format=%s still reaches the scan (refuses on the trailer)'
else
  ko 'FC9c the same stub failing --format=%s still reaches the scan' \
    'the pass-through stub does not pass through; FC9 cannot be attributed to the body-read branch'
fi

# FC10: `git hash-object --stdin` is how scan_pre_push learns git's null object
# id, which is the ONLY way it can tell a branch deletion or a first push from
# an ordinary update. If that fails the hook cannot classify the ref operation
# and must refuse. Stated precisely, because the difference is narrower than
# the other fail-closed branches: removing the check does not fail open on a
# trailer (the null oid then matches nothing and `git rev-list` refuses the
# deletion / first-push shapes), it fails open on an ordinary CLEAN range,
# which is exactly what this control observes.
new_repo nulloid
FC10_REPO="$REPO"
commit_bypassing_hook "$FC10_REPO" 'feat: an ordinary clean commit'
FC10_TIP="$(git -C "$FC10_REPO" rev-parse HEAD)"
FC10_BASE="$(git -C "$FC10_REPO" rev-parse HEAD~1)"
FC10_LINE="refs/heads/main $FC10_TIP refs/heads/main $FC10_BASE"

if [ "$(run_pre_push_hook_with_partial_git "$FC10_REPO" 'hash-object' "$FC10_LINE")" = refused ] \
  && guard_stderr_has "unable to determine git's null object id"; then
  ok 'FC10 --pre-push refuses when the null object id cannot be determined'
else
  ko 'FC10 --pre-push refuses when the null object id cannot be determined' \
    'the hook exited 0, or refused on a different branch; an unclassifiable push was allowed'
fi

# FC10c is the control FOR FC10: the SAME hook, the SAME ref line, no stub.
# It must be ACCEPTED, because the range is clean. Without this, FC10 would
# stay green even if the hook refused every push for some unrelated reason.
if [ "$(run_pre_push_hook "$FC10_REPO" "$FC10_LINE")" = accepted ]; then
  ok 'FC10c the same clean range with git intact is accepted'
else
  ko 'FC10c the same clean range with git intact is accepted' \
    'the hook refused a clean range; FC10 cannot be attributed to the null-oid branch'
fi

# FC7: `core.commentChar` is user-configurable and git accepts a letter. With
# `C`, an unconditional comment rule would treat the trailer itself as
# commentary. Side-effect control: the commit must not be created.
new_repo commentchar
FC7_REPO="$REPO"
git -C "$FC7_REPO" config core.commentChar C
if [ "$(try_commit "$FC7_REPO" "feat: thing

$TRAILER_CLAUDE")" = refused ]; then
  ok 'FC7 core.commentChar=C does not let the comment rule swallow a trailer'
else
  ko 'FC7 core.commentChar=C does not let the comment rule swallow a trailer' \
    'the commit WAS created; the comment rule dropped a real trailer'
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
# paths-ignore is the same hole worn the other way round.
if grep -qE '^ *paths-ignore:' "$WORKFLOW"; then
  ko 'W2b CI workflow has no paths-ignore filter' 'a paths-ignore filter lets a PR skip the check entirely'
else
  ok 'W2b CI workflow has no paths-ignore filter'
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
CODEOWNERS="$REPO_ROOT/.github/CODEOWNERS"
W5_MISSING=''
for W5_PATH in \
  '/scripts/check-no-ai-trailers.sh' \
  '/scripts/check-no-ai-trailers.test.sh' \
  '/.github/workflows/no-ai-trailers.yml'; do
  grep -qF "$W5_PATH" "$CODEOWNERS" 2>/dev/null || W5_MISSING="$W5_MISSING $W5_PATH"
done
if [ -z "$W5_MISSING" ]; then
  ok 'W5 CODEOWNERS covers the guard, its matrix and its workflow'
else
  ko 'W5 CODEOWNERS covers the guard, its matrix and its workflow' \
    "unowned:$W5_MISSING - one PR could weaken all three and pass its own test"
fi

printf '\n%s\n' '-----------------------------------------------'
printf 'no-ai-trailer guard: %d passed, %d failed\n' "$PASS_COUNT" "$FAIL_COUNT"
[ "$FAIL_COUNT" -eq 0 ] || exit 1
