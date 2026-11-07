import { pathToFileURL } from "node:url";
import { seedHistory, type SeedHistoryOptions } from "../services/seed-history.js";

type ParsedSeedHistoryArgs = Omit<SeedHistoryOptions, "athleteId"> & {
  athleteId?: string;
};

function readOptionValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}.`);
  }

  return value;
}

export function parseSeedHistoryArgs(argv: string[]): SeedHistoryOptions {
  const parsed: ParsedSeedHistoryArgs = {};

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    switch (argument) {
      case "--athlete-id":
        parsed.athleteId = readOptionValue(argv, index, argument);
        index += 1;
        break;
      case "--goal-race-id":
        parsed.goalRaceId = readOptionValue(argv, index, argument);
        index += 1;
        break;
      case "--reference-date":
        parsed.referenceDate = readOptionValue(argv, index, argument);
        index += 1;
        break;
      case "--environment":
        parsed.environment = readOptionValue(argv, index, argument);
        index += 1;
        break;
      case "--seed":
        parsed.seed = Number(readOptionValue(argv, index, argument));
        if (!Number.isFinite(parsed.seed)) {
          throw new Error("`--seed` must be a finite number.");
        }
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (!parsed.athleteId) {
    throw new Error("`--athlete-id` is required.");
  }

  return parsed as SeedHistoryOptions;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const options = parseSeedHistoryArgs(argv);
  const result = await seedHistory(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : "seed-history CLI failed.";
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    },
  );
}
