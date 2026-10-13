import json, sys
d = sys.argv[1]
s = open(f"{d}/template_roads.html").read()

def rep(a, b):
    global s
    assert a in s, a[:70]
    s = s.replace(a, b, 1)

rep("<title>Roads and Lanes Prototype</title>", "<title>Highways Prototype</title>")
rep("""<!--
  PROTOTYPE, throw away. Answers: "How are Roads and their Lanes drawn""",
    """<!--
  PROTOTYPE, throw away. Answers: "What do External Cities and the Highways to them look like, and where do they sit?"
  Ticket: Highways and External Cities (ken-guru/git-city#22). Two designs: #A direct Highways, #B orbital motorway.
  Built on the roads prototype (git-city#20); its header follows.
  "How are Roads and their Lanes drawn""")
rep("\n// ---------- three.js ----------", open(f"{d}/highways.js").read() + "\n// ---------- three.js ----------")
i = s.index("<style>\n[hidden] { display: none !important; }\n#spanel")
j = s.index('<script id="data"')
s = s[:i] + open(f"{d}/hw_ui.html").read() + "\n" + s[j:]
i = s.index("// ---------- UI: roads prototype")
j = s.rindex("</script>")
s = s[:i] + open(f"{d}/hw_main.js").read().replace("</script>\n", "").rstrip() + "\n" + s[j:]
open(f"{d}/template_hw.html", "w").write(s)
# manifest history: keep only revisions whose name, dependency set or existence changed
data = json.load(open(f"{d}/data_roads.json"))
recs = sorted((json.loads(l) for l in open(f"{d}/manifest_history.jsonl")), key=lambda r: (r["path"], r["i"]))
kept, last = [], {}
for r in recs:
    sig = (r["name"], tuple(sorted(x[0] for x in r["deps"])), r["gone"])
    if last.get(r["path"]) == sig: continue
    last[r["path"]] = sig
    kept.append({"i": r["i"], "path": r["path"], "name": r["name"], "deps": [[x[0]] for x in r["deps"]], "gone": r["gone"]})
data["manifestHistory"] = kept
json.dump(data, open(f"{d}/data_hw.json", "w"), separators=(",", ":"))
print("assembled;", len(recs), "revisions ->", len(kept), "kept")
