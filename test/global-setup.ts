import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * The build-before-test convention, in one place. Every test run builds the CLI and the page once, before any
 * test file starts, so tests that exercise the shipped CLI (dist/cli, dist/page, dist/grammars) see fresh output.
 * CI's test job therefore runs `npm test` alone; it does not build a second time.
 */
export default function setup(): void {
  execSync("npm run build --silent", { cwd: fileURLToPath(new URL("..", import.meta.url)), stdio: "pipe" });
}
