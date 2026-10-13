"""Fetch author and first message line for every commit (paged list endpoint).
usage: fetch_authors.py owner/repo out.json"""
import json, subprocess, sys

repo, out = sys.argv[1:3]
meta, page = {}, 1
while True:
    batch = json.loads(subprocess.run(["gh", "api", f"repos/{repo}/commits?per_page=100&page={page}"], check=True, capture_output=True, text=True).stdout)
    if not batch: break
    for c in batch:
        a = c.get("author") or {}
        meta[c["sha"]] = {"login": a.get("login"), "name": c["commit"]["author"]["name"], "msg": c["commit"]["message"].split("\n")[0][:140]}
    page += 1
json.dump(meta, open(out, "w"))
print(len(meta), "commits,", len({m["login"] or m["name"] for m in meta.values()}), "authors")
