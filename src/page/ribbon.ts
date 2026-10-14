import { SECONDS_PER_DAY } from "../shared/format.js";
import { type Bin, binSteps, type RibbonData, tooltipFor } from "./ribbon-data.js";
import { type Action, COMMIT_SPEEDS, keyAction, type Mode, Player, REAL_SPEEDS } from "./timescale.js";

/** Resolution of the native range input that scrubs the ribbon. */
const SCRUB_RESOLUTION = 10000;
/** Height of the bars in CSS pixels, and the strip under them for year labels. */
const TRACK_HEIGHT = 56;
const YEAR_STRIP = 14;

const MODE_LABELS: Record<Mode, string> = { real: "Real time", commit: "Per commit" };

interface RibbonElements {
  play: HTMLButtonElement;
  back: HTMLButtonElement;
  latest: HTMLButtonElement;
  date: HTMLElement;
  count: HTMLElement;
  caption: HTMLElement;
  status: HTMLElement;
  modeReal: HTMLButtonElement;
  modeCommit: HTMLButtonElement;
  speeds: HTMLElement;
  track: HTMLElement;
  canvas: HTMLCanvasElement;
  scrubber: HTMLInputElement;
  tooltip: HTMLElement;
}

function requireElements(): RibbonElements {
  const byId = <T extends HTMLElement>(id: string) => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`ribbon element #${id} is missing`);
    return el as T;
  };
  return {
    play: byId("play"),
    back: byId("back"),
    latest: byId("latest"),
    date: byId("date"),
    count: byId("count"),
    caption: byId("caption"),
    status: byId("status"),
    modeReal: byId("mode-real"),
    modeCommit: byId("mode-commit"),
    speeds: byId("speeds"),
    track: byId("track"),
    canvas: byId("ribbon"),
    scrubber: byId("scrubber"),
    tooltip: byId("tooltip"),
  };
}

/**
 * The story ribbon: transport, date and caption, mode and speed, the activity track, the scrubber and the tooltip.
 * It reads the Player each frame and draws from the RibbonData, which grows as chunks load.
 */
export class Ribbon {
  private readonly els = requireElements();
  private dataVersion = 0;
  private drawnVersion = -1;
  private drawnMode: Mode | undefined;
  private drawnWidth = -1;
  private columns: { col: number; bin: Bin }[] = [];
  private binAt = new Map<number, Bin>();
  private keys = new Float64Array(0);
  private maxFiles = 1;
  private shownSpeed = -1;
  private shownMode: Mode | undefined;

