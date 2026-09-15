#!/usr/bin/env bash
#
# Mechanical guard: no AI-attribution trailers in commit messages.
#
# The rule (RATIFIED 2026-09-13, no exceptions): a commit message body must not
# contain a line that is a `Co-Authored-By:` trailer — regardless of who is
# named — nor a `Claude-Session:` trailer. There is no allow-list: no carve-out
# for `dependabot[bot]`, none for human co-authors, none for any identity. An
# allow-list is a hole, and identity matching rots as model names change.
#
# Two properties are load-bearing. Each element of each has a named control in
# scripts/check-no-ai-trailers.test.sh that goes RED when that element alone is
# removed — the exact boundaries, not a blanket claim:
#
#   1. It matches a TRAILER, never PROSE. A guard that fires on prose gets
#      disabled within a week, and a disabled guard is worse than none. Two
#      separate elements produce that:
#        * the line-start anchor keeps a MID-LINE mention passing
#          ("...whether Co-Authored-By: lines are ever allowed") — control A11;
#        * the required colon keeps a line that STARTS with the phrase but is
#          prose passing ("Co-Authored-By trailers are banned") — control A13.
#      The historical false positive, a body reading "No Co-Authored-By. No
#      push.", is kept passing by BOTH (mid-line, and no colon) — control A10.
#   2. It scans only the commits under consideration — the message being
#      written, the commits being pushed, or merge-base..HEAD of a PR — never
#      full history. An upstream merge can import legitimate contributor
#      trailers at any time; a full-history check would then fail forever.
#      Controls C1 (PR scope passes over inherited history) and C2 (the same
#      history WOULD fail unscoped, so C1 is scoping and not luck).
#
# Usage:
#   check-no-ai-trailers.sh --message <file>   scan a prepared commit message
#   check-no-ai-trailers.sh --commit <rev>     scan one commit's message
#   check-no-ai-trailers.sh --range <range>    scan every commit in a range
#   check-no-ai-trailers.sh --pre-push <remote>  read git's pre-push stdin
#
# Exits 0 when clean, 1 when a forbidden trailer is found (naming the commit,
# the line number and the line), 2 on usage error.

set -euo pipefail

# ---------------------------------------------------------------------------
# THE PREDICATE. One definition, used by every mode and every layer.
#
# `^[[:blank:]]*` — anchored at line start, then optional leading blanks. The
# blanks are a deliberate widening of the ratified `^Co-Authored-By:`: strictly
# a superset (it blocks more, never less) that closes an indent-one-space
# evasion — control A7. `[[:blank:]]*:` likewise tolerates `Co-Authored-By :`.
# Matching is case-insensitive on the key (`-i` at every call site, control A5
# and A6). No identity is inspected: the rule has no allow-list, so there is
# nothing here to weaken per-identity.
# ---------------------------------------------------------------------------
FORBIDDEN_TRAILER_RE='^[[:blank:]]*(Co-Authored-By|Claude-Session)[[:blank:]]*:'

PROGRAM_NAME="$(basename "$0")"

