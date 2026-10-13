"""Fetch every workspace package.json at HEAD: {dir: {name, deps: [internal package names]}}.
usage: fetch_manifests.py owner/repo out.json"""
import base64, json, re, subprocess, sys

repo, out = sys.argv[1], sys.argv[2]
def gh(path):
    return json.loads(subprocess.run(["gh", "api", path], check=True, capture_output=True, text=True).stdout)

tree = gh(f"repos/{repo}/git/trees/HEAD?recursive=1")["tree"]
paths = [t["path"] for t in tree if t["path"].endswith("package.json") and "/" in t["path"]
         and not re.search(r"node_modules|__fixtures__|fixtures|/test/|__tests__", t["path"])]
pk = {}
for p in paths:
    try:
        j = json.loads(base64.b64decode(gh(f"repos/{repo}/contents/{p}")["content"]))
    except Exception as e:
        print("skip", p, e); continue
    deps = set()
    for k in ("dependencies", "devDependencies", "peerDependencies"):
        deps |= set((j.get(k) or {}).keys())
    pk[p.rsplit("/", 1)[0]] = {"name": j.get("name"), "deps": sorted(deps)}
names = {v["name"] for v in pk.values() if v["name"]}
for v in pk.values():
    v["deps"] = [d for d in v["deps"] if d in names]
json.dump(pk, open(out, "w"), indent=1)
print(len(pk), "manifests,", sum(len(v["deps"]) for v in pk.values()), "internal dependency edges")
