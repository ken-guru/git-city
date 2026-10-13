import sys
d = sys.argv[1]
s = open(f"{d}/template2.html").read()

def rep(a, b):
    global s
    assert a in s, a[:70]
    s = s.replace(a, b, 1)

rep("<title>City Layout Prototype</title>", "<title>Countryside Prototype</title>")
rep("""<!--
  PROTOTYPE, throw away. Answers: "How does the precomputed EvoStreets layout""",
    """<!--
  PROTOTYPE, throw away. Answers: "What does the decorative Countryside between the villages look like, and how does it
  stay out of the way and stable?" Ticket: Countryside scenery (ken-guru/git-city#21). Three scenery styles: #A / #B / #C.
  The layout code is carried over from the city layout prototype (git-city#12), with villages now avoiding rivers and hills.
  ORIGINAL HEADER: "How does the precomputed EvoStreets layout""")
# villages avoid rivers and hills, falling back only when there is no room
rep("""    let seed = [0, 0];
    if (villages.size) {
      const gap = spacing * CW + 2 * R;
      search: for (let r = 0; r < 4000; r += CW / 2) {""",
    """    let seed = [0, 0];
    {
      const gap = spacing * CW + 2 * R;
      const seeds = [...villages.values()].map(v => v.seed);
      search: for (const lvl of [2, 1, 0]) for (let r = 0; r < 4000; r += CW / 2) {""")
rep("""          if (!nearOther(x, z, null, gap) && [...villages.values()].every(v => Math.hypot(v.seed[0] - x, v.seed[1] - z) >= gap)) { seed = [x, z]; break search; } }""",
    """          if (seeds.every(([sx, sz]) => Math.hypot(sx - x, sz - z) >= gap) && !blockedArea(x, z, lvl) && !nearOther(x, z, null, gap)) { seed = [x, z]; break search; } }""")
rep("""  function claim(v, owner, born) {
    let best = null, mine = null, bestFree = null, mineFree = null;""",
    """  const claim = (v, owner, born) => claimAt(v, owner, born, 2) ?? claimAt(v, owner, born, 1) ?? claimAt(v, owner, born, 0);
  function claimAt(v, owner, born, lvl) {
    let best = null, mine = null, bestFree = null, mineFree = null;""")
rep("""      if (nearOther(x, z, v, 2 * R + 0.2)) continue;                         // would overlap another village""",
    """      if (nearOther(x, z, v, 2 * R + 0.2)) continue;                         // would overlap another village
      if (blockedArea(x, z, lvl)) continue;                                   // river, hill or mountain""")
rep("""    const cell = { i: pick.i, j: pick.j, x: pick.x, z: pick.z, rot: v.rot, owner, born, used: 0, fragment, village: v };""",
    """    const cell = { i: pick.i, j: pick.j, x: pick.x, z: pick.z, rot: v.rot, owner, born, used: 0, fragment, village: v };
    if (lvl < 2) out.forced = (out.forced ?? 0) + 1;""")
rep("  const ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshLambertMaterial({ color: css('--ground') }));",
    "  const ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshLambertMaterial({ color: css('--ground') })); ground.name = 'flatGround';")
rep("    treeMesh.count = n; scene.add(treeMesh);", "    treeMesh.count = n; treeMesh.name = 'countryTrees'; scene.add(treeMesh);")
rep("\n// ---------- three.js ----------", open(f"{d}/scenery.js").read() + "\n// ---------- three.js ----------")
# hide the layout prototype's panel and switcher; keep its timeline bar
rep('<aside id="panel"', '<aside id="panel" hidden')
rep('<nav id="switcher"', '<nav id="switcher" hidden')
rep('<script id="data"', open(f"{d}/scenery_ui.html").read() + '\n<script id="data"')
i = s.index("// ---------- UI ----------")
j = s.rindex("</script>")
s = s[:i] + open(f"{d}/scenery_main.js").read().replace("</script>\n", "").rstrip() + "\n" + s[j:]
open(f"{d}/template_scenery.html", "w").write(s)
print("assembled")
