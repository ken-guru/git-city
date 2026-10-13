import sys
d = sys.argv[1]
s = open(f"{d}/template2.html").read()
ui = open(f"{d}/player_ui.html").read()
js = open(f"{d}/player.js").read().replace("const root = $('player');", "const proot = $('player');").replace("root.querySelectorAll", "proot.querySelectorAll").replace("root.addEventListener", "proot.addEventListener")
js = js.replace("if (el.offsetParent || el.closest('#pc-edge:not([hidden])')) drawScrub(el);", "if (!el.closest('[hidden]')) drawScrub(el);")

def rep(a, b):
    global s
    assert a in s, a[:60]
    s = s.replace(a, b, 1)

rep("<title>City Layout Prototype</title>", "<title>Player Controls Prototype</title>")
rep("""<!--
  PROTOTYPE, throw away. Answers: "How does the precomputed EvoStreets layout""",
    """<!--
  PROTOTYPE, throw away. Answers: "How should the player controls and timeline look and behave?"
  Ticket: Player controls and timeline (ken-guru/git-city#18). Three player designs over the chosen villages layout,
  switchable with #A / #B / #C or the [ and ] keys. Chunk streaming is simulated (100-commit chunks, fetched in order).
  The layout code below is carried over unchanged from the city layout prototype (git-city#12):
  ORIGINAL HEADER: "How does the precomputed EvoStreets layout""")
rep('<aside id="panel"', '<aside id="panel" hidden')
rep('<nav id="switcher"', '<nav id="switcher" hidden')
rep('<div id="timeline">', '<div id="timeline" hidden>')
rep('<script id="data"', ui + '\n<script id="data"')
i = s.index("// ---------- UI ----------")
j = s.rindex("</script>")
s = s[:i] + js.replace("</script>\n", "").rstrip() + "\n" + s[j:]
open(f"{d}/template_player.html", "w").write(s)
print("assembled")
