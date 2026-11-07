/**
 * Simulator package entry point. The package still exports the raw generators/services for direct
 * library use, but the containerized scheduled job now dispatches through here based on
 * `SIMULATOR_MODE`.
 */
import { pathToFileURL } from "node:url";
import { main as dailyGenerateMain } from "./cli/daily-generate-cli.js";

export * from "./generators/index.js";
export * from "./models/index.js";
export * from "./services/daily-generate.js";
export * from "./services/eventstream-client.js";
export * from "./services/gap-detection.js";
export * from "./services/seed-history.js";

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  if ((process.env.SIMULATOR_MODE ?? "").trim() === "daily-generation") {
    return dailyGenerateMain(argv);
  }

  console.log(
    "[simulator] generator library loaded; invoke a specific CLI or set SIMULATOR_MODE=daily-generation.",
  );
  return 0;
}

// Compare via pathToFileURL (not a raw `file://` template string) so this also
// matches on Windows, where process.argv[1] is a drive-letter path with
// backslashes rather than a URL-encoded POSIX path.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : "simulator entry point failed.";
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    },
  );
}
