"""Fetch a repo's first-parent history via the GitHub API: per commit, day + changed files.
usage: fetch.py owner/repo out.jsonl   (resumable: skips commits already in out.jsonl)"""
import json, os, subprocess, sys

repo, out = sys.argv[1], sys.argv[2]

def gh(path):
    return json.loads(subprocess.run(["gh", "api", path], check=True, capture_output=True, text=True).stdout)

# 1. list every reachable commit (sha -> parents), then walk first parents from HEAD
parents, page = {}, 1
head = None
while True:
    batch = gh(f"repos/{repo}/commits?per_page=100&page={page}")
    if not batch: break
    if head is None: head = batch[0]["sha"]
    for c in batch: parents[c["sha"]] = [p["sha"] for p in c["parents"]]
    page += 1
chain, sha = [], head
while sha:
    chain.append(sha)
    ps = parents.get(sha) or gh(f"repos/{repo}/commits/{sha}")["parents"] and [p["sha"] for p in gh(f"repos/{repo}/commits/{sha}")["parents"]]
    sha = ps[0] if ps else None
chain.reverse()
print(f"{len(parents)} commits listed, first-parent chain {len(chain)}", flush=True)

done = set()
if os.path.exists(out):
    for line in open(out): done.add(json.loads(line)["sha"])
with open(out, "a") as f:
    for i, sha in enumerate(chain):
        if sha in done: continue
        c = gh(f"repos/{repo}/commits/{sha}")
        files = list(c.get("files", []))
        p = 2
        while len(files) == 300 * (p - 1) and p <= 10:
            more = gh(f"repos/{repo}/commits/{sha}?page={p}").get("files", [])
            if not more: break
            files += more; p += 1
        rec = {"i": i, "sha": sha, "day": c["commit"]["committer"]["date"][:10],
               "files": [[x["status"][0], x["filename"], x.get("previous_filename"), x.get("additions", 0), x.get("deletions", 0)] for x in files]}
        f.write(json.dumps(rec) + "\n"); f.flush()
        if i % 50 == 0: print(i, rec["day"], len(files), flush=True)
print("done", flush=True)
