#!/usr/bin/env python3
"""neuter.py LABEL FILE OLD NEW CWD JESTARGS...

Mutate FILE (OLD -> NEW, which must match exactly once), run jest on JESTARGS in CWD,
restore FILE, run jest again, and append one JSON line to $NEUTER_LOG
(default ./neuter-results.jsonl).

Verdicts:
  RED->GREEN  a test FAILED with the guard removed, and the restored run passed
  NOT-PROVEN  the neutered run still passed (the guard is not falsified)
  ERROR       no test failed but jest did not run cleanly (syntax or collection error,
              no "Tests:" line), or the restored run is not green; never counted as RED
Exit code: 0 for RED->GREEN, 1 otherwise; a missing or ambiguous anchor exits non-zero
before anything is changed.

The original bytes are held in memory and put back by a context manager on every exit
path, including an exception or KeyboardInterrupt; no backup file is written.
A SIGKILL or SIGTERM mid-run cannot run the restore and leaves the source mutated:
recover it with `git checkout -- <file>`.
"""
import contextlib
import json
import os
import re
import subprocess
import sys

TESTS_LINE = re.compile(r"^Tests:\s+(?:(\d+) failed, )?.*?(\d+) total", re.M)


@contextlib.contextmanager
def mutated(path, old, new):
    """Apply a single-occurrence replacement; restore the original bytes on exit."""
    with open(path, "rb") as fh:
        original = fh.read()
    text = original.decode("utf-8")
    found = text.count(old)
    if found != 1:
        raise SystemExit(f"anchor must match exactly once, matched {found}x in {path}")
    try:
        with open(path, "wb") as fh:
            fh.write(text.replace(old, new, 1).encode("utf-8"))
        yield
    finally:
        with open(path, "wb") as fh:
            fh.write(original)


def run_jest(cwd, args):
    proc = subprocess.run(
        ["npx", "jest", *args], cwd=cwd, capture_output=True, text=True, timeout=900, check=False
    )
    out = proc.stdout + proc.stderr
    line = next((ln for ln in out.splitlines() if ln.startswith("Tests:")), None)
    match = TESTS_LINE.search(line) if line else None
    failed = int(match.group(1) or 0) if match else None
    return {"rc": proc.returncode, "line": line or "?", "failed": failed, "out": out}


def main(argv):
    label, path, old, new, cwd, *args = argv
    with mutated(path, old, new):
        neutered = run_jest(cwd, args)
    restored = run_jest(cwd, args)
    if restored["rc"] != 0 or restored["failed"] != 0:
        verdict = "ERROR"
    elif neutered["failed"] is None:
        verdict = "ERROR"
    elif neutered["failed"] > 0:
        verdict = "RED->GREEN"
    elif neutered["rc"] != 0:
        verdict = "ERROR"
    else:
        verdict = "NOT-PROVEN"
    failing = sorted(
        {
            ln.strip()
            for ln in neutered["out"].splitlines()
            if ln.strip().startswith("●") and "›" in ln
        }
    )[:6]
    record = {
        "label": label,
        "neutered_rc": neutered["rc"],
        "neutered_tests": neutered["line"],
        "failing": failing,
        "restored_rc": restored["rc"],
        "restored_tests": restored["line"],
        "verdict": verdict,
    }
    with open(os.environ.get("NEUTER_LOG", "neuter-results.jsonl"), "a", encoding="utf-8") as log:
        log.write(json.dumps(record) + "\n")
    print(json.dumps(record, indent=1))
    return 0 if verdict == "RED->GREEN" else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
