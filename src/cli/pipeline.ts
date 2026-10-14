import { EVENT_BLOCK_OWNER, EVENT_DISTRICT_MERGE, EVENT_DISTRICT_SPLIT, EVENT_ROAD_BUILT, EVENT_ROAD_LANES } from "../shared/format.js";
import type { CommitRecord } from "./history.js";
import { ImportGraph, type GraphSnapshot, widthStepFor } from "./imports/graph.js";
import { buildRoadNetwork, type RoadNetwork } from "./imports/roads.js";
import { LayoutBuilder, type LayoutChange, type LayoutOptions, type LayoutSnapshot } from "./layout.js";
import { RoadHistory, type RoadHistorySnapshot } from "./roadhistory.js";

import { pathExcluder } from "./rules.js";
import { TimelineBuilder, type TimelineSnapshot } from "./timeline.js";



/**
 * A commit with the excluded paths taken out. A rename with one side excluded is no rename here: its other side
 * is an add (out of the excluded folder) or a delete (into it). Both sides excluded drops it.
 */
export function withoutExcluded(commit: CommitRecord, excluded: (path: string) => boolean): CommitRecord {
  const keep = (path: string) => !excluded(path);
  const renamed = (commit.renamed ?? []).filter((r) => keep(r.from) && keep(r.to));
  const lines = commit.lines === undefined ? undefined : new Map([...commit.lines].filter(([path]) => keep(path)));
  return {
    ...commit,
    added: commit.added.filter(keep),
    deleted: commit.deleted.filter(keep),
    modified: commit.modified.filter(keep),
    renamed,
    lines,
    writes: commit.writes.filter((w) => keep(w.path)),
  };
}

/**
 * The per-commit fold the build runs: the Timeline, the import graph, the layout and the Road history, fed one commit
 * at a time in history order. Each commit's file changes go to the Timeline; its import edges go to the graph; the
 * graph's fan-in becomes width steps for the layout, which places the Lots; and the layout's District and Block
 * changes become events. The Road network is sampled every so often, and each sample's changes become Road events.
 */

/** Commits between Road samples, before the villages are many enough to slow each sample down. */
export const ROAD_SAMPLE_COMMITS = 25;
/** Villages per extra step of sampling interval: the network costs grow with the square of the villages. */
const VILLAGES_PER_SAMPLE_STEP = 20;

export interface PipelineOptions {
  /** The City seed: the layout's and the Countryside's seed. */
  seed: number;
  /** Reads a blob's text, for config files the import graph resolves against. */
  readText: (blob: string) => Promise<string>;
  /** `exclude` globs: matching paths are left out of the City entirely (config, SPEC §10). */
  exclude?: string[];
  /** The layout's Category and hue functions (see LayoutOptions). */
  categoryOf?: LayoutOptions["categoryOf"];
  hueOf?: LayoutOptions["hueOf"];
}

function layoutOptions(options: PipelineOptions): LayoutOptions {
  return { seed: options.seed, categoryOf: options.categoryOf, hueOf: options.hueOf };
}

/** The run state a cache checkpoint keeps for the Timeline, the import graph and the Road history. The layout is kept in its own layer. */
export interface RunState {
  timeline: TimelineSnapshot;
  graph: GraphSnapshot;
  roads: RoadHistorySnapshot;
}

export class Pipeline {
  /** The Road network at the last commit, once `finish` has run. */
  roadNetwork: RoadNetwork | undefined;
  private readonly excluded: (path: string) => boolean;
  private readonly hasExclusions: boolean;

  private constructor(
    private readonly options: PipelineOptions,
    readonly timeline: TimelineBuilder,
    readonly graph: ImportGraph,
    readonly layout: LayoutBuilder,
    readonly roads: RoadHistory,
  ) {
    this.excluded = pathExcluder(options.exclude ?? []);
    this.hasExclusions = (options.exclude?.length ?? 0) > 0;
  }

  static fresh(options: PipelineOptions): Pipeline {
    return new Pipeline(
      options,
      new TimelineBuilder(),
      new ImportGraph({ readText: options.readText }),
      new LayoutBuilder(layoutOptions(options)),
      new RoadHistory(),
    );
  }

