import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const DAY = 86_400;

/** A throwaway git repo for tests, isolated from the user's git config. */
export class FixtureRepo {
  readonly dir = mkdtempSync(join(tmpdir(), "git-city-fixture-"));
  private clock = Date.UTC(2024, 0, 1) / 1000;

  constructor() {
    this.git("init", "-q", "-b", "main");
  }

  git(...args: string[]): string {
    return execFileSync("git", ["-C", this.dir, ...args], {
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.com",
        GIT_AUTHOR_DATE: `@${this.clock} +0000`,
        GIT_COMMITTER_DATE: `@${this.clock} +0000`,
      },
    }).toString();
  }

  write(path: string, content = `${path}\n`): this {
    const full = join(this.dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
    return this;
  }

  /** Commits everything staged or changed, `days` after the previous commit. */
  commit(message: string, days = 1): this {
    this.clock += days * DAY;
    this.git("add", "-A");
    this.git("commit", "-q", "--allow-empty", "-m", message);
    return this;
  }

  remove(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

/** Day number (days since 1970-01-01 UTC) of a UTC date, for expected values. */
export function dayOf(year: number, month: number, day: number): number {
  return Date.UTC(year, month - 1, day) / 1000 / DAY;
}
