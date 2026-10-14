import type { People } from "./contributors.js";

/** The legend's entries: the top people with their commits, "+N more people", and Automation (SPEC §11). */
export interface LegendInput {
  people: People;
  /** The display name of a Contributor. */
  nameOf: (contributor: number) => string;
  /** The Automation Contributor, when there is one. */
  automation?: number;
}

/**
 * Fills `root` with the legend. Hovering, focusing or tapping an entry calls `onHighlight` with that Contributor, and
 * leaving it calls `onHighlight(undefined)`. Tapping an entry that is already lit clears it.
 */
export function renderLegend(root: HTMLElement, input: LegendInput, onHighlight: (contributor: number | undefined) => void): void {
  const { people, nameOf, automation } = input;
  const entries: HTMLElement[] = [];
  const entry = (contributor: number, commits: number) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "legend-entry";
    button.setAttribute("aria-pressed", "false");
    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.style.background = `#${people.colourOf(contributor).toString(16).padStart(6, "0")}`;
    const label = document.createElement("span");
    label.textContent = `${nameOf(contributor)} · ${commits} commit${commits === 1 ? "" : "s"}`;
    button.append(swatch, label);
    let lit = false;
    const set = (value: boolean) => {
      lit = value;
      button.setAttribute("aria-pressed", String(value));
    };
    // A tap locks the highlight (aria-pressed); leaving or blurring then keeps it until the next tap.
    button.addEventListener("pointerenter", () => onHighlight(contributor));
    button.addEventListener("pointerleave", () => {
      if (!lit) onHighlight(undefined);
    });
    button.addEventListener("focus", () => onHighlight(contributor));
    button.addEventListener("blur", () => {
      if (!lit) onHighlight(undefined);
    });
    button.addEventListener("click", () => {
      set(!lit);
      onHighlight(lit ? contributor : undefined);
    });
    entries.push(button);
  };

  for (const c of people.top) entry(c, people.commits[c]!);
  if (people.more > 0) {
    const more = document.createElement("p");
    more.className = "legend-more";
    more.textContent = `+${people.more} more ${people.more === 1 ? "person" : "people"}`;
    entries.push(more);
  }
  if (automation !== undefined) entry(automation, people.automationCommits);
  root.replaceChildren(...entries);
  root.hidden = entries.length === 0;
}
