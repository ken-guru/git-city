"""List (commit index, sha, manifest path) for every add/modify/rename of a workspace or root package.json.
usage: manifest_revs.py history.jsonl out.json"""
import json, re, sys

src, out = sys.argv[1:3]
recs = sorted((json.loads(l) for l in open(src)), key=lambda r: r["i"])
revs = []
for r in recs:
    for st, f, prev, a, d in r["files"]:
        if not f.endswith("package.json") or re.search(r"node_modules|__fixtures__|fixtures|/test/|__tests__", f):
            continue
        revs.append({"i": r["i"], "sha": r["sha"], "path": f, "status": st})
json.dump(revs, open(out, "w"))
print(len(revs), "manifest revisions across", len({x["path"] for x in revs}), "paths")
