"""Run the memory server's header_session_id (verbatim source from 6a42c499) over the case list."""
import json, re, sys, logging, types
src = open(sys.argv[1]).read()
# keep only what the function needs: re, logging, Any and the three definitions
start = src.index('SESSION_ID_RE = ')
end = src.index('async def stream_with_bound_session')
ns = {'re': re, 'logger': logging.getLogger('x'), 'Any': object}
exec(src[start:end], ns)
cases = json.load(open(sys.argv[2]))
class Req:
    def __init__(self, v): self.headers = {'x-session-id': v}
out = []
for c in cases:
    r = ns['header_session_id'](Req(c))
    out.append(r)
print(json.dumps(out))
