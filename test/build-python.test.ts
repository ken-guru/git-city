import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { build } from "../src/cli/build.js";
import { decodeWorld } from "../src/shared/format.js";
import { FixtureRepo } from "./fixture.js";

/**
 * Seam under test: `build` on a Python fixture repo, observed through the Roads and width steps in the world file.
 * Expected values are counted by hand from the fixture's sources below.
 */

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((f) => f()));

async function buildWorld(repo: FixtureRepo) {
  const root = mkdtempSync(join(tmpdir(), "git-city-python-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const pageDir = join(root, "page");
  mkdirSync(pageDir);
  writeFileSync(join(pageDir, "index.html"), "<!doctype html>stub page");
  const outDir = join(root, "git-city-site");
  await build({ repoDir: repo.dir, outDir, pageDir });
  return decodeWorld(readFileSync(join(outDir, "world.bin")));
}

describe("Python repos in the build", () => {
  it("draws a Road between the two Modules their imports connect, with lanes for the imports", async () => {
    const repo = new FixtureRepo();
    cleanups.push(() => repo.remove());
    repo
      .write("core/pyproject.toml", "[project]\nname = 'core'\n")
      .write("core/models.py", "class User: ...\n")
      .write("core/util.py", "def helper(): ...\n")
      .write("app/pyproject.toml", "[project]\nname = 'app'\n")
      .write("app/__init__.py", "")
      .write("app/main.py", "import os\nfrom core import models\nfrom core.util import helper\nfrom . import views\n")
      .write("app/cli.py", "from core import models\n")
      .write("app/views.py", "import requests\nfrom core import models\n")
      .commit("first");

    const world = await buildWorld(repo);

    // Four file-to-file imports cross from app to core, and none go the other way. os and requests are not Roads.
    expect(world.roads.a).toHaveLength(1);
    expect(world.roads.track[0]).toBe(0);
    expect([world.roads.forward[0], world.roads.backward[0]].sort()).toEqual([1, 2]);
  });

  it("widens the file most often imported, with a width step at its third importer", async () => {
    const repo = new FixtureRepo();
    cleanups.push(() => repo.remove());
    repo
      .write("core/pyproject.toml", "[project]\nname = 'core'\n")
      .write("core/models.py", "class User: ...\n")
      .write("app/pyproject.toml", "[project]\nname = 'app'\n")
      .write("app/a.py", "from core import models\n")
      .write("app/b.py", "import core.models\n")
      .write("app/c.py", "from core import models\n")
      .commit("first");

    const world = await buildWorld(repo);

    // core/models.py has three importers, which is fan-in 3: the first width step. The other files have none.
    expect(world.widthStep.indexOf(1)).toBeGreaterThanOrEqual(0);
    expect([...world.widthStep].filter((step) => step !== 0)).toEqual([1]);
  });
});
