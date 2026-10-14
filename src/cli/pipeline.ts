import type { CommitRecord } from "./history.js";
import { ImportGraph, type GraphSnapshot, widthStepFor } from "./imports/graph.js";
import { LayoutBuilder, type LayoutChange, type LayoutOptions, type LayoutSnapshot } from "./layout.js";
import { TimelineBuilder, type TimelineSnapshot } from "./timeline.js";

/**
 * The per-commit fold the build runs: the Timeline, the import graph and the layout, fed one commit at a time in
 * history order. Each commit's file changes go to the Timeline; its import edges go to the graph; and the graph's
 * fan-in becomes width steps for the layout, which places the Lots.
 */

export interface PipelineOptions {
  /** The City seed: the layout's and the Countryside's seed. */
  seed: number;
  /** Reads a blob's text, for config files the import graph resolves against. */
  readText: (blob: string) => Promise<string>;
  /** The layout's Category and hue functions (see LayoutOptions). */
  categoryOf?: LayoutOptions["categoryOf"];
  hueOf?: LayoutOptions["hueOf"];
}

function layoutOptions(options: PipelineOptions): LayoutOptions {
  return { seed: options.seed, categoryOf: options.categoryOf, hueOf: options.hueOf };
}

/** The run state a cache checkpoint keeps for the Timeline and the import graph. The layout is kept in its own layer. */
export interface RunState {
  timeline: TimelineSnapshot;
  graph: GraphSnapshot;
}

export class Pipeline {
  private constructor(
    private readonly options: PipelineOptions,
    readonly timeline: TimelineBuilder,
    readonly graph: ImportGraph,
    readonly layout: LayoutBuilder,
  ) {}

  static fresh(options: PipelineOptions): Pipeline {
    return new Pipeline(
      options,
      new TimelineBuilder(),
      new ImportGraph({ readText: options.readText }),
      new LayoutBuilder(layoutOptions(options)),
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
    );
  }

  /** The state to checkpoint for the Timeline and the graph, as JSON-safe values. */
  runState(): RunState {
    return { timeline: this.timeline.snapshot(), graph: this.graph.snapshot() };
  }

  /** Applies one commit to all three. Every commit gives the layout a change, so its sequence numbers are commit numbers. */
  async add(record: CommitRecord): Promise<void> {
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
    this.layout.apply({ ...change, widths });
  }
}
