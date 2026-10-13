import json, re, sys
d = sys.argv[1]
s = open(f"{d}/template_roads.html").read()

def rep(a, b):
    global s
    assert a in s, a[:70]
    s = s.replace(a, b, 1)

rep("<title>Roads and Lanes Prototype</title>", "<title>Contributors Prototype</title>")
rep("""<!--
  PROTOTYPE, throw away. Answers: "How are Roads and their Lanes drawn""",
    """<!--
  PROTOTYPE, throw away. Answers: "When the user opts in, how do Contributors and commit messages appear?"
  Ticket: Contributors and commit messages in the City (ken-guru/git-city#24). #A crews, #B markers, #C ledger.
  Built on the roads prototype (git-city#20); its header follows.
  "How are Roads and their Lanes drawn""")
# the camera prototype's cluster helpers (lotVillage, clusters) are reused for crews and the opening view
cam = open(f"{d}/camera.js").read()
helpers = cam[cam.index("// Building clusters:"):cam.index("let tour = null;")]
rep("\n// ---------- three.js ----------", "\n" + helpers + open(f"{d}/highways.js").read()[0:0] + "function mergeBoxes(parts) { const pos = [], nor = []; for (const g of parts) { const ng = g.index ? g.toNonIndexed() : g; pos.push(...ng.attributes.position.array); nor.push(...ng.attributes.normal.array); } const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3)); return g; }\n" + open(f"{d}/contrib.js").read() + "\n// ---------- three.js ----------")
i = s.index("<style>\n[hidden] { display: none !important; }\n#spanel")
j = s.index('<script id="data"')
s = s[:i] + open(f"{d}/contrib_ui.html").read() + "\n" + s[j:]
i = s.index("// ---------- UI: roads prototype")
j = s.rindex("</script>")
s = s[:i] + open(f"{d}/contrib_main.js").read().replace("</script>\n", "").rstrip() + "\n" + s[j:]
open(f"{d}/template_contrib.html", "w").write(s)
# authors per first-parent commit, in chain order
data = json.load(open(f"{d}/data_roads.json"))
meta = json.load(open(f"{d}/authors.json"))
chain = [json.loads(l) for l in open(f"{d}/changesets.jsonl")]
chain.sort(key=lambda r: r["i"])
idx, ppl, by, msg = {}, [], [], []
for r in chain:
    m = meta.get(r["sha"], {"login": None, "name": "unknown", "msg": ""})
    key = m["login"] or m["name"]
    if key not in idx:
        idx[key] = len(ppl)
        ppl.append({"login": m["login"], "name": m["name"], "bot": bool(re.search(r"\[bot\]|-bot$|^github-actions", key or ""))})
    by.append(idx[key]); msg.append(m["msg"])
data["authors"] = {"people": ppl, "byCommit": by, "msg": msg}
json.dump(data, open(f"{d}/data_contrib.json", "w"), separators=(",", ":"))
print("assembled;", len(ppl), "people on the first-parent chain,", sum(p["bot"] for p in ppl), "bots")