  constructor(
    private readonly data: RibbonData,
    private readonly player: Player,
    private readonly loaded: () => number,
  ) {
    const { play, back, latest, modeReal, modeCommit, scrubber, track, tooltip } = this.els;
    play.addEventListener("click", () => this.player.toggle());
    back.addEventListener("click", () => this.toggleReverse());
    latest.addEventListener("click", () => this.jump(this.player.endTime));
    modeReal.addEventListener("click", () => this.player.setMode("real"));
    modeCommit.addEventListener("click", () => this.player.setMode("commit"));
    scrubber.addEventListener("input", () => {
      this.player.pause();
      this.player.seek(this.player.scale.unclock(this.player.mode, (Number(scrubber.value) / SCRUB_RESOLUTION) * this.end()));
    });
    track.addEventListener("pointermove", (e) => this.showTooltip(e));
    track.addEventListener("pointerleave", () => this.hideTooltip());
    track.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "touch") this.showTooltip(e);
    });
    track.addEventListener("pointerup", (e) => {
      if (e.pointerType === "touch") this.hideTooltip();
    });
    track.addEventListener("pointercancel", () => this.hideTooltip());
    addEventListener("keydown", (e) => {
      // A focused button already turns Space into a click; the keyboard action must not run on top of it.
      if (e.target instanceof HTMLButtonElement && e.key === " ") return;
      const action = keyAction(e.key, e.shiftKey);
      if (!action) return;
      e.preventDefault();
      this.act(action);
    });
    addEventListener("resize", () => this.markDirty());
  }

  /** Call when the data has grown (a chunk has loaded). */
  markDirty(): void {
    this.dataVersion++;
  }

  /** Redraws the ribbon for the current playhead. Called once per frame. */
  update(): void {
    const { player } = this;
    const { play, back, date, count, caption, status, scrubber, modeReal, modeCommit } = this.els;
    const loaded = this.loaded();
    const buffer = player.buffer(loaded);
    const commit = Math.min(player.scale.steps - 1, Math.max(0, Math.floor(buffer.displayed)));
    const dayOf = this.data.commitDays[commit] ?? 0;

    play.textContent = player.playing && !player.reverse ? "Pause" : "Play";
    back.textContent = player.playing && player.reverse ? "Pause" : "Play backwards";
    date.textContent = dayText(dayOf);
    const number = this.data.commitsThrough(commit);
    count.textContent = `commit ${number} of ${this.data.totalCommits}`;
    const identity = this.data.latestIdentity(commit);
    caption.textContent = identity?.text ?? "";
    status.textContent = buffer.waiting ? "Loading this part of history…" : "";

    scrubber.value = String(Math.round((player.scale.clock(player.mode, buffer.displayed) / this.end()) * SCRUB_RESOLUTION));
    scrubber.setAttribute("aria-valuetext", `${dayText(dayOf)}, commit ${number} of ${this.data.totalCommits}${buffer.waiting ? ", loading" : ""}`);
    modeReal.setAttribute("aria-pressed", String(player.mode === "real"));
    modeCommit.setAttribute("aria-pressed", String(player.mode === "commit"));
    if (this.shownMode !== player.mode || this.shownSpeed !== player.speedIndexValue()) this.showSpeeds();

    this.draw(loaded, buffer.displayed, buffer.waiting ? buffer.target : undefined);
  }

  private act(action: Action): void {
    const { player } = this;
    switch (action.type) {
      case "toggle":
        player.toggle();
        break;
      case "step":
        player.pause();
        player.seek(Math.round(player.t) + action.by);
        break;
      case "start":
        player.pause();
        player.seek(0);
        break;
      case "latest":
        this.jump(player.endTime);
        break;
      case "reverse":
        this.toggleReverse();
        break;
    }
  }

  private jump(t: number): void {
    this.player.pause();
    this.player.seek(t);
  }

  private toggleReverse(): void {
    if (this.player.playing && this.player.reverse) this.player.pause();
    else this.player.play(true);
  }

  private end(): number {
    return this.player.scale.end(this.player.mode);
  }

  private showSpeeds(): void {
    const { player } = this;
    this.shownMode = player.mode;
    this.shownSpeed = player.speedIndexValue();
    const labels = player.mode === "real" ? REAL_SPEEDS.map((s) => s.label) : COMMIT_SPEEDS.map((n) => `${n} commits/s`);
    this.els.speeds.replaceChildren(
      ...labels.map((label, index) => {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = label;
        button.setAttribute("aria-pressed", String(index === player.speedIndexValue()));
        button.addEventListener("click", () => {
          player.setSpeed(index);
          this.showSpeeds();
        });
        return button;
      }),
    );
    this.els.modeReal.textContent = MODE_LABELS.real;
    this.els.modeCommit.textContent = MODE_LABELS.commit;
  }

  /** Bins the Steps into one column per CSS pixel, for the current clock, width and data. */
  private ensureBins(mode: Mode, width: number): void {
    if (this.drawnMode === mode && this.drawnWidth === width && this.drawnVersion === this.dataVersion) return;
    const scale = this.player.scale;
    const total = scale.end(mode);
    const keys = new Float64Array(scale.steps);
    for (let step = 0; step < keys.length; step++) keys[step] = scale.clock(mode, step);
    const bins = binSteps(keys, total, width, (step) => this.data.activityAt(step));
    this.columns = bins.map((bin) => ({ col: Math.min(width - 1, Math.floor((keys[bin.first]! / total) * width)), bin }));
    this.binAt = new Map(this.columns.map(({ col, bin }) => [col, bin]));
    this.keys = keys;
    this.maxFiles = Math.max(1, ...bins.map((bin) => bin.files));
    this.drawnMode = mode;
    this.drawnWidth = width;
    this.drawnVersion = this.dataVersion;
  }

  private draw(loaded: number, displayed: number, target: number | undefined): void {
    const { canvas, track } = this.els;
    const { player, data } = this;
    const width = Math.max(1, Math.floor(track.clientWidth));
    const dpr = devicePixelRatio || 1;
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(TRACK_HEIGHT * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(TRACK_HEIGHT * dpr);
      canvas.style.height = `${TRACK_HEIGHT}px`;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, TRACK_HEIGHT);
    this.ensureBins(player.mode, width);
    const styles = getComputedStyle(track);
    const ink = styles.getPropertyValue("--fg").trim() || "#1d2630";
    const total = this.end();
    const x = (step: number) => (total > 0 ? (player.scale.clock(player.mode, step) / total) * width : 0);
    const barTop = 0;
    const base = TRACK_HEIGHT - YEAR_STRIP;
    const barMax = base - barTop - 4;

    // The loaded history is a darker buffer; the rest of the track is the lighter, unloaded part.
    ctx.fillStyle = styles.getPropertyValue("--ribbon-unloaded").trim() || "rgba(127,127,127,0.12)";
    ctx.fillRect(0, 0, width, TRACK_HEIGHT);
    const loadedEnd = loaded >= player.scale.steps - 1 ? width : loaded < 0 ? 0 : x(loaded + 1);
    ctx.fillStyle = styles.getPropertyValue("--ribbon-loaded").trim() || "rgba(127,127,127,0.3)";
    ctx.fillRect(0, 0, loadedEnd, TRACK_HEIGHT);

    // Activity: square-root height, stacked in District colours.
    for (const { col, bin } of this.columns) {
      if (bin.files === 0) continue;
      const height = barMax * Math.sqrt(bin.files / this.maxFiles);
      let top = base;
      for (const [district, count] of [...bin.districts].sort((a, b) => a[0] - b[0])) {
        const segment = (height * count) / bin.files;
        top -= segment;
        ctx.fillStyle = data.colour(district);
        ctx.fillRect(col, top, 1, segment);
      }
    }

    // Year ticks, village founding diamonds, and split or merge ticks.
    ctx.fillStyle = ink;
    ctx.strokeStyle = ink;
    ctx.font = "10px system-ui, sans-serif";
    for (const tick of data.yearTicks) {
      const tx = Math.round(x(tick.step)) + 0.5;
      ctx.globalAlpha = 0.5;
      ctx.beginPath();
      ctx.moveTo(tx, base);
      ctx.lineTo(tx, TRACK_HEIGHT);
      ctx.stroke();
      ctx.globalAlpha = 0.8;
      ctx.fillText(String(tick.year), tx + 2, TRACK_HEIGHT - 2);
    }
    ctx.globalAlpha = 1;
    for (const founding of data.founded) {
      const fx = x(founding.step);
      ctx.beginPath();
      ctx.moveTo(fx, 3);
      ctx.lineTo(fx + 3, 6);
      ctx.lineTo(fx, 9);
      ctx.lineTo(fx - 3, 6);
      ctx.closePath();
      ctx.fill();
    }
    for (const tick of data.ticks) {
      ctx.fillStyle = data.colour(tick.district);
      ctx.fillRect(Math.round(x(tick.step)), 0, 2, 12);
    }

    // The target the scrubber asked for, dashed, while the City waits for its chunk.
    if (target !== undefined) {
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = ink;
      ctx.beginPath();
      ctx.moveTo(Math.round(x(target)) + 0.5, 0);
      ctx.lineTo(Math.round(x(target)) + 0.5, TRACK_HEIGHT);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // The playhead.
    ctx.fillStyle = ink;
    ctx.fillRect(Math.round(x(displayed)) - 1, 0, 2, TRACK_HEIGHT);
  }

  private showTooltip(event: PointerEvent): void {
    const rect = this.els.canvas.getBoundingClientRect();
    const col = Math.floor(event.clientX - rect.left);
    const bin = this.binAt.get(col);
    const { tooltip } = this.els;
    if (!bin || event.clientX < rect.left || event.clientX > rect.right) return this.hideTooltip();
    const text = tooltipFor(this.data, bin);
    const lines: Node[] = [];
    const line = (value: string, extra?: Node) => {
      const p = document.createElement("div");
      p.textContent = value;
      if (extra) p.prepend(extra);
      lines.push(p);
    };
    const strong = document.createElement("strong");
    strong.textContent = text.dates;
    lines.push(strong);
    line(`${text.commits} · ${text.files}`);
    for (const district of text.districts) {
      const swatch = document.createElement("span");
      swatch.className = "swatch";
      swatch.style.background = district.colour;
      line(`${district.name}: ${district.count}`, swatch);
    }
    for (const event of text.identity) line(event);
    tooltip.replaceChildren(...lines);
    tooltip.hidden = false;
    tooltip.style.left = `${Math.min(rect.width - 8, Math.max(8, col))}px`;
  }

  private hideTooltip(): void {
    this.els.tooltip.hidden = true;
  }
}

function dayText(day: number): string {
  return new Date(day * SECONDS_PER_DAY * 1000).toISOString().slice(0, 10);
}
