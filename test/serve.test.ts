import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serve, type Server } from "../src/cli/serve.js";

let site: string;
let server: Server;

beforeAll(async () => {
  const root = mkdtempSync(join(tmpdir(), "git-city-serve-"));
  site = join(root, "git-city-site");
  mkdirSync(join(site, "chunks"), { recursive: true });
  mkdirSync(join(site, "assets"));
  writeFileSync(join(site, "index.html"), "<!doctype html>");
  writeFileSync(join(site, "world.bin"), Uint8Array.of(1, 2, 3));
  writeFileSync(join(site, "strings.json"), "[]");
  writeFileSync(join(site, "chunks", "0000.abcdef0123456789.bin"), Uint8Array.of(4));
  writeFileSync(join(site, "assets", "page.ABC123.js"), "export {}");
  writeFileSync(join(root, "secret.txt"), "outside the site");
  server = await serve({ dir: site, port: 0 });
});

afterAll(async () => {
  await server.close();
  rmSync(join(site, ".."), { recursive: true, force: true });
});

/** A raw GET, so paths like `/../x` reach the server unnormalised. */
function get(path: string): Promise<{ status: number; type?: string; cache?: string; body: string }> {
  return new Promise((resolve, reject) => {
    request(`${server.url}`, { path }, (res) => {
      let body = "";
      res.setEncoding("utf8").on("data", (d: string) => (body += d));
      res.on("end", () =>
        resolve({ status: res.statusCode!, type: res.headers["content-type"], cache: res.headers["cache-control"], body }),
      );
    })
      .on("error", reject)
      .end();
  });
}

describe("git-city serve", () => {
  it("listens on localhost only", () => {
    expect(server.url).toMatch(/^http:\/\/localhost:\d+\/$/);
  });

  it("serves the page shell at the root, with the right content types", async () => {
    expect(await get("/")).toMatchObject({ status: 200, type: "text/html; charset=utf-8", body: "<!doctype html>" });
    expect(await get("/assets/page.ABC123.js")).toMatchObject({ status: 200, type: "text/javascript; charset=utf-8" });
    expect(await get("/strings.json")).toMatchObject({ status: 200, type: "application/json; charset=utf-8" });
    expect(await get("/chunks/0000.abcdef0123456789.bin")).toMatchObject({ status: 200, type: "application/octet-stream" });
  });

  it("never lets the world file be cached, and lets hashed files be cached forever", async () => {
    expect((await get("/world.bin")).cache).toBe("no-store");
    expect((await get("/chunks/0000.abcdef0123456789.bin")).cache).toBe("public, max-age=31536000, immutable");
    expect((await get("/assets/page.ABC123.js")).cache).toBe("public, max-age=31536000, immutable");
    expect((await get("/index.html")).cache).toBe("no-cache");
  });

  it("answers 404 for missing files and anything outside the site", async () => {
    expect((await get("/nope.bin")).status).toBe(404);
    expect((await get("/chunks")).status).toBe(404);
    expect(await get("/../secret.txt")).toMatchObject({ status: 404 });
    expect(await get("/%2e%2e/secret.txt")).toMatchObject({ status: 404 });
  });
});
