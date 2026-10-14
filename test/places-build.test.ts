import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { build } from "../src/cli/build.js";
import { loadTheme } from "../src/cli/theme.js";
import { parsePlaces, sourceName } from "../src/shared/places.js";
import { FixtureRepo } from "./fixture.js";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((f) => f()));

function fixture(): FixtureRepo {
  const repo = new FixtureRepo();
  cleanups.push(() => repo.remove());
  return repo;
}

/** Builds the repo and returns the parsed places.json, plus the raw text. */
async function placesOf(repo: FixtureRepo, options: { theme?: string; seed?: string; configText?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "git-city-places-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const pageDir = join(root, "page");
  mkdirSync(pageDir);
  writeFileSync(join(pageDir, "index.html"), "<!doctype html>stub page");
  const outDir = join(root, "site");
  let configPath: string | undefined;
  if (options.configText !== undefined) {
    configPath = join(root, "git-city.config.jsonc");
    writeFileSync(configPath, options.configText);
  }
  await build({ repoDir: repo.dir, outDir, pageDir, theme: options.theme, seed: options.seed, configPath });
  const text = readFileSync(join(outDir, "places.json"), "utf8");
  return { places: parsePlaces(text), text };
}

describe("places.json from a build", () => {
  it("names each District, its Neighbourhoods and the City, with the Theme's Role noun", async () => {
    const repo = fixture().write("auth/login.ts").write("docs/readme.md").commit("first");
    const { places } = await placesOf(repo);
    expect(places.districts).toHaveLength(2);
    expect(places.districts.some((d) => d.generated.endsWith(loadTheme("modern").roleNouns.auth))).toBe(true);
    expect(places.districts.some((d) => d.generated.endsWith(loadTheme("modern").roleNouns.docs))).toBe(true);
    for (const d of places.districts) {
      expect(sourceName(d.source)).toBe("generated");
      expect(d.neighbourhoods.length).toBeGreaterThan(0);
    }
    expect(sourceName(places.city.source)).toBe("generated");
    expect(places.city.name).not.toContain(" ");
  });

  it("selects the Theme with --theme, and the config's theme when no flag is given", async () => {
    const repo = fixture().write("auth/login.ts").commit("first");
    const medieval = loadTheme("medieval").roleNouns.auth;
    const flag = await placesOf(repo, { theme: "medieval" });
    expect(flag.places.districts[0]!.generated.endsWith(medieval)).toBe(true);

    const configured = await placesOf(repo, { configText: `{ "theme": "medieval" }` });
    expect(configured.places.districts[0]!.generated.endsWith(medieval)).toBe(true);

    const overridden = await placesOf(repo, { theme: "modern", configText: `{ "theme": "medieval" }` });
    expect(overridden.places.districts[0]!.generated.endsWith(loadTheme("modern").roleNouns.auth)).toBe(true);
  });

  it("colours each District from its Role's hue in the Theme's palette", async () => {
    const repo = fixture().write("auth/login.ts").commit("first");
    const { places } = await placesOf(repo, { theme: "medieval" });
    expect(places.districts[0]!.colour.hue).toBe(loadTheme("medieval").palette.auth.hue);
  });

  it("gives the same names for the same repo and seed, and different names for another seed", async () => {
    const repo = fixture().write("auth/login.ts").write("api/routes.ts").commit("first");
    const first = await placesOf(repo, { seed: "fixed" });
    const again = await placesOf(repo, { seed: "fixed" });
    const other = await placesOf(repo, { seed: "another" });
    expect(again.text).toBe(first.text);
    expect(other.text).not.toBe(first.text);
  });

  it("never writes a hidden folder name into places.json", async () => {
    const repo = fixture().write("secretsauce/widget.ts").write("src/a.ts").commit("first");
    const { text } = await placesOf(repo);
    expect(text.toLowerCase()).not.toContain("secretsauce");
  });

  it("builds when a folder is named after a field of the output, such as name or source", async () => {
    const repo = fixture().write("name/a.ts").write("source/b.ts").write("generated/c.ts").commit("first");
    const { places } = await placesOf(repo);
    expect(places.districts).toHaveLength(3);
  });
});
