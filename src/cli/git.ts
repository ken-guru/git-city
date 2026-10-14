import { spawn, type ChildProcess } from "node:child_process";

/** git's default for diff.renameLimit, pinned so a user's config cannot change which moves are renames. */
export const RENAME_LIMIT = 1000;

/**
 * Settings that pin git's output format regardless of the user's config.
 * GitCity only reads the object database: it never checks out or fetches.
 */
const PINNED_CONFIG = [
  "-c", "log.showRoot=true",
  "-c", "log.showSignature=false",
  "-c", "color.ui=never",
  "-c", "core.quotePath=false",
  "-c", `diff.renameLimit=${RENAME_LIMIT}`,
];

const GIT_ENV = { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };

export class GitError extends Error {
  constructor(args: readonly string[], readonly code: number | null, readonly stderr: string) {
    super(`git ${args[0] ?? ""} failed${code === null ? "" : ` (exit ${code})`}: ${stderr.trim() || "no output"}`);
  }
}

/** Starts git in `repoDir` with the pinned format and environment; the caller owns stdio. */
export function spawnGit(repoDir: string, args: readonly string[], stdio: ["pipe" | "ignore", "pipe", "pipe"]): ChildProcess {
  return spawn("git", ["-C", repoDir, ...PINNED_CONFIG, ...args], { env: GIT_ENV, stdio });
}

/** Waits for a spawned git to finish, throwing a GitError on a non-zero exit. */
export function finishGit(child: ChildProcess, args: readonly string[], stderr: () => string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new GitError(args, code, stderr()))));
  });
}

/** Runs git in `repoDir` and yields its stdout as it arrives. */
export async function* gitStream(repoDir: string, args: readonly string[]): AsyncGenerator<Buffer> {
  const child = spawnGit(repoDir, args, ["ignore", "pipe", "pipe"]);
  let stderr = "";
  child.stderr!.setEncoding("utf8").on("data", (d: string) => (stderr += d));
  const finished = finishGit(child, args, () => stderr);
  finished.catch(() => {});
  try {
    for await (const chunk of child.stdout!) yield chunk as Buffer;
  } finally {
    if (child.exitCode === null) child.kill();
  }
  await finished;
}

/** Runs git in `repoDir` and returns its trimmed stdout. */
export async function git(repoDir: string, args: readonly string[]): Promise<string> {
  const parts: Buffer[] = [];
  for await (const part of gitStream(repoDir, args)) parts.push(part);
  return Buffer.concat(parts).toString("utf8").trim();
}

/** Like `git`, but returns undefined instead of throwing when git exits non-zero. */
export async function gitMaybe(repoDir: string, args: readonly string[]): Promise<string | undefined> {
  try {
    return await git(repoDir, args);
  } catch (e) {
    if (e instanceof GitError) return undefined;
    throw e;
  }
}
