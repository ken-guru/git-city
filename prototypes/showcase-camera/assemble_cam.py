import sys
d = sys.argv[1]
s = open(f"{d}/template_hw.html").read()

def rep(a, b):
    global s
    assert a in s, a[:70]
    s = s.replace(a, b, 1)

rep("<title>Highways Prototype</title>", "<title>Showcase Camera Prototype</title>")
rep("""<!--
  PROTOTYPE, throw away. Answers: "What do External Cities""",
    """<!--
  PROTOTYPE, throw away. Answers: "How does the camera behave during playback and when history is up to date?"
  Ticket: Showcase camera (ken-guru/git-city#23). Three showcase styles: #A grand tour, #B drone, #C postcards.
  Built on the Highways prototype (git-city#22); its header follows.
  "What do External Cities""")
rep("\n// ---------- three.js ----------", open(f"{d}/camera.js").read() + "\n// ---------- three.js ----------")
i = s.index("<style>\n[hidden] { display: none !important; }\n#spanel")
j = s.index('<script id="data"')
s = s[:i] + open(f"{d}/cam_ui.html").read() + "\n" + s[j:]
i = s.index("// ---------- UI: Highways prototype")
j = s.rindex("</script>")
s = s[:i] + open(f"{d}/cam_main.js").read().replace("</script>\n", "").rstrip() + "\n" + s[j:]
open(f"{d}/template_cam.html", "w").write(s)
print("assembled")
