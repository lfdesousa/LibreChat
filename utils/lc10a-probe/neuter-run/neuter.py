#!/usr/bin/env python3
"""neuter.py LABEL FILE OLD NEW CWD JESTARGS...  : mutate FILE (OLD->NEW once), run jest, restore, log RED/GREEN."""
import sys, subprocess, shutil, os, json
label, f, old, new, cwd, *args = sys.argv[1:]
bak = f + '.neuter-bak'
shutil.copy(f, bak)
log = os.path.expanduser('neuter-results.jsonl')
def run():
    p = subprocess.run(['npx','jest',*args], cwd=cwd, capture_output=True, text=True, timeout=900)
    out = p.stdout + p.stderr
    tl = [l for l in out.splitlines() if l.startswith('Tests:')]
    return p.returncode, (tl[0] if tl else '?'), out
try:
    s = open(f).read()
    assert s.count(old) >= 1, 'OLD not found'
    open(f,'w').write(s.replace(old,new,1))
    rc_n, t_n, out_n = run()
finally:
    shutil.move(bak, f)
rc_r, t_r, _ = run()
failed = [l.strip() for l in out_n.splitlines() if l.strip().startswith('●') and '›' in l]
rec = dict(label=label, neutered_rc=rc_n, neutered_tests=t_n, failing=sorted(set(failed))[:6], restored_rc=rc_r, restored_tests=t_r,
           verdict='RED->GREEN' if rc_n!=0 and rc_r==0 else 'NOT-PROVEN')
open(log,'a').write(json.dumps(rec)+'\n')
print(json.dumps(rec, indent=1))
