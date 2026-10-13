import json, sys
d = sys.argv[1]
s = open(f"{d}/template_scenery.html").read()

def rep(a, b):
    global s
    assert a in s, a[:70]
    s = s.replace(a, b, 1)

rep("<title>Countryside Prototype</title>", "<title>Roads and Lanes Prototype</title>")
rep("""<!--
  PROTOTYPE, throw away. Answers: "What does the decorative Countryside""",
    """<!--
  PROTOTYPE, throw away. Answers: "How are Roads and their Lanes drawn between and within the villages?"
  Ticket: Road and Lane geometry (ken-guru/git-city#20). Two networks: #A direct roads, #B shared network.
  Built on the countryside prototype (git-city#21); its header follows.
  "What does the decorative Countryside""")
# expose which village each Neighbourhood joined
rep("""    out.lotRot.set(k.lot.id, v.rot);
    if (cell.fragment) out.extLots.add(k.lot.id);
  }
  return out;""", """    out.lotRot.set(k.lot.id, v.rot);
    if (cell.fragment) out.extLots.add(k.lot.id);
  }
  out.villageOf = villageOfNbhd; out.villageMap = villages;
  return out;""")
rep("\n// ---------- three.js ----------", open(f"{d}/roads.js").read() + "\n// ---------- three.js ----------")
# swap the scenery prototype's panel and main script for the roads ones
i = s.index("<style>\n[hidden] { display: none !important; }\n#spanel")
j = s.index('<script id="data"')
s = s[:i] + open(f"{d}/roads_ui.html").read() + "\n" + s[j:]
i = s.index("// ---------- UI: countryside prototype")
j = s.rindex("</script>")
s = s[:i] + open(f"{d}/roads_main.js").read().replace("</script>\n", "").rstrip() + "\n" + s[j:]
open(f"{d}/template_roads.html", "w").write(s)
data = json.load(open(f"{d}/data.json")); data["manifests"] = json.load(open(f"{d}/manifests.json"))
json.dump(data, open(f"{d}/data_roads.json", "w"), separators=(",", ":"))
print("assembled")