usage() {
  cat >&2 <<EOF
usage: $PROGRAM_NAME --message <file>
       $PROGRAM_NAME --commit <rev>
       $PROGRAM_NAME --range <rev-range>
       $PROGRAM_NAME --pre-push <remote-name>   (reads git's pre-push stdin)
EOF
  exit 2
}

# Print the commit message as git will keep it: everything from the verbose
# scissors line onward dropped, comment lines dropped. Without this, running
# `git commit --verbose` on a diff that touches this guard's own fixtures would
# feed the diff's context lines to the scanner.
normalize_message() {
  local file="$1" comment_char
  comment_char="$(git config --get core.commentChar 2>/dev/null || true)"
  if [ -z "$comment_char" ] || [ "$comment_char" = "auto" ]; then
    comment_char='#'
  fi
  awk -v cc="$comment_char" '
    /--------/ && index($0, ">8") { exit }
    substr($0, 1, 1) == cc { next }
    { print }
  ' "$file"
}

# Scan text on stdin. $1 is how the offender should be named in the report.
# Returns 1 and prints the offending line(s) when the predicate matches.
scan_text() {
  local label="$1" hits=''
  hits="$(grep -n -i -E "$FORBIDDEN_TRAILER_RE" || true)"
  [ -z "$hits" ] && return 0

  {
    echo "ERROR: forbidden AI-attribution trailer in $label"
    echo "$hits" | sed 's/^/  line /'
  } >&2
  return 1
}

scan_commit() {
  local rev="$1" sha subject
  sha="$(git rev-parse "$rev")"
  subject="$(git show -s --format=%s "$sha")"
  git show -s --format=%B "$sha" | scan_text "commit $sha (\"$subject\")"
}

scan_range() {
  local range="$1" rev failed=0
  # `git rev-list` on an empty or already-merged range emits nothing: a PR with
  # no new commits is clean, not an error.
  while read -r rev; do
    [ -z "$rev" ] && continue
    scan_commit "$rev" || failed=1
  done <<<"$(git rev-list "$range")"
  return "$failed"
}

# git's pre-push protocol: one `<local_ref> <local_oid> <remote_ref>
# <remote_oid>` line per ref being pushed, on stdin.
scan_pre_push() {
  # $1 is the remote name or URL git passes to the hook; it is not used for
  # scoping (see below) but is part of the hook contract.
  local zero local_ref local_oid remote_ref remote_oid
  local rev failed=0
  zero="$(git hash-object --stdin </dev/null | tr '0-9a-f' '0')"

  while read -r local_ref local_oid remote_ref remote_oid; do
    [ -z "${local_oid:-}" ] && continue
    # Branch deletion: nothing to scan.
    [ "$local_oid" = "$zero" ] && continue

    if [ "$remote_oid" = "$zero" ]; then
      # First push of a branch: scan every commit that is not already on a
      # remote-tracking ref. Anything excluded here either arrived by fetch
      # (upstream history, which this guard deliberately does not police) or
      # was itself scanned by the push that published it. Scanning from the
      # root instead would re-scan all of upstream on every new branch.
      mapfile -t revs < <(git rev-list "$local_oid" --not --remotes)
    else
      mapfile -t revs < <(git rev-list "$remote_oid..$local_oid")
    fi

    for rev in "${revs[@]:-}"; do
      [ -z "$rev" ] && continue
      scan_commit "$rev" || failed=1
    done
  done

  return "$failed"
}

print_fix_hint() {
  cat >&2 <<'EOF'

The no-AI-trailer rule has no exceptions: no `Co-Authored-By:` line (whoever is
named) and no `Claude-Session:` line may appear in a commit message.

To fix:
  * most recent commit   ->  git commit --amend           (delete the line)
  * an older commit      ->  git rebase -i <base>         (reword it)
  * while writing one    ->  remove the trailer and commit again

Do not bypass with --no-verify: the same check runs in CI on the pull
request's commits, where branch protection makes it non-bypassable.
EOF
}

main() {
  [ "$#" -ge 1 ] || usage

  local status=0
  case "$1" in
    --message)
      [ "$#" -eq 2 ] || usage
      [ -f "$2" ] || { echo "ERROR: no such message file: $2" >&2; exit 2; }
      normalize_message "$2" | scan_text "the commit message being written" || status=1
      ;;
    --commit)
      [ "$#" -eq 2 ] || usage
      scan_commit "$2" || status=1
      ;;
    --range)
      [ "$#" -eq 2 ] || usage
      scan_range "$2" || status=1
      ;;
    --pre-push)
      scan_pre_push || status=1
      ;;
    -h | --help)
      usage
      ;;
    *)
      usage
      ;;
  esac

  [ "$status" -eq 0 ] && return 0
  print_fix_hint
  return 1
}

main "$@"
