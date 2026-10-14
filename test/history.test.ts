import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { build } from "../src/cli/build.js";
import { type CommitRecord, readHistory, resolveTimelineHead } from "../src/cli/history.js";
import { FixtureRepo } from "./fixture.js";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((f) => f()));

function fixture(): FixtureRepo {
  const repo = new FixtureRepo();
  cleanups.push(() => repo.remove());
  return repo;
}

async function history(repoDir: string): Promise<CommitRecord[]> {
  const { head } = await resolveTimelineHead(repoDir);
  const commits: CommitRecord[] = [];
  for await (const commit of readHistory(repoDir, head)) commits.push(commit);
  return commits;
}

/** Path → lines for every file version written in a commit, sorted by path. */
function linesWritten(commit: CommitRecord): [string, number][] {
  return commit.writes.map((w): [string, number] => [w.path, w.facts.lineEquivalent]).sort();
}

describe("file facts", () => {
  it("counts lines and bytes of text, including a final line without a newline", async () => {
    const repo = fixture()
      .write("two.txt", "one\ntwo\n")
      .write("unterminated.txt", "one\ntwo")
      .write("empty.txt", "")
      .commit("first");

    const [commit] = await history(repo.dir);

    const byPath = Object.fromEntries(commit!.writes.map((w) => [w.path, w.facts]));
    expect(byPath["two.txt"]).toEqual({ kind: "text", size: 8, lines: 2, lineEquivalent: 2 });
    expect(byPath["unterminated.txt"]).toEqual({ kind: "text", size: 7, lines: 2, lineEquivalent: 2 });
    expect(byPath["empty.txt"]).toEqual({ kind: "text", size: 0, lines: 0, lineEquivalent: 0 });
  });

  it("gives a file with a NUL in its first 8000 bytes 0 lines and bytes / 40 line-equivalents", async () => {
    const content = Buffer.alloc(1000, "a");
    content[10] = 0;
    content[500] = 10;
    const late = Buffer.alloc(9000, "b");
    late[8500] = 0;
    late[8001] = 10;
    const repo = fixture();
    writeBuffer(repo, "blob.bin", content);
    writeBuffer(repo, "late-nul.txt", late);
    repo.commit("first");

    const [commit] = await history(repo.dir);

    const byPath = Object.fromEntries(commit!.writes.map((w) => [w.path, w.facts]));
    expect(byPath["blob.bin"]).toEqual({ kind: "binary", size: 1000, lines: 0, lineEquivalent: 25 });
    // The NUL lies beyond the 8000 sniffed bytes, so the file counts as text.
    expect(byPath["late-nul.txt"]).toMatchObject({ kind: "text", size: 9000, lines: 2 });
  });

  it("gives a submodule no size, and reads it from its mode without a blob", async () => {
    const repo = fixture().write("a.txt").commit("first");
    repo.git("update-index", "--add", "--cacheinfo", `160000,${"1".repeat(40)},vendor/lib`);
    // `git add -A` would drop a gitlink whose directory is absent, so commit the index as it is.
    repo.git("commit", "-q", "-m", "add submodule");

    const commits = await history(repo.dir);

    expect(commits[1]!.writes).toEqual([
      expect.objectContaining({ path: "vendor/lib", facts: { kind: "submodule", size: 0, lines: 0, lineEquivalent: 0 } }),
    ]);
  });

  it("parses an LFS pointer for the size it declares", async () => {
    const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${"a".repeat(64)}\nsize 123456\n`;
    const repo = fixture().write("model.bin", pointer).commit("first");

    const [commit] = await history(repo.dir);

    expect(commit!.writes[0]!.facts).toEqual({ kind: "lfs", size: 123456, lines: 0, lineEquivalent: 3086 });
  });

  it("reports the same facts for the same blob in two places", async () => {
    const repo = fixture().write("a.txt", "x\ny\n").write("b.txt", "x\ny\n").commit("first");

    const [commit] = await history(repo.dir);

    expect(commit!.writes.map((w) => w.blob)).toEqual([commit!.writes[0]!.blob, commit!.writes[0]!.blob]);
    expect(commit!.writes.map((w) => w.facts)).toEqual([commit!.writes[0]!.facts, commit!.writes[0]!.facts]);
  });
});

describe("renames", () => {
  it("detects a rename at git's default similarity, and records only the new path's facts", async () => {
    const body = "line\n".repeat(20);
    const repo = fixture().write("old.txt", body).commit("first");
    repo.git("mv", "old.txt", "new.txt");
    repo.write("new.txt", body + "extra\n").commit("renamed and edited");

    const [, renamed] = await history(repo.dir);

    expect(renamed!.deleted).toEqual(["old.txt"]);
    expect(renamed!.added).toEqual(["new.txt"]);
    expect(renamed!.renamed).toEqual([{ from: "old.txt", to: "new.txt" }]);
    expect(renamed!.writes).toEqual([expect.objectContaining({ path: "new.txt" })]);
    expect(renamed!.writes[0]!.facts.lines).toBe(21);
  });

  it("turns a move below the similarity threshold into a delete plus an add", async () => {
    const repo = fixture().write("old.txt", "alpha\n".repeat(20)).commit("first");
    repo.git("rm", "-q", "old.txt");
    repo.write("new.txt", "completely\n".repeat(20)).commit("replaced");

    const [, replaced] = await history(repo.dir);

    expect(replaced!.deleted).toEqual(["old.txt"]);
    expect(replaced!.added).toEqual(["new.txt"]);
  });

  it("turns moves past diff.renameLimit into a delete plus an add", async () => {
    const count = 1005;
    const repo = fixture();
    for (let i = 0; i < count; i++) repo.write(`src/file${i}.txt`, `unique ${i}\n${"filler\n".repeat(30)}`);
    repo.commit("many files");
    for (let i = 0; i < count; i++) {
      rmSync(join(repo.dir, `src/file${i}.txt`));
      repo.write(`lib/file${i}.txt`, `unique ${i}\n${"filler\n".repeat(30)}changed\n`);
    }
    repo.commit("moved and edited");

    const [, moved] = await history(repo.dir);

    expect(moved!.added).toHaveLength(count);
    expect(moved!.deleted).toHaveLength(count);
  });

  it("ignores the user's diff.renameLimit and diff.renames", async () => {
    const body = "same\n".repeat(20);
    const repo = fixture().write("old.txt", body).commit("first");
    repo.git("config", "diff.renameLimit", "1");
    repo.git("config", "diff.renames", "false");
    repo.git("mv", "old.txt", "new.txt");
    repo.commit("moved");

    const [, moved] = await history(repo.dir);

    expect(moved!.deleted).toEqual(["old.txt"]);
    expect(moved!.added).toEqual(["new.txt"]);
    expect(moved!.writes).toEqual([expect.objectContaining({ path: "new.txt" })]);
  });
});

describe("streaming", () => {
  it("yields every commit in order across batch boundaries", async () => {
    const dir = mkdtempSync(join(tmpdir(), "git-city-stream-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const count = 2600;
    const stream: string[] = [];
    for (let i = 1; i <= count; i++) {
      const data = `file ${i}\n`;
      stream.push(`blob\nmark :${i}\ndata ${data.length}\n${data}\n`);
      stream.push(`commit refs/heads/main\nmark :${count + i}\ncommitter T <t@example.com> ${1_700_000_000 + i * 86_400} +0000\ndata 2\nc\n`);
      stream.push(`M 100644 :${i} f${i}.txt\n\n`);
    }
    execFileSync("git", ["init", "-q", "-b", "main", dir]);
    execFileSync("git", ["-C", dir, "fast-import", "--quiet"], { input: stream.join("") });

    const commits = await history(dir);

    expect(commits).toHaveLength(count);
    expect(commits[0]!.added).toEqual(["f1.txt"]);
    expect(commits[count - 1]!.added).toEqual([`f${count}.txt`]);
  });
});

describe("build summary", () => {
  it("warns that a shallow clone holds only part of the history", async () => {
    const source = fixture().write("a.txt").commit("first");
    source.write("b.txt").commit("second");
    const clone = mkdtempSync(join(tmpdir(), "git-city-shallow-"));
    cleanups.push(() => rmSync(clone, { recursive: true, force: true }));
    execFileSync("git", ["clone", "-q", "--depth", "1", `file://${source.dir}`, join(clone, "repo")]);
    const pageDir = join(clone, "page");
    mkdirSync(pageDir);
    writeFileSync(join(pageDir, "index.html"), "<!doctype html>");

    const summary = await build({ repoDir: join(clone, "repo"), outDir: join(clone, "site"), pageDir });

    expect(summary.warnings).toEqual([expect.stringMatching(/shallow/)]);
  });
});

function writeBuffer(repo: FixtureRepo, path: string, content: Buffer): void {
  const full = join(repo.dir, path);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}
