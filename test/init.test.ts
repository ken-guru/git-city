import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig } from "../src/cli/config.js";
import { initConfig, InitError } from "../src/cli/init.js";
import { FixtureRepo } from "./fixture.js";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((f) => f()));

function fixture(): FixtureRepo {
  const repo = new FixtureRepo();
  cleanups.push(() => repo.remove());
  return repo;
}

describe("initConfig", () => {
  it("writes a personal starter config under the git directory by default", async () => {
    const repo = fixture()
      .write("src/app.ts", 'import express from "express";\nimport { x } from "./local";\n')
      .write("lib/util.ts", 'import { z } from "@scope/pkg/sub";\n')
      .commit("first");

    const written = await initConfig(repo.dir, { shared: false });

    expect(written).toBe(join(repo.dir, ".git", "git-city", "config.jsonc"));
    const text = readFileSync(written, "utf8");
    expect(text).toMatch(/^\s*\/\//m); // commented
    expect(text).toContain("Modules (top-level folders): lib, src");
    expect(text).toContain("External Dependencies: @scope/pkg, express");
    expect(text).toContain("Themes: medieval, modern");
    expect(() => parseConfig(text, written)).not.toThrow();
    expect(existsSync(join(repo.dir, "git-city.config.jsonc"))).toBe(false);
  });

  it("writes the shared config at the repo root with --shared", async () => {
    const repo = fixture().write("a.txt").commit("first");

    const written = await initConfig(repo.dir, { shared: true });

    expect(written).toBe(join(repo.dir, "git-city.config.jsonc"));
    expect(() => parseConfig(readFileSync(written, "utf8"), written)).not.toThrow();
  });

  it("refuses to overwrite an existing config", async () => {
    const repo = fixture().write("a.txt").commit("first");
    const written = await initConfig(repo.dir, { shared: true });

    await expect(initConfig(repo.dir, { shared: true })).rejects.toBeInstanceOf(InitError);
    rmSync(written);
  });
});
