import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, resolve, sep } from "node:path";

export const DEFAULT_PORT = 4173;
/** Tuning value: how many ports from DEFAULT_PORT up `serve` tries when no `--port` is given. */
export const DEFAULT_PORT_ATTEMPTS = 10;
/** Loopback only; browsers reach it as `localhost`. */
const LISTEN_ADDRESS = "127.0.0.1";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".bin": "application/octet-stream",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".mjs": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};

export interface Server {
  url: string;
  close(): Promise<void>;
}

/** Content-hashed files never change; the world file and page shell must always be fetched fresh. */
function cacheControl(relative: string): string {
  if (relative === "world.bin") return "no-store";
  if (/^(chunks|assets)\//.test(relative)) return "public, max-age=31536000, immutable";
  return "no-cache";
}

function listen(server: HttpServer, port: number): Promise<void> {
  return new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(port, LISTEN_ADDRESS, () => {
      server.off("error", fail);
      done();
    });
  });
}

export class ServeError extends Error {}

/**
 * Serves a built site on localhost. No live reload: rebuild and refresh.
 * When `port` is taken, tries the next ports, `portAttempts` in all (default: only `port`).
 */
export async function serve(options: { dir: string; port?: number; portAttempts?: number }): Promise<Server> {
  const root = resolve(options.dir);
  const server = createServer(async (req, res) => {
    const notFound = () => {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found\n");
    };
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { allow: "GET, HEAD" }).end();
      return;
    }
    let relative: string;
    try {
      relative = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname).replace(/^\/+/, "") || "index.html";
    } catch {
      return notFound();
    }
    // Reject anything that would resolve outside the site, before touching the disk.
    if (relative.split(/[\\/]/).some((part) => part === ".." || part === "")) return notFound();
    const file = join(root, relative);
    if (!file.startsWith(root + sep)) return notFound();
    const info = await stat(file).catch(() => undefined);
    if (!info?.isFile()) return notFound();

    res.writeHead(200, {
      "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
      "content-length": info.size,
      "cache-control": cacheControl(relative.split(sep).join("/")),
      "x-content-type-options": "nosniff",
    });
    if (req.method === "HEAD") res.end();
    else createReadStream(file).pipe(res);
  });

  const first = options.port ?? DEFAULT_PORT;
  const attempts = first === 0 ? 1 : Math.max(1, options.portAttempts ?? 1);
  for (let candidate = first; ; candidate++) {
    try {
      await listen(server, candidate);
      break;
    } catch (e) {
      if ((e as { code?: string }).code !== "EADDRINUSE") throw e;
      if (candidate - first + 1 >= attempts) {
        throw new ServeError(
          attempts === 1
            ? `port ${first} is in use; free it or choose another with --port`
            : `ports ${first} to ${candidate} are all in use; free one or choose another with --port`,
        );
      }
    }
  }
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://localhost:${port}/`,
    close: () => new Promise((done, fail) => server.close((e) => (e ? fail(e) : done()))),
  };
}

/** The command that opens a URL in the user's browser on this platform, as [command, args]. */
export function browserCommand(platform: NodeJS.Platform, url: string): [string, string[]] {
  if (platform === "darwin") return ["open", [url]];
  if (platform === "win32") return ["cmd", ["/c", "start", "", url]];
  return ["xdg-open", [url]];
}

/** Opens the URL in the browser. Best effort: a missing opener is not an error, the URL is printed anyway. */
export function openInBrowser(url: string): void {
  const [command, args] = browserCommand(process.platform, url);
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // The URL is already printed; nothing more to do.
  }
}
