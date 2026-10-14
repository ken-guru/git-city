import { finishGit, GitError, spawnGit } from "./git.js";

/** Bytes checked for a NUL to decide a blob is binary. */
export const BINARY_SNIFF_BYTES = 8000;
/** Bytes per line-equivalent for binary and opaque files. */
export const BYTES_PER_LINE_EQUIVALENT = 40;
/** Parallel `cat-file --batch` processes that count lines. */
export const CAT_FILE_PARALLELISM = 8;

const LFS_POINTER_PREFIX = "version https://git-lfs.github.com/spec/v1\n";
const LFS_SIZE_LINE = /^size (\d+)$/m;

/** What GitCity knows about one version of a file, derived from its blob. */
export interface FileFacts {
  kind: "text" | "binary" | "lfs" | "submodule";
  /** Bytes. For an LFS pointer, the size the pointer declares. */
  size: number;
  /** Newlines in a text file (plus one for a final line with no newline). 0 for binary, LFS and submodules. */
  lines: number;
  /** The line count the model sizes by: `lines` for text, bytes ÷ 40 for binary and LFS, 0 for submodules. */
  lineEquivalent: number;
}

/** A submodule entry points at a commit, not a blob, so it has no size. */
export const SUBMODULE_FACTS: FileFacts = { kind: "submodule", size: 0, lines: 0, lineEquivalent: 0 };

/** Facts for a blob git could not read (for example, missing in a partial clone). */
const MISSING_FACTS: FileFacts = { kind: "text", size: 0, lines: 0, lineEquivalent: 0 };

export interface ResolvedFacts {
  facts: Map<string, FileFacts>;
  /** Blobs git could not read. They are recorded with zero size and lines. */
  missing: number;
}

/**
 * Sizes and line counts for a set of blob IDs. Sizes come from `cat-file --batch-check`;
 * contents are streamed through `cat-file --batch` in parallel to count lines and sniff binaries.
 */
export async function resolveBlobFacts(repoDir: string, blobs: readonly string[]): Promise<ResolvedFacts> {
  const facts = new Map<string, FileFacts>();
  if (blobs.length === 0) return { facts, missing: 0 };

  const sizes = await readSizes(repoDir, blobs);
  const groupSize = Math.ceil(blobs.length / CAT_FILE_PARALLELISM);
  const groups: string[][] = [];
  for (let i = 0; i < blobs.length; i += groupSize) groups.push(blobs.slice(i, i + groupSize));

  const scanned = await Promise.all(groups.map((group) => scanContents(repoDir, group)));
  let missing = 0;
  scanned.forEach((results, g) => {
    results.forEach((scan, i) => {
      const blob = groups[g]![i]!;
      const size = sizes.get(blob);
      if (scan === undefined || size === undefined) {
        missing++;
        facts.set(blob, MISSING_FACTS);
      } else {
        facts.set(blob, factsFrom(size, scan));
      }
    });
  });
  return { facts, missing };
}

/** Sizes for many blobs from one `cat-file --batch-check` process. Missing blobs map to undefined. */
async function readSizes(repoDir: string, blobs: readonly string[]): Promise<Map<string, number | undefined>> {
  const sizes = new Map<string, number | undefined>();
  let carry = "";
  const decoder = new TextDecoder();
  for await (const chunk of catFile(repoDir, "--batch-check", blobs)) {
    const lines = (carry + decoder.decode(chunk, { stream: true })).split("\n");
    carry = lines.pop() ?? "";
    for (const line of lines) recordSize(sizes, line);
  }
  if (carry) recordSize(sizes, carry);
  return sizes;
}

/**
 * Feeds `blobs` to one `cat-file` process in `mode` and yields its stdout as it arrives.
 * Throws a GitError if git exits non-zero.
 */
async function* catFile(repoDir: string, mode: "--batch" | "--batch-check", blobs: readonly string[]): AsyncGenerator<Buffer> {
  const args = ["cat-file", mode];
  const child = spawnGit(repoDir, args, ["pipe", "pipe", "pipe"]);
  let stderr = "";
  child.stderr!.setEncoding("utf8").on("data", (d: string) => (stderr += d));
  child.stdin!.on("error", () => {});
  const finished = finishGit(child, args, () => stderr);
  finished.catch(() => {});
  child.stdin!.end(`${blobs.join("\n")}\n`);
  try {
    for await (const chunk of child.stdout!) yield chunk as Buffer;
  } finally {
    if (child.exitCode === null) child.kill();
  }
  await finished;
}

function recordSize(sizes: Map<string, number | undefined>, line: string): void {
  // "<sha> <type> <size>" or "<input> missing"
  const [sha, type, size] = line.split(" ");
  if (!sha) return;
  if (type === "blob" && size !== undefined) sizes.set(sha, Number(size));
  else sizes.set(sha, undefined);
}

