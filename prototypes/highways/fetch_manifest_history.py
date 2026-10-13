"""For every manifest revision, fetch the package.json at that commit and keep its name and declared dependencies.
Resumable. usage: fetch_manifest_history.py owner/repo revs.json out.jsonl"""
import base64, json, os, subprocess, sys

repo, revs_path, out = sys.argv[1:4]
revs = json.load(open(revs_path))
done = set()
if os.path.exists(out):
    for l in open(out): r = json.loads(l); done.add((r["i"], r["path"]))
with open(out, "a") as f:
    for n, r in enumerate(revs):
        if (r["i"], r["path"]) in done: continue
        rec = {"i": r["i"], "path": r["path"], "name": None, "deps": [], "gone": False}
        p = subprocess.run(["gh", "api", f"repos/{repo}/contents/{r['path']}?ref={r['sha']}"], capture_output=True, text=True)
        if p.returncode != 0:
            rec["gone"] = True                                 # deleted in this commit
        else:
            try:
                j = json.loads(base64.b64decode(json.loads(p.stdout)["content"]))
                rec["name"] = j.get("name")
                deps = {}
                for k in ("dependencies", "devDependencies", "peerDependencies"):
                    for d in (j.get(k) or {}): deps.setdefault(d, k)
                rec["deps"] = sorted(deps.items())
            except Exception as e:
                rec["error"] = str(e)
        f.write(json.dumps(rec) + "\n"); f.flush()
        if n % 100 == 0: print(n, r["i"], r["path"], flush=True)
print("done", flush=True)
