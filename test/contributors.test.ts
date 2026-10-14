import { describe, expect, it } from "vitest";
import { commitContent, contributorTable, isAutomation, type CommitSource } from "../src/cli/contributors.js";
import { parseConfig, type Config } from "../src/cli/config.js";
import type { CommitAuthor } from "../src/cli/history.js";
import { messageText, NO_STRING, nameFiles, type StringTable } from "../src/cli/naming.js";
import { loadTheme } from "../src/cli/theme.js";
import { NO_CONTENT } from "../src/shared/format.js";

const alice: CommitAuthor = { key: "alice@example.com", name: "Alice Ng", bot: false };
const bob: CommitAuthor = { key: "bob@example.com", name: "Bob Ito", bot: false };
const dependabot: CommitAuthor = { key: "49699333+dependabot[bot]@users.noreply.github.com", name: "dependabot[bot]", bot: true };
const renovate: CommitAuthor = { key: "renovate@whitesourcesoftware.com", name: "renovate", bot: true };

function config(text: string): Config {
  return parseConfig(text, "test.jsonc");
}

/** A small Timeline: alice, bob, a bot, alice again, and a commit with no author. */
function source(): CommitSource {
  return {
    authors: [alice, bob, dependabot, renovate],
    commitAuthor: Int32Array.from([0, 1, 2, 3, 0, -1]),
    subjects: ["first", "second, mail alice@example.com", "bump", "bump again", "tidy", "no author"],
  };
}

function baseTable(names: string[] = ["src/app.ts", "docs/readme.md"]): StringTable {
  return nameFiles(names, config("{}")).table;
}

describe("isAutomation", () => {
  it("counts bots by name or email, and people as people", () => {
    expect(isAutomation("dependabot[bot]", "x@example.com")).toBe(true);
    expect(isAutomation("github-actions[bot]", "41898282+github-actions[bot]@users.noreply.github.com")).toBe(true);
    expect(isAutomation("renovate", "renovate@whitesourcesoftware.com")).toBe(true);
    expect(isAutomation("Alice Ng", "alice@example.com")).toBe(false);
    expect(isAutomation("Robert Botman", "rb@example.com")).toBe(false);
  });
});

describe("contributorTable", () => {
  it("merges every bot into one Automation Contributor, in first-commit order", () => {
    const table = contributorTable([alice, bob, dependabot, renovate, { ...alice }]);
    expect(table.contributors.map((c) => c.automation)).toEqual([false, false, true]);
    expect(table.contributorOf).toEqual([0, 1, 2, 2, 0]);
    expect(table.contributors[0]!.name).toBe("Alice Ng");
  });
});