/**
 * Reads the contents of `blobs` in order from one `cat-file --batch` process.
 * Returns one scan per blob, or undefined for a blob git reports missing.
 */
async function scanContents(repoDir: string, blobs: readonly string[]): Promise<(ContentScan | undefined)[]> {
  const scanner = new BatchScanner(blobs.length);
  for await (const chunk of catFile(repoDir, "--batch", blobs)) scanner.push(chunk);
  scanner.finish();
  return scanner.results;
}

export interface ContentScan {
  /** Bytes of the object's content. */
  bytes: number;
  /** Newline bytes in the content. */
  newlines: number;
  /** Whether the content ends in a newline (true for empty content). */
  endsWithNewline: boolean;
  /** The first BINARY_SNIFF_BYTES bytes, enough to sniff for binary and read an LFS pointer. */
  head: Buffer;
}

/**
 * Parses the output of `cat-file --batch` incrementally: "<sha> <type> <size>\n<content>\n"
 * per object, or "<input> missing\n". Content is never held whole; only its head is kept.
 */
export class BatchScanner {
  readonly results: (ContentScan | undefined)[] = [];
  private pending: Buffer = Buffer.alloc(0);
  private state: "header" | "body" | "terminator" = "header";
  private remaining = 0;
  private current: { bytes: number; newlines: number; lastByte: number; headParts: Buffer[]; headLength: number } | undefined;

  constructor(private readonly expected: number) {}

  push(chunk: Buffer): void {
    const buf = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    let pos = 0;
    for (;;) {
      if (this.state === "header") {
        const newline = buf.indexOf(10, pos);
        if (newline === -1) break;
        this.header(buf.toString("utf8", pos, newline));
        pos = newline + 1;
      } else if (this.state === "body") {
        const take = Math.min(this.remaining, buf.length - pos);
        if (take === 0) break;
        this.body(buf.subarray(pos, pos + take));
        pos += take;
        this.remaining -= take;
        if (this.remaining === 0) this.state = "terminator";
      } else {
        if (buf.length - pos < 1) break;
        pos += 1;
        this.state = "header";
        this.finishObject();
      }
    }
    this.pending = buf.subarray(pos);
  }

  finish(): void {
    if (this.results.length !== this.expected) {
      throw new GitError(["cat-file", "--batch"], null, `expected ${this.expected} objects, got ${this.results.length}`);
    }
  }

  private header(line: string): void {
    if (line.endsWith(" missing") || line.endsWith(" ambiguous")) {
      this.results.push(undefined);
      return;
    }
    const [, , size] = line.split(" ");
    this.remaining = Number(size);
    this.current = { bytes: this.remaining, newlines: 0, lastByte: 10, headParts: [], headLength: 0 };
    this.state = this.remaining === 0 ? "terminator" : "body";
  }

  private body(slice: Buffer): void {
    const cur = this.current!;
    const sniffRoom = BINARY_SNIFF_BYTES - cur.headLength;
    if (sniffRoom > 0) {
      const head = slice.subarray(0, Math.min(sniffRoom, slice.length));
      cur.headParts.push(Buffer.from(head));
      cur.headLength += head.length;
    }
    let newline = slice.indexOf(10);
    while (newline !== -1) {
      cur.newlines++;
      newline = slice.indexOf(10, newline + 1);
    }
    cur.lastByte = slice[slice.length - 1]!;
  }

  private finishObject(): void {
    const cur = this.current!;
    this.results.push({
      bytes: cur.bytes,
      newlines: cur.newlines,
      endsWithNewline: cur.bytes === 0 || cur.lastByte === 10,
      head: Buffer.concat(cur.headParts),
    });
    this.current = undefined;
  }
}

/** Classifies a blob from its size (batch-check) and its scanned content. */
export function factsFrom(size: number, scan: ContentScan): FileFacts {
  const pointer = lfsPointerSize(scan.head);
  if (pointer !== undefined) {
    return { kind: "lfs", size: pointer, lines: 0, lineEquivalent: Math.floor(pointer / BYTES_PER_LINE_EQUIVALENT) };
  }
  if (scan.head.includes(0)) {
    return { kind: "binary", size, lines: 0, lineEquivalent: Math.floor(size / BYTES_PER_LINE_EQUIVALENT) };
  }
  const lines = size === 0 ? 0 : scan.newlines + (scan.endsWithNewline ? 0 : 1);
  return { kind: "text", size, lines, lineEquivalent: lines };
}

/** The declared size of an LFS pointer, or undefined if the content is not one. */
export function lfsPointerSize(head: Buffer): number | undefined {
  if (!head.toString("utf8", 0, Math.min(head.length, LFS_POINTER_PREFIX.length)).startsWith(LFS_POINTER_PREFIX)) {
    return undefined;
  }
  const match = LFS_SIZE_LINE.exec(head.toString("utf8"));
  return match ? Number(match[1]) : undefined;
}
