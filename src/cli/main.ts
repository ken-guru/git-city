#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { build } from "./build.js";
import { HistoryError } from "./history.js";
import { DEFAULT_PORT, serve } from "./serve.js";
import { OutputError } from "./write.js";

const DEFAULT_OUT = "git-city-site";

const HELP = `Usage: git-city [build] [options]
       git-city serve [dir] [--port <n>]

Turns this repository's git history into an animated 3D City.

Commands:
  build          build the site (the default)
  serve [dir]    serve a built site on localhost (default dir: ${DEFAULT_OUT})

Options:
  -C <path>        run as if started in <path>
  --branch <name>  read this branch instead of the default branch
  --out <dir>      output folder (default: ${DEFAULT_OUT})
  --port <n>       port for serve (default: ${DEFAULT_PORT})
  -h, --help       show this help
  -v, --version    show the version
`;

function version(): string {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
  return pkg.version;
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      directory: { type: "string", short: "C" },
      branch: { type: "string" },
      out: { type: "string" },
      port: { type: "string" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (values.version) {
    process.stdout.write(`${version()}\n`);
    return 0;
  }

  const cwd = resolve(values.directory ?? ".");
  const [command = "build", ...rest] = positionals;

  if (command === "build" && rest.length === 0) {
    const summary = await build({ repoDir: cwd, outDir: resolve(cwd, values.out ?? DEFAULT_OUT), branch: values.branch });
    process.stdout.write(
      `Built ${summary.commits} commits and ${summary.files} files from ${summary.branch} into ${summary.outDir}\n` +
        `Run "git-city serve" to watch it.\n`,
    );
    return 0;
  }

  if (command === "serve" && rest.length <= 1) {
    const port = values.port === undefined ? DEFAULT_PORT : Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new UsageError(`invalid port: ${values.port}`);
    const server = await serve({ dir: resolve(cwd, rest[0] ?? values.out ?? DEFAULT_OUT), port });
    process.stdout.write(`Serving at ${server.url} (Ctrl+C to stop)\n`);
    await new Promise<void>((done) => process.once("SIGINT", done).once("SIGTERM", done));
    await server.close();
    return 0;
  }

  throw new UsageError(`unknown command: ${positionals.join(" ")}`);
}

class UsageError extends Error {}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => {
    const usage = e instanceof UsageError || (e as { code?: string }).code?.startsWith("ERR_PARSE_ARGS") === true;
    const expected = usage || e instanceof HistoryError || e instanceof OutputError;
    process.stderr.write(`git-city: ${expected ? (e as Error).message : ((e as Error).stack ?? String(e))}\n`);
    if (usage) process.stderr.write(`Try "git-city --help".\n`);
    process.exit(1);
  },
);
