import type { Scene } from "three";
import { type ChangeIndex, captionLine, OTHER_COLOUR, rankPeople, SUMMARY_COMMITS, SUMMARY_SECONDS, summaryLine, windowOf } from "./contributors.js";
import { type Timelines } from "./state.js";
import { PinLayer, highlightSpots, visiblePins } from "./pins.js";
import { renderLegend } from "./legend.js";
import { NO_CONTENT, type World } from "../shared/format.js";

export interface ContributorView {
  /** Called every frame with the Timeline position `t`, the playback speed and the date label of the current commit. */
  update(t: number, commitsPerSecond: number, when: string): void;
}

/**
 * The Contributors and commit messages view (SPEC §11): pins over changed Buildings, the legend, and the caption.
 * Returns nothing when the world holds neither, so the output's absence of the data means no view at all.
 * `strings` is strings.json, which the names and messages index into.
 */
export function createContributorView(
  scene: Scene,
  world: World,
  timelines: Timelines,
  changes: ChangeIndex,
  strings: readonly string[] | undefined,
): ContributorView | undefined {
  const columns = world.contributors;
  const messages = world.messages;
  if (!columns && !messages) return undefined;

  const text = (id: number | undefined): string | undefined =>
    strings !== undefined && id !== undefined && id !== NO_CONTENT ? strings[id] : undefined;
  const people = columns ? rankPeople(columns, world.stepCommits) : undefined;
  const whoAt = (commit: number): number | undefined => {
    const who = columns?.ofStep[commit];
    return who === undefined || columns === undefined || who >= columns.name.length ? undefined : who;
  };
  const colourOf = (commit: number): number => {
    const who = whoAt(commit);
    return people !== undefined && who !== undefined ? people.colourOf(who) : OTHER_COLOUR;
  };
  const messageAt = (commit: number) => text(messages?.[commit]);
  const nameOf = (who: number | undefined) => (who === undefined ? undefined : text(columns?.name[who]));

  const pins = new PinLayer(scene);
  let highlighted: number | undefined;
  let highlightedAt = -1;
  const legend = document.getElementById("legend");
  if (legend && people && columns) {
    const automation = Array.from(columns.automation).indexOf(1);
    renderLegend(
      legend,
      { people, nameOf: (c) => nameOf(c) ?? "", automation: automation >= 0 ? automation : undefined },
      (c) => {
        highlighted = c;
        highlightedAt = -1;
        if (c === undefined) pins.setHighlight([]);
      },
    );
  }
  const caption = document.getElementById("caption");

  return {
    update(t, commitsPerSecond, when) {
      const commit = Math.min(world.commitDays.length - 1, Math.max(0, Math.floor(t)));
      pins.setPins(visiblePins(changes, world, timelines, t, colourOf));
      if (highlighted !== undefined && highlightedAt !== commit) {
        highlightedAt = commit;
        pins.setHighlight(highlightSpots(changes, world, timelines, commit, highlighted, colourOf, whoAt));
      }
      if (!caption) return;
      const latest = messageAt(commit);
      // Fast playback turns the caption into a summary of the commits passed in the last few seconds (SPEC §11).
      const stretch = columns
        ? windowOf(columns.ofStep, world.stepCommits, commit - Math.ceil(commitsPerSecond * SUMMARY_SECONDS) + 1, commit)
        : undefined;
      const line =
        stretch !== undefined && stretch.commits > SUMMARY_COMMITS
          ? summaryLine(stretch.commits, stretch.people, latest)
          : captionLine({ date: when, contributor: nameOf(whoAt(commit)), message: latest });
      caption.textContent = line;
      caption.hidden = line === "";
    },
  };
}