  /** Resumes from a checkpoint's run state and layout. Undefined when the layout was laid out from another seed. */
  static restore(options: PipelineOptions, run: RunState, layout: LayoutSnapshot): Pipeline | undefined {
    const restoredLayout = LayoutBuilder.restore(layoutOptions(options), layout);
    if (restoredLayout === undefined) return undefined;
    return new Pipeline(
      options,
      TimelineBuilder.restore(run.timeline),
      ImportGraph.restore({ readText: options.readText }, run.graph),
      restoredLayout,
      RoadHistory.restore(run.roads),
    );
  }

  /** The state to checkpoint for the Timeline, the graph and the Road history, as JSON-safe values. */
  runState(): RunState {
    return { timeline: this.timeline.snapshot(), graph: this.graph.snapshot(), roads: this.roads.snapshot() };
  }

  /** Applies one commit to all of them. Every commit gives the layout a change, so its sequence numbers are commit numbers. */
  async add(input: CommitRecord): Promise<void> {
    const record = this.hasExclusions ? withoutExcluded(input, this.excluded) : input;
    const change = this.timeline.add(record);
    const touched = await this.graph.apply({
      writes: record.writes.map((w) => ({ path: w.path, blob: w.blob, specifiers: w.facts.imports })),
      deleted: record.deleted,
    });

    // Each file whose fan-in may have changed, or that arrived or moved in this commit, gets its width step re-read.
    const candidates = new Set<string>([...touched, ...change.added.map((a) => a.path), ...change.moved.map((m) => m.to)]);
    const widths: NonNullable<LayoutChange["widths"]> = [];
    for (const path of candidates) {
      const file = this.timeline.fileAt(path);
      if (file !== undefined) widths.push({ file, step: widthStepFor(this.graph.fanIn(path)) });
    }
    widths.sort((a, b) => a.file - b.file);
    for (const event of this.layout.apply({ ...change, widths })) {
      if (event.kind === "owner") this.timeline.recordEvent(EVENT_BLOCK_OWNER, event.block, event.district);
      else this.timeline.recordEvent(event.kind === "split" ? EVENT_DISTRICT_SPLIT : EVENT_DISTRICT_MERGE, event.district, event.parent);
    }
    if (this.timeline.commits() % this.sampleInterval() === 0) this.sampleRoads();
  }

  /**
   * Called once the history is read and checkpointed: samples the Road network at the last commit, so the final Roads
   * and their changes are in the Timeline, and keeps the final network. It runs after the checkpoint, so the
   * checkpoint holds only the scheduled samples. Sampling the same commit again records nothing new.
   */
  finish(): void {
    if (this.timeline.commits() > 0) this.sampleRoads();
  }

  /** Commits between samples: longer for larger networks, whose samples cost more. */
  private sampleInterval(): number {
    return ROAD_SAMPLE_COMMITS * Math.max(1, Math.ceil(this.layout.villageCount() / VILLAGES_PER_SAMPLE_STEP));
  }

  /** Samples the Road network now, and records the Road events it causes at the last commit. */
  private sampleRoads(): void {
    this.roadNetwork = this.network();
    for (const event of this.roads.sample(this.roadNetwork, this.timeline.commits())) {
      if (event.kind === EVENT_ROAD_BUILT) this.timeline.recordEvent(EVENT_ROAD_BUILT, event.road, 0);
      else this.timeline.recordEvent(EVENT_ROAD_LANES, event.road, event.backward, event.forward);
    }
  }

  /** The Road network the layout and the import graph give now (SPEC §7). */
  private network(): RoadNetwork {
    const layout = this.layout.result();
    const villageOf = new Map(layout.districts.map((d) => [d.key, d.village] as const));
    const links = this.graph.districtLinks((path) => this.layout.districtForPath(path));
    return buildRoadNetwork(
      layout.villages.map((v) => ({ id: v.id, col: v.col, row: v.row })),
      links,
      (district) => villageOf.get(district),
    );
  }
}
