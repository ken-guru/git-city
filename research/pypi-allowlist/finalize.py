"""Combine the ClickPy ranking with the import-name map into the Well-known PyPI list, and print stats."""
import collections
import gzip
import json

rank = json.load(open("rank.json"))
res = [json.loads(l) for l in open("all.jsonl")]
assert len(res) == len(rank["rows"])

steps = collections.Counter(r["step"] for r in res)
notes = collections.Counter(r.get("note") or ("error" if "error" in r else "ok") for r in res)
errors = [(r["project"], r["error"]) for r in res if "error" in r]

names = sorted({n for r in res for n in r["import_names"]})
dotted = sum("." in n for n in names)
header = (f"# Well-known PyPI import names. Built {rank['generated']} from the top {len(res)} projects by "
          f"downloads in {rank['month'][:7]} ({rank['source']}). One name per line; a dotted name covers "
          f"its submodules.\n")
body = header + "\n".join(names) + "\n"
open("pypi-well-known.txt", "w").write(body)

# names claimed by more than one project (fine for an allowlist, worth knowing)
owners = collections.defaultdict(list)
for r in res:
    for n in r["import_names"]:
        owners[n].append(r["project"])
shared = sorted(((n, p) for n, p in owners.items() if len(p) > 1), key=lambda x: -len(x[1]))

with open("pypi-import-map.jsonl", "w") as f:
    for r in res:
        f.write(json.dumps({k: r[k] for k in ("project", "import_names", "step")}) + "\n")

print(json.dumps({
    "projects": len(res), "steps": steps, "outcomes": notes, "errors": len(errors), "error_sample": errors[:8],
    "distinct_import_names": len(names), "dotted_namespace_names": dotted,
    "list_bytes_raw": len(body.encode()), "list_bytes_gzip": len(gzip.compress(body.encode(), 9)),
    "names_shared_by_projects": len(shared), "shared_sample": [(n, p[:4]) for n, p in shared[:8]],
}, indent=1, default=dict))