describe("commitContent", () => {
  it("produces nothing when contributors and messages are both off", () => {
    const base = baseTable();
    const content = commitContent(base, source(), config("{}"), { theme: loadTheme("modern"), seed: "s", hidden: [], taken: [] });
    expect(content.columns).toEqual({});
    expect(content.table).toBe(base);
    expect(content.revealed).toBe(0);
  });

  it("names anonymous Contributors by first-commit number, with Automation as its own", () => {
    const content = commitContent(baseTable(), source(), config('{"contributors":"anonymous"}'), {
      theme: loadTheme("modern"),
      seed: "s",
      hidden: [],
      taken: [],
    });
    const names = content.columns.contributors!;
    const text = (id: number) => content.table.strings[id];
    expect(Array.from(names.name, text)).toEqual(["Contributor 1", "Contributor 2", "Automation"]);
    expect([...names.automation]).toEqual([0, 0, 1]);
    // Per Step: alice, bob, the bot, the bot, alice, and none for the commit with no author.
    expect([...names.ofStep]).toEqual([0, 1, 2, 2, 0, NO_CONTENT]);
    expect(content.table.strings).not.toContain("Contributor 3");
  });

  it("gives generated Contributors unique person names from the Theme, with no hidden term", () => {
    const hidden = ["Mina"];
    const many: CommitAuthor[] = Array.from({ length: 30 }, (_, i) => ({ key: `p${i}@example.com`, name: `Person ${i}`, bot: false }));
    const cfg = config('{"contributors":"generated"}');
    const src: CommitSource = { authors: many, commitAuthor: Int32Array.from(many, (_, i) => i), subjects: many.map(() => "") };
    const content = commitContent(baseTable(), src, cfg, { theme: loadTheme("modern"), seed: "seed", hidden, taken: [] });
    const names = [...content.columns.contributors!.name].map((id) => content.table.strings[id]!);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(name.split(" ")).toHaveLength(2);
      expect(name.toLowerCase()).not.toContain("mina");
    }
    expect(content.revealed).toBe(0);
  });

  it("is deterministic for a seed", () => {
    const cfg = config('{"contributors":"generated"}');
    const run = () => commitContent(baseTable(), source(), cfg, { theme: loadTheme("medieval"), seed: "seed", hidden: [], taken: [] });
    const first = run().columns.contributors!.name;
    expect([...run().columns.contributors!.name]).toEqual([...first]);
  });

  it("shows Real names at the real level, counts them, and uses a Generated name under --private", () => {
    const cfg = config('{"contributors":"real"}');
    const shown = commitContent(baseTable(), source(), cfg, { theme: loadTheme("modern"), seed: "s", hidden: [], taken: [] });
    expect(Array.from(shown.columns.contributors!.name.slice(0, 2), (id) => shown.table.strings[id])).toEqual(["Alice Ng", "Bob Ito"]);
    expect(shown.revealed).toBe(2);

    const priv = commitContent(baseTable(), source(), cfg, { theme: loadTheme("modern"), seed: "s", hidden: [], taken: [], private: true });
    expect(Array.from(priv.columns.contributors!.name.slice(0, 2), (id) => priv.table.strings[id])).not.toContain("Alice Ng");
    expect(priv.revealed).toBe(0);
  });

  it("falls back to a Generated name when a Real name holds a hidden term", () => {
    const cfg = config('{"contributors":"real"}');
    const content = commitContent(baseTable(), source(), cfg, { theme: loadTheme("modern"), seed: "s", hidden: ["ito"], taken: [] });
    const bob = content.table.strings[content.columns.contributors!.name[1]!];
    expect(bob).not.toBe("Bob Ito");
    expect(content.revealed).toBe(1);
  });

  it("applies a contributor pseudonym rule by name or by email, and a Concept pseudonym to Real names", () => {
    const cfg = config(`{
      "contributors": "real",
      "rules": [
        { "contributor": "Bob Ito", "action": "pseudonym", "as": "Bee" },
        { "contributor": "alice@example.com", "action": "pseudonym", "as": "Ace" },
        { "concept": "Ng", "action": "pseudonym", "as": "Nug" }
      ]
    }`);
    const content = commitContent(baseTable(), source(), cfg, { theme: loadTheme("modern"), seed: "s", hidden: [], taken: [] });
    const names = Array.from(content.columns.contributors!.name, (id) => content.table.strings[id]);
    expect(names[0]).toBe("Ace");
    expect(names[1]).toBe("Bee");
    const concept = commitContent(baseTable(), source(), config('{"contributors":"real","rules":[{"concept":"Alice","action":"pseudonym","as":"Ann"}]}'), {
      theme: loadTheme("modern"),
      seed: "s",
      hidden: [],
      taken: [],
    });
    expect(concept.table.strings[concept.columns.contributors!.name[0]!]).toBe("Ann Ng");
  });

  it("names messages through the naming step: emails removed, Concepts replaced, duplicates shared", () => {
    const cfg = config('{"commitMessages":true,"rules":[{"concept":"Acme","action":"pseudonym","as":"Acorn"}]}');
    const src: CommitSource = {
      authors: [alice],
      commitAuthor: Int32Array.from([0, 0, 0, 0]),
      subjects: ["fix the Acme parser", "mail alice@example.com about it", "fix the Acme parser", "   "],
    };
    const content = commitContent(baseTable(), src, cfg, { theme: loadTheme("modern"), seed: "s", hidden: [], taken: [] });
    const messages = content.columns.messages!;
    expect(content.columns.contributors).toBeUndefined();
    expect(messages[0]).toBe(messages[2]);
    expect(content.table.strings[messages[0]!]).toBe("fix the Acorn parser");
    expect(content.table.strings[messages[1]!]).toBe("mail about it");
    expect(messages[3]).toBe(NO_STRING);
    for (const text of content.table.strings) expect(text).not.toContain("@");
  });

  it("drops a message that holds a hidden term, and never writes an email", () => {
    expect(messageText("ship secret-project now", [], ["secret-project"])).toBeUndefined();
    expect(messageText("reach me at a.b@c.io", [], [])).toBe("reach me at");
    expect(messageText("a.b@c.io", [], [])).toBeUndefined();
    expect(messageText("x".repeat(300), [], [])).toHaveLength(160);
  });
});
