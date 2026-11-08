"""AC-P2b: equality of the two recorded values on the A' image.

Reads the recorder output of a `plus-header` run (stack.sh up plus-header <records>):
  p2.jsonl  api-inbound upload records (multipart field names, conversationId, clientRequestId)
  p1.jsonl  bff-inbound records (the chat completions' x-session-id)
and checks, for the probe user (id read from the probe's own throwaway Mongo):
  1. the NEW chat's first upload carries clientRequestId and NO conversationId;
  2. uuid5(f"{userId}:{seed}", NAMESPACE) (python) == the x-session-id recorded for the first chat
     completion == deriveNewConversationId(userId, seed) run INSIDE the image (node);
  3. the EXISTING chat's upload carries conversationId == the x-session-id of the second completion.
usage: p2b_verify.py <records-dir> <image>     exit 0 = all hold, 1 = a check failed
"""
import json
import subprocess
import sys
import uuid
from pathlib import Path

NAMESPACE = uuid.UUID("d7f2518c-94b8-4fe8-97ad-2d4bdb2c9f43")
MONGO = "lc10a-probe-mongo"
LIBRECHAT = "lc10a-probe-librechat"


def rows(path):
    return [json.loads(line) for line in Path(path).read_text().splitlines() if line.strip()]


def run(*cmd):
    return subprocess.run(cmd, capture_output=True, text=True, timeout=60, check=True).stdout.strip()


def main(records, image):
    p1 = [r for r in rows(Path(records) / "p1.jsonl") if r["path"] == "/v1/chat/completions"]
    uploads = [r for r in rows(Path(records) / "p2.jsonl") if r["path"].startswith("/api/files")]
    user_id = run("docker", "exec", MONGO, "mongosh", "--quiet", "LibreChat", "--eval",
                  "print(String(db.users.findOne({}, {_id:1})._id))")
    checks = []

    def check(name, ok, detail):
        checks.append(ok)
        print(("PASS " if ok else "FAIL ") + name + ": " + detail)

    new_upload, existing_upload = uploads[0], uploads[-1]
    seed = new_upload.get("clientRequestId")
    check("1 new-chat upload carries a seed and no conversationId",
          bool(seed) and new_upload["conversationId_present"] is False,
          f"fields={new_upload['multipart_field_names']}")
    first_header = p1[0]["x-session-id"]
    derived_py = str(uuid.uuid5(NAMESPACE, f"{user_id}:{seed}"))
    derived_node = run("docker", "exec", LIBRECHAT, "node", "-e",
                       "console.log(require('/app/api/server/utils/newConversationId').deriveNewConversationId(process.argv[1], process.argv[2]))",
                       user_id, seed)
    check("2 derived id (python) == chat x-session-id", derived_py == first_header,
          f"derived={derived_py} chat={first_header}")
    check("2 derived id (the image's own helper) == chat x-session-id", derived_node == first_header,
          f"derived={derived_node} chat={first_header}")
    second_header = p1[-1]["x-session-id"]
    check("3 existing-chat upload conversationId == chat x-session-id",
          existing_upload["conversationId"] == second_header,
          f"upload={existing_upload['conversationId']} chat={second_header}")
    print(json.dumps({"image": image, "user_id_len": len(user_id), "seed": seed,
                      "chat_completions": len(p1), "uploads": len(uploads), "all_pass": all(checks)}))
    return 0 if all(checks) else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1], sys.argv[2]))
