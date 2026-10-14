import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, resolve, sep } from "node:path";

export const DEFAULT_PORT = 4173;
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

/** Serves a built site on localhost. No live reload: rebuild and refresh. */
export async function serve(options: { dir: string; port?: number }): Promise<Server> {
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

  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? DEFAULT_PORT, LISTEN_ADDRESS, () => resolveListen());
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://localhost:${port}/`,
    close: () => new Promise((done, fail) => server.close((e) => (e ? fail(e) : done()))),
  };
}
