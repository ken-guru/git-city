"""Compact fetched history into {repo, paths, commits:[[day, [[op, path, prev, add, del], ...]], ...]}.
op: a added, d removed, m modified, r renamed. usage: compact.py repo in.jsonl out.json"""
import json, sys

repo, src, out = sys.argv[1:4]
OPS = {"added": "a", "copied": "a", "removed": "d", "modified": "m", "changed": "m", "renamed": "r"}
recs = sorted((json.loads(l) for l in open(src)), key=lambda r: r["i"])
paths, idx = [], {}
def pid(p):
    if p is None: return -1
    if p not in idx: idx[p] = len(paths); paths.append(p)
    return idx[p]
FULL = {"a": "added", "d": "removed", "m": "modified", "r": "renamed"}
commits = []
for r in recs:
    ev = []
    for st, f, prev, add, dele in r["files"]:
        # fetch.py stored only the first letter of the status; recover it
        op = {"a": "a", "r": "r" if prev else "d", "m": "m", "c": "m"}.get(st, "m")
        ev.append([op, pid(f), pid(prev), add, dele])
    commits.append([r["day"], ev])
json.dump({"repo": repo, "paths": paths, "commits": commits}, open(out, "w"), separators=(",", ":"))
print(len(commits), "commits,", len(paths), "paths")
