import { pathToFileURL } from "node:url";
import { runDailyGenerationJob, type DailyGenerateJobOptions } from "../services/daily-generate.js";

interface ParsedDailyGenerateArgs extends DailyGenerateJobOptions {
  athleteId?: string;
  targetDate?: string;
}

function readOptionValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}.`);
  }

  return value;
}

export function parseDailyGenerateArgs(argv: string[]): DailyGenerateJobOptions {
  const parsed: ParsedDailyGenerateArgs = {};

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    switch (argument) {
      case "--athlete-id":
        parsed.athleteId = readOptionValue(argv, index, argument);
        index += 1;
        break;
      case "--target-date":
        parsed.targetDate = readOptionValue(argv, index, argument);
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

  return parsed;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const result = await runDailyGenerationJob(parseDailyGenerateArgs(argv));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : "daily-generation CLI failed.";
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    },
  );
}
