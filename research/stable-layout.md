# Stable city layout over time

Research for [#5](https://github.com/ken-guru/git-city/issues/5), part of the map [#1](https://github.com/ken-guru/git-city/issues/1).

**Question.** Which layout approaches keep a software city stable over time, so that Buildings and Districts don't jump around as files appear, grow, shrink and disappear across commits, while still leaving room for Roads between Districts and Buildings?

**Settled context.** Files are Buildings. Modules are colour-coded Districts with exactly one nested level (Neighbourhoods). Roads connect Buildings and Districts, with Lanes in proportion to connection strength. External Cities sit on the horizon. The target is about 50k commits and 20k files at once. The whole history is known up front.

---

## Answer in brief

1. **Precompute one layout over the whole Timeline, and never move a lot once it has been given out.** Both software-city tools that solved stability do this. CodeCity's time travel gives every artefact "an individual real estate in the city, maintained throughout the entire evolution". m3triCity's History-Resistant Layout gives each element a fixed position for the whole history. The known cost is extra space: every entity holds a lifetime lot, even a short-lived one. ([Wettel & Lanza 2008](#s-wettel08); [Pfahler et al. 2020](#s-pfahler20))
2. **Use a street layout (EvoStreets style) and order lots by birth time, not by size.** EvoStreets lays each directory out as a street, with its children on alternating sides. In SEE's implementation, nodes that already existed keep their previous order, and new nodes go at the end of the street. Growth makes streets longer but does not reorder them, so the layout stays stable. The street network also doubles as the Road system. ([SEE `EInner.cs`](#s-see-einner); [Steinbrückner thesis](#s-steinbrueckner))
3. **Avoid size-sorted packing and squarified treemaps for the main layout.** Both reorder their contents whenever sizes change. CodeCity's packing places the largest building first. The squarified treemap is consistently rated the least stable. Benchmarks show a hard trade-off: algorithms that stay stable lose aspect-ratio quality, and the others keep their aspect ratios but lose stability. ([Wettel & Lanza 2007](#s-wettel07); [Vernier et al. 2020](#s-vernier20))
4. **If a treemap look is wanted inside a Neighbourhood**, use an ordered or space-filling-curve treemap (Strip, Spiral, Hilbert/Moore) with birth order as its input order. A state-aware option is Local Moves or d3's `treemapResquarify`. Leave padding between cells for Roads. ([Bederson et al. 2002](#s-bederson02); [Tak & Cockburn 2013](#s-tak13); [Sondag et al. 2018](#s-sondag18); [d3 docs](#s-d3))
5. **A force-directed layout (Gource) is the wrong family for GitCity.** Gource simulates its layout live, frame by frame. Its positions come from forces between siblings and parents, plus random nudges when nodes overlap. It is lively but cannot be reproduced, and it has no notion of a reserved lot. ([Gource `dirnode.cpp`](#s-gource))

The recommendation for GitCity is in [Recommendation](#recommendation-for-gitcity).

---

## Software-city tools

| Tool | Layout family | How it handles growth | Precomputed or incremental | Streets / Roads |
|---|---|---|---|---|
| **CodeCity** (single version) | Rectangle packing (kd-tree, a "modified treemap"), applied at each nesting level; buildings placed **largest first** | Re-packs, so sizes changing between versions reorder everything | Per version | None. Districts are stacked platforms. |
| **CodeCity** (time travel) | Same packing, but every artefact has a lifetime lot | Removed or not-yet-born artefacts leave **empty space that no other artefact may use** | **Precomputed over the whole sampled history** | None |
| **m3triCity** | Recursive bin packing with a "History-Resistant Layout" | Each element keeps a fixed position. Packages reserve the space they will eventually need from the first revision. | **Precomputed** from the version history | None |
| **EvoStreets** (Steinbrückner & Lewerentz; reimplemented in SEE) | Hierarchical streets: a directory is a street, and its children are placed alternately on both sides | Existing children keep their order. **New children are appended at the street end**, which makes streets longer. | **Incremental** (SEE chains each layout onto the previous one); the original also maps creation time onto elevation ("hills") | **Built-in.** Streets are the hierarchy, and street width shrinks with depth. |
| **CodeCharta** | Squarified treemap, StreetLayout, or TreeMapStreet (streets near the top, squarified treemaps for small subtrees); folders can be pinned with `fixedPosition` | Stateless. The changelog credits the street layout with "stable positioning of nodes after metric changes". Delta mode merges two versions into one tree that also holds deleted nodes. | Per file. Comparing two versions uses the merged tree. | Street layout only |
| **Gource** | Live force-directed tree (directories as nodes, files as leaves) | Nodes repel their siblings and are pulled towards their parent. Idle files fade out after `--file-idle-time`. | **Incremental, simulated every frame** | Curved tree edges, not streets |
| **Software Cartography** (Kuhn et al.) | Multidimensional scaling over vocabulary similarity (LSI) | Positions follow the vocabulary, which the authors argue changes little over time | One map, reused across views | None. The map is a terrain. |

### CodeCity (Wettel & Lanza)

- **Single-version layout:** "Laying out buildings ... boils down to a two-dimensional rectangle-packing problem ... We implemented a modified treemap algorithm ... We use a binary tree structure ... to keep track of the space ... Within each district, the order in which the buildings are placed is given by their sizes (largest first)." The layout runs at every package nesting level. <a id="s-wettel07"></a>([Wettel & Lanza, *Visualizing Software Systems as Cities*, VISSOFT 2007](https://wettel.github.io/download/Wettel07b-vissoft.pdf), §2.3)
  - The largest-first rule is why this layout is unstable: when sizes change between versions, the packing order changes too.
- **Time travel (evolution):** "We make sure that every artifact is assigned an individual real estate in the city, maintained throughout the entire evolution, i.e., if an artifact is removed from the system or does not yet exist in the system at a certain point in time, this is denoted by an empty space that cannot be occupied by other artifacts."
  - The cost: "Due to the evolutionary layout which takes into account the entire history of every software element in the system, we support consistent locality ... The price of providing consistent locality is the extra space used by the layout for allocating lifetime estates to every entity (even to ones with a short life)."
  - In the fine-grained view, methods are stacked as bricks "in the order of their creation (i.e., older down, newer up)", and removed methods leave gaps. Chronological order is the stabilising rule at the brick level too. <a id="s-wettel08"></a>([Wettel & Lanza, *Visual Exploration of Large-Scale System Evolution*, WCRE 2008](https://wettel.github.io/download/Wettel08d-wcre.pdf), §4.1.2 and §6)
- **Scale:** the studied systems had about 1,000 classes and 50 sampled versions. Versions were sampled, not taken commit by commit, and the authors note that an age colour scheme "works best up to a maximum of 10 versions".

### m3triCity (Pfahler, Minelli, Nagy & Lanza)

- The paper's motivation is that the city metaphor "falls short when depicting the evolution of a system, which results in buildings and districts moving around in unpredictable ways". It proposes a **History-Resistant Layout** that gives each element a fixed position in 3D space for the whole evolution.
- According to the accompanying thesis, the layout still places elements with recursive bin packing. However, a package uses "since R1 the space it will ultimately need", and the layout reserves the "maximum real estate needed for each class". <a id="s-pfahler20"></a>([Pfahler et al., *Visualizing Evolving Software Cities*, VISSOFT 2020](https://www.inf.usi.ch/lanza/Downloads/Pfah2020a.pdf); [Pfahler MSc thesis, 2020](https://www.inf.usi.ch/lanza/Downloads/MSc/Pfah2020b.pdf); [Ardigò et al., *M3triCity*, arXiv:2204.10006](https://arxiv.org/abs/2204.10006))
  - *Caveat:* the sandbox could not reach the full text, so these quotes come from the abstract and indexed excerpts. The exact sizing rule (maximum footprint over the lifetime) has not been verified in the paper itself.

### EvoStreets (Steinbrückner & Lewerentz), as implemented in SEE

- **Original work:** Steinbrückner & Lewerentz, *Representing development history in software cities* (SoftVis 2010), and *Understanding software evolution with software cities* (Information Visualization, 2013). <a id="s-steinbrueckner"></a>Steinbrückner's thesis, *Consistent Software Cities* (BTU Cottbus, 2012), presents "a new layout approach which explicitly takes the development history of software systems into account". The layouts "evolve smoothly during system evolution", and "the high consistency of this approach is confirmed in an empirical evaluation". ([BTU thesis record](https://opus4.kobv.de/opus4-btu/frontdoor/index/index/docId/1681))
  - The evaluation compared EvoStreets with a packing layout and a force-directed layout, using movement and order-change metrics. EvoStreets came out as the most stable for typical development.
  - Elevation (hills) encodes creation time.
  - Later work from Bremen summarises the property: changes to the model "may cause local layout adaptations" that shift lots and streets, but "because the order of neighbouring representations is preserved, the overall structure isn't disrupted". ([Steinbeck, Koschke & Rüdel, SANER 2020](https://see.uni-bremen.de/wp-content/uploads/2021/03/How-EvoStreets-Are-Observed-in-Three-Dimensionaland-Virtual-Reality-Environments.pdf))
- **Concrete algorithm:** SEE (University of Bremen, open source) is the most concrete primary source. <a id="s-see-einner"></a>Its `EvoStreetsNodeLayout` implements the `IIncrementalNodeLayout` interface and works in two passes.
  - **Pass 1 sizes every node.** The children of each inner node are distributed greedily to the left and right of its street, so that both sides have similar total length, with a fixed gap between buildings. Street width is "a relative proportion of StreetWidth: the fraction of TreeDepth and MaximalDepth". The street orientation alternates at each level.
  - **Pass 2 places the nodes** along their streets.
  - **Stability rule:** "If this EInner node is new, its children are considered new, too, and hence, we do not need to care about a stable layout ... We want to preserve the original order of all existing children in the previous layout. Sort each partition according to the world-space center position ... Then place the newNodes at the end of the street."
  - A node whose parent changed (a move) counts as new.
  - Sources: [`EvoStreetsNodeLayout.cs`](https://github.com/uni-bremen-agst/SEE/blob/master/Assets/SEE/Layout/NodeLayouts/EvoStreetsNodeLayout.cs), [`EvoStreets/EInner.cs`](https://github.com/uni-bremen-agst/SEE/blob/master/Assets/SEE/Layout/NodeLayouts/EvoStreets/EInner.cs), [`EvoStreets/EvoStreets.cs`](https://github.com/uni-bremen-agst/SEE/blob/master/Assets/SEE/Layout/NodeLayouts/EvoStreets/EvoStreets.cs)
- **Other layouts in SEE:** SEE also ships an `IncrementalTreeMapLayout` based on Sondag et al.'s Local Moves, which also implements `IIncrementalNodeLayout`. It draws dependency edges with Holten's hierarchical edge bundling (`BundledEdgeLayout.cs`). Both are relevant to Roads. ([`IncrementalTreeMapLayout.cs`](https://github.com/uni-bremen-agst/SEE/blob/master/Assets/SEE/Layout/NodeLayouts/IncrementalTreeMapLayout.cs); [`BundledEdgeLayout.cs`](https://github.com/uni-bremen-agst/SEE/blob/master/Assets/SEE/Layout/EdgeLayouts/BundledEdgeLayout.cs))
- **How growth works:** a street gets longer when a child is added. Lengthening a street pushes the later siblings and the parent's other subtrees outwards. Positions therefore **shift**, but the order never changes.
  - With a fully precomputed history, the sizes can come from the final (or union) state instead. Then nothing shifts at all, and the city simply fills its reserved lots in over time.

### CodeCharta (MaibornWolff)

- The visualisation offers a squarified treemap and two street layouts. From the changelog: "In street layout file nodes are displayed as buildings and directories are displayed as streets. A street layout has the advantage of a more apparent directory structure and stable positioning of nodes after metric changes ... TMStreet: a combination of street layout and squarified layout." ([visualization/CHANGELOG.md](https://github.com/MaibornWolff/codecharta/blob/main/visualization/CHANGELOG.md))
  - In the code, `StreetLayoutGenerator` switches to a squarified treemap for subtrees with no more than `maxTreeMapFiles` files. ([`streetLayoutGenerator.ts`](https://github.com/MaibornWolff/codecharta/blob/main/visualization/app/codeCharta/renderer/threeViewer/algorithm/streetLayout/streetLayoutGenerator.ts))
- **Manual pinning:** a `fixedPosition` property in `cc.json` "allows to fixate folders in the map", and it supports nested fixed folders. This is how a user pins Districts by hand. (same changelog)
- **Delta mode:** `DeltaGenerator.getDeltaFile` merges the reference and comparison trees by path. Added nodes and deleted nodes both stay in the merged tree, so the two versions are drawn on a single layout of their union. This is the two-version form of "lay out the union of history". ([`deltaGenerator.ts`](https://github.com/MaibornWolff/codecharta/blob/main/visualization/app/codeCharta/util/deltaGenerator.ts))

### Gource

<a id="s-gource"></a>
- **What it draws:** "The repository is displayed as a tree where the root of the repository is the centre, directories are branches and files are leaves." ([README](https://github.com/acaudwell/Gource/blob/master/README.md))
- **How it lays out:** in [`src/dirnode.cpp`](https://github.com/acaudwell/Gource/blob/master/src/dirnode.cpp), `RDirNode::applyForces` combines several forces:
  - attraction to sit on the parent's radius (`gGourceForceGravity`);
  - a push along the grandparent-to-parent direction;
  - repulsion from siblings, scaled by slice size;
  - overlap resolution between nodes, with a random nudge when two nodes coincide.
- **Updates:** `move(dt)` integrates the forces every frame, with optional `--elasticity`. New nodes start near their parent, offset by `vec2Hash(abspath)`.
- **Idle files:** files that stay idle are removed after `--file-idle-time`.
- **Verdict:** this is a fully incremental, frame-by-frame simulation with no reserved space. It fits Gource's organic look, but it does not give the "same place every time" property GitCity needs, and it does not produce street geometry.

### Software Cartography (Kuhn, Erni, Loretan & Nierstrasz)

- Positions come from multidimensional scaling over LSI vocabulary vectors, so the same map can be reused across thematic views. The authors argue the approach suits evolving software because "software vocabulary tends to remain stable over time". ([Kuhn et al., *Consistent Layout for Thematic Software Maps*, WCRE 2008, arXiv:1209.5490](https://arxiv.org/abs/1209.5490); JSME 22(3), 2010)
- It is not hierarchical and has no streets. It is listed here as the "semantic position" alternative, which GitCity's privacy rule rules out because it would need code vocabulary.

---

## Stable and ordered treemap research

### The core trade-off

<a id="s-vernier20"></a>Vernier, Sondag, Comba, Speckmann, Telea & Verbeek benchmarked 14 rectangular treemap algorithms on more than 2,000 time-dependent datasets, including monthly lines-of-code snapshots of GitHub repositories. ([*Quantitative Comparison of Time-Dependent Treemaps*, EuroVis 2020 / CGF 39(3), arXiv:1906.06014](https://arxiv.org/abs/1906.06014); [code and datasets](https://github.com/EduardoVernier/treemap-comparison-resources))

- **Two families.** *State-aware* algorithms compute each step from the previous layout. *Stateless* algorithms recompute each step from the data alone.
- **The trade-off.** As the data becomes more volatile, "for the stateless algorithms ... visual quality seems to be largely unaffected ... The stability however decreases quickly. Conversely, for the state-aware algorithms ... the stability is largely unaffected, but the visual quality decreases."
- **Design matters.** Algorithms designed to be stable do turn out to be more stable across data features.
- **The extremes.** Earlier comparisons by the same group put Squarified at one end, with the best aspect ratios but the least stable layouts, and Slice-and-Dice at the other, very stable but with poor aspect ratios.
- *Caveat:* the sandbox could not reach the full PDF, so these sentences come from search-indexed excerpts.

### The algorithms

The reference list is cross-checked against the benchmark's [algorithm index](https://eduardovernier.github.io/dynamic-treemap-resources-eurovis/docs/treemaps/algorithms/).

- **Ordered (Pivot-by-\*) and Strip treemaps.** Shneiderman & Wattenberg (InfoVis 2001) and <a id="s-bederson02"></a>Bederson, Shneiderman & Wattenberg, *Ordered and Quantum Treemaps* (ACM TOG 21(4), 2002). The abstract makes three points:
  - Squarified-style algorithms "introduce instability over time in the display of dynamically changing data, fail to preserve order of the underlying data".
  - With ordered layouts, "items near each other in the given order will be near each other in the treemap layout".
  - Monte Carlo trials and stock data showed ordered treemaps "are more stable, while maintaining relatively favorable aspect ratios".
  - Strip lays items out in rows in their input order. That makes it a direct fit for "order by birth time". ([UMD record](https://drum.lib.umd.edu/handle/1903/6486))
- **Spiral treemap.** Tu & Shen, *Visualizing Changes of Hierarchical Data Using Treemaps* (IEEE TVCG 13(6), InfoVis 2007). The aim is "to reduce abrupt layout changes and produce consistent visual patterns", and it reports "a good balance in maintaining a treemap's stability, continuity, readability, and average aspect ratio". Items follow a spiral in input order, so items appended at the end land on the outside.
- **Hilbert and Moore treemaps.** <a id="s-tak13"></a>Tak & Cockburn, *Enhanced Spatial Stability with Hilbert and Moore Treemaps* (IEEE TVCG 19(1), 2013). Items are placed along a space-filling curve in input order. The paper introduces a "location drift" metric and reports that the two algorithms perform well on every stability metric it tested.
- **Local Moves.** <a id="s-sondag18"></a>Sondag, Speckmann & Verbeek, *Stable Treemaps via Local Moves* (IEEE TVCG 24(1), 2018). It is state-aware: it starts from the Nagamochi–Abe approximation layout and allows only a few local changes to the layout between time steps. SEE's `IncrementalTreeMapLayout` implements it, using Eppstein et al.'s area-universal layouts to resize nodes without changing their relative positions.
- **Greedy Insertion (GIT).** Vernier, Comba & Telea (GPI 2018) designed it specifically for software evolution. Later work reports that it scores well on stability but poorly on aspect ratio.
- **EvoCells.** Scheibel, Weyand & Döllner (IVAPP 2018). It is state-aware and turns tree changes into rectangle insertions, removals, growth and shrinkage on an existing layout, in O(n log n). It was evaluated on the ElasticSearch repository. ([SciTePress](https://www.scitepress.org/Papers/2018/66171))
- **d3 `treemapResquarify`.** <a id="s-d3"></a>The d3 docs say it is "like treemapSquarify, except preserves the topology (node adjacencies) of the previous layout ... good for animating changes to treemaps because it only changes node sizes and not their relative positions ... The downside of a stable update, however, is a suboptimal layout for subsequent updates."
  - d3's `paddingInner` "is used to separate a node's adjacent children". This is the obvious place to put Roads in a treemap. ([d3-hierarchy treemap docs](https://github.com/d3/d3/blob/main/docs/d3-hierarchy/treemap.md))

### Voronoi treemaps

- **Dynamic Voronoi Treemaps.** Gotz (IBM RC25132, 2011) designed them for "smooth, real-time animation of time varying hierarchical data while maintaining desirable aspect ratios". ([IBM report](https://dominoweb.draco.res.ibm.com/reports/rc25132.pdf)) The method is covered by US patent 8952964, now listed as expired.
- **Stable Voronoi treemaps for varying hierarchies.** Hahn, Trümper, Moritz & Döllner (IVAPP 2014). Existing Voronoi treemap algorithms "do not provide deterministic layouts or assume a fixed hierarchy". Their fix is a **deterministic initial distribution of sites**, which reduces positional variation when the hierarchy changes. ([SciTePress PDF](https://www.scitepress.org/Papers/2014/46862/46862.pdf))
- **Software quality monitoring.** Van Hees & Hage, *Stable and Predictable Voronoi Treemaps for Software Quality Monitoring* (IST 2017), use additively weighted power diagrams. ([ScienceDirect](https://www.sciencedirect.com/science/article/abs/pii/S0950584916302828))
- **Relevance to GitCity:** Voronoi cells look organic and suit districts with irregular shapes, but they are iterative, so they cost more to compute. Their stability comes from seeding deterministically and warm-starting from the previous layout. They also leave no natural street corridors unless the cells are shrunk to create gutters.

---

## How Roads fit in

| Approach | Where Roads come from |
|---|---|
| **Street layouts** (EvoStreets, CodeCharta) | The containment tree **is** the street network: one street per directory, with its children along both sides and side streets for subdirectories. Street width encodes depth. Roads between Districts can follow this network. |
| **Treemaps** | Roads must be carved out as **padding or gutters** (d3 `paddingInner` / `paddingOuter`) between sibling cells. These gutters form a grid of corridors, but nothing in the layout connects them into a planned network. |
| **Packing** (CodeCity) | No roads. Districts are stacked platforms. |
| **Force-directed** (Gource) | Tree edges are drawn as curves. |
| **Dependency edges in software cities** (SEE) | Drawn **above** the city as bundled splines (Holten 2006), not on the ground. |

**For GitCity**, Roads carry Lanes in proportion to connection strength. A street layout supplies the *trunk* network. Connections between Districts can be routed along the trunk (the shortest path through the street tree) and their Lane counts summed per street segment. This gives bundling for free, much as Holten's bundling follows the hierarchy.

Road routing and geometry belong to the separate "Road and Lane geometry" ticket. The point here is that this layout reserves width for those Roads up front.

---

## Recommendation for GitCity

Because the whole first-parent Timeline is known up front, GitCity can use the CodeCity/m3triCity strategy (**precomputed lifetime lots**) together with EvoStreets' geometry (**streets in birth order**).

1. **Union tree.** Replay the first-parent history once and build the union of every path that ever existed.
   - Follow renames (`git log -M` on first-parent diffs) so that a renamed file keeps its identity and its lot. Otherwise a rename shows up as a building being demolished and another one built.
   - Record each Building's birth commit, death commit (if any) and maximum footprint metric.
   - Record each District's and Neighbourhood's birth commit and its maximum aggregate footprint.
2. **District placement (once).** Place the Districts as side streets off a main avenue, or as an ordered (Strip/Spiral) arrangement, **in birth order**, each sized by its **maximum lifetime footprint**. The first Modules end up at the centre of the city and later ones further out, which matches how a real city grows.
3. **Lots within a District.** Inside each District, the Neighbourhoods are side streets, and Buildings get lots along them **in birth order** (EvoStreets' rule, applied to the final layout instead of incrementally).
   - Each lot is sized for the Building's *maximum* footprint (CodeCity's lifetime estate). The Building eases between its current footprint and height within that lot.
   - A deleted Building leaves a vacant lot. CodeCity's rule is that a lot is never reused, and it can be drawn as rubble or a park.
4. **Roads.** Roads use street width reserved by the layout: width grows with the District's maximum connection volume, not only with depth, so the space needed for Lanes exists from the start.
5. **Space cost and mitigation.** Lifetime lots waste space, especially in repos with heavy churn (CodeCity's stated price). There are three mitigations:
   - (a) size lots on a compressed scale, such as the square root of the maximum size, quantised into a few lot sizes;
   - (b) allow a lot to be reused only after its old Building has been gone for a long time, with eased demolition and construction;
   - (c) re-zone at a few keyframes (major refactors), running an eased transition between two precomputed layouts.
   This last option is the "state-aware" trade-off: a little instability in exchange for compactness.
6. **Re-runs that resume.** Birth-order streets have a useful property: new commits only *append* lots to street ends and Districts to the edge of the city. A re-run can therefore extend the saved layout without moving anything that has already been published.
   - The exception is a Building that grows past its recorded maximum after the resume. The simplest fix is to reserve some headroom in each lot (for example, +25%) and let a Building overflow its lot by growing in height only.
7. **Scale.** A union tree of roughly 20k live files, plus the deleted ones, is laid out once in O(n log n) inside the CLI. The page then only needs static lot positions and a per-commit stream of size and visibility changes, which suits the chunked-data output.

### Open questions for the map

- **Module identity over time.** A directory can gain a package manifest midway through history. Should the Module/District split come from the final state, the union, or each moment? The recommendation assumes a single assignment derived from the union, so Districts never split.
- **Moves across Districts.** A file moving to a different directory: is it the same Building relocating (animated), or a demolition plus a new build? SEE treats a node whose parent changed as new.
- **Exact lot-sizing metric** (bytes, lines, a quantised class): this is shared with graceful degradation and level of detail.

---

## Sources

Primary sources were read directly unless marked otherwise.

- Wettel & Lanza, *Visualizing Software Systems as Cities*, VISSOFT 2007. https://wettel.github.io/download/Wettel07b-vissoft.pdf (read)
- Wettel & Lanza, *Visual Exploration of Large-Scale System Evolution*, WCRE 2008. https://wettel.github.io/download/Wettel08d-wcre.pdf (read)
- Pfahler, Minelli, Nagy & Lanza, *Visualizing Evolving Software Cities*, VISSOFT 2020. https://www.inf.usi.ch/lanza/Downloads/Pfah2020a.pdf (abstract and excerpts only)
- Ardigò et al., *M3triCity: Visualizing Evolving Software & Data Cities*, arXiv:2204.10006 (abstract only)
- Steinbrückner, *Consistent Software Cities*, PhD thesis, BTU Cottbus 2012. https://opus4.kobv.de/opus4-btu/frontdoor/index/index/docId/1681 (abstract only)
- SEE source, University of Bremen: https://github.com/uni-bremen-agst/SEE (`Assets/SEE/Layout/NodeLayouts/EvoStreets*`, `IncrementalTreeMapLayout.cs`, `EdgeLayouts/BundledEdgeLayout.cs`) (read)
- CodeCharta source and changelog: https://github.com/MaibornWolff/codecharta (read)
- Gource source and README: https://github.com/acaudwell/Gource (read)
- Kuhn, Loretan & Nierstrasz, *Consistent Layout for Thematic Software Maps*, WCRE 2008, arXiv:1209.5490 (abstract only)
- Vernier et al., *Quantitative Comparison of Time-Dependent Treemaps*, CGF 39(3) 2020, arXiv:1906.06014, and resources at https://github.com/EduardoVernier/treemap-comparison-resources (README read; paper excerpts only)
- Shneiderman & Wattenberg, *Ordered Treemap Layouts*, InfoVis 2001; Bederson, Shneiderman & Wattenberg, *Ordered and Quantum Treemaps*, ACM TOG 21(4) 2002 (abstract only)
- Tu & Shen, *Visualizing Changes of Hierarchical Data Using Treemaps*, IEEE TVCG 13(6) 2007 (abstract only)
- Tak & Cockburn, *Enhanced Spatial Stability with Hilbert and Moore Treemaps*, IEEE TVCG 19(1) 2013 (abstract only)
- Sondag, Speckmann & Verbeek, *Stable Treemaps via Local Moves*, IEEE TVCG 24(1) 2018 (via SEE's implementation notes and citing papers)
- Scheibel, Weyand & Döllner, *EvoCells*, IVAPP 2018 (abstract only)
- Gotz, *Dynamic Voronoi Treemaps*, IBM RC25132, 2011 (abstract only)
- Hahn, Trümper, Moritz & Döllner, *Visualization of Varying Hierarchies by Stable Layout of Voronoi Treemaps*, IVAPP 2014 (abstract only)
- d3-hierarchy treemap documentation: https://github.com/d3/d3/blob/main/docs/d3-hierarchy/treemap.md (read)

*Access note:* the research sandbox could not reach several university and publisher hosts (usi.ch, arxiv.org, uu.nl, kobv.de, uni-bremen.de). Claims about those papers rest on their abstracts and indexed excerpts, as marked above. The software-city mechanics that matter most were checked against source code (SEE, CodeCharta, Gource) or full text (CodeCity).
