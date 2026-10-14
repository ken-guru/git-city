import type { World } from "../shared/format.js";
import { NO_CONTENT } from "../shared/format.js";
import type { Config } from "./config.js";
import type { CommitAuthor } from "./history.js";
import { type ContributionOptions, type NearMiss, nameContributions, type StringTable } from "./naming.js";

/** Commit authors whose name or email matches these are bots: release, dependency and CI automation (SPEC §8). */
const BOT_NAME = /\[bot\]$|^(dependabot|renovate|github-actions|greenkeeper|snyk|mergify|semantic-release|release-please|pre-commit-ci|codecov|imgbot|allcontributors|sonarcloud|circleci|travis-ci|azure-pipelines|jenkins)([ _.-]|$)/i;
const BOT_EMAIL = /(^|[.+@-])(dependabot|renovate|github-actions|semantic-release-bot|release-please|pre-commit-ci)(\[bot\])?@|\[bot\]@/i;

/** True when an author is a bot. Every bot is grouped as the one Automation Contributor. */
export function isAutomation(name: string, email: string): boolean {
  return BOT_NAME.test(name.trim()) || BOT_EMAIL.test(email.trim());
}

/** One Contributor as the naming step sees it. `name` is the mailmapped name; `key` is what rules can target. */
export interface ContributorInput {
  /** A stable key for the person (the lower-cased email, or the name when there is none). Never written to the output. */
  key: string;
  name: string;
  /** Whether this Contributor is Automation: every bot together. */
  automation: boolean;
}

/**
 * The Contributors of a Timeline, from its distinct commit authors (in first-commit order). Every bot merges into
 * one Automation Contributor, which takes the place of the first bot seen.
 */
export interface ContributorTable {
  contributors: ContributorInput[];
  /** Per author (by the author's index in the list given): the index of its Contributor. */
  contributorOf: number[];
}

/** What a Timeline's commits carry for this module: each Step's author index and subject, and the authors. */
export interface CommitSource {
  authors: readonly CommitAuthor[];
  /** Per Step: the index of its author in `authors`, or -1. */
  commitAuthor: Int32Array;
  /** Per Step: its subject line, or "". */
  subjects: readonly string[];
}

/** The world-file columns for Contributors and messages (empty when the options are off). */
export type CommitColumns = Pick<World, "contributors" | "messages">;

export interface CommitContent {
  /** The strings table: the file names, then the Contributors' and messages' strings. */
  table: StringTable;
  columns: CommitColumns;
  /** Contributors whose Real names are shown. */
  revealed: number;
  /** Revealed Real names close to a hidden term; see ContributionNaming.nearMisses. */
  nearMisses: NearMiss[];
}

/**
 * The Contributors and commit messages of a Timeline, named through the naming step (SPEC §8, §11). Nothing is
 * produced when both settings are off, so the output then holds none of this data.
 */
export function commitContent(
  table: StringTable,
  source: CommitSource,
  config: Config,
  options: Omit<ContributionOptions, "level" | "subjects">,
): CommitContent {
  const level = config.contributors ?? "off";
  const wantNames = level !== "off";
  const wantMessages = config.commitMessages === true;
  if (!wantNames && !wantMessages) return { table, columns: {}, revealed: 0, nearMisses: [] };

  const { contributors, contributorOf } = wantNames ? contributorTable(source.authors) : { contributors: [], contributorOf: [] };
  const named = nameContributions(table, contributors, config, {
    ...options,
    level,
    subjects: wantMessages ? source.subjects : undefined,
  });
  const columns: CommitColumns = {};
  if (wantNames) {
    columns.contributors = {
      name: named.contributorName,
      automation: Uint8Array.from(contributors, (c) => (c.automation ? 1 : 0)),
      ofStep: Uint32Array.from(source.commitAuthor, (author) => (author < 0 ? NO_CONTENT : contributorOf[author]!)),
    };
  }
  if (named.message !== undefined) columns.messages = named.message;
  return { table: named.table, columns, revealed: named.revealed, nearMisses: named.nearMisses };
}

export function contributorTable(authors: readonly CommitAuthor[]): ContributorTable {
  const contributors: ContributorInput[] = [];
  let automation = -1;
  const byKey = new Map<string, number>();
  const contributorOf = authors.map((author) => {
    if (author.bot) {
      if (automation < 0) {
        automation = contributors.length;
        contributors.push({ key: "automation", name: "", automation: true });
      }
      return automation;
    }
    const known = byKey.get(author.key);
    if (known !== undefined) return known;
    byKey.set(author.key, contributors.length);
    contributors.push({ key: author.key, name: author.name, automation: false });
    return contributors.length - 1;
  });
  return { contributors, contributorOf };
}
