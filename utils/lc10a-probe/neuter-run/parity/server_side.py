"""Run the memory server's header_session_id over the case list.

usage: server_side.py <path to _session_bind.py> <cases.json>
The source file is the verbatim module from the memory server (not shipped in this repo).
"""
import json
import logging
import re
import sys


def load_function(source_path):
    with open(source_path, encoding="utf-8") as fh:
        src = fh.read()
    # keep only what the function needs: re, logging, Any and the three definitions
    start = src.index("SESSION_ID_RE = ")
    end = src.index("async def stream_with_bound_session")
    namespace = {"re": re, "logger": logging.getLogger("x"), "Any": object}
    exec(src[start:end], namespace)
    return namespace["header_session_id"]


class Req:
    def __init__(self, value):
        self.headers = {"x-session-id": value}


def main(source_path, cases_path):
    header_session_id = load_function(source_path)
    with open(cases_path, encoding="utf-8") as fh:
        cases = json.load(fh)
    print(json.dumps([header_session_id(Req(case)) for case in cases]))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
