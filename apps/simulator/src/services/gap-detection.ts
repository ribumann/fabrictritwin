import type { IsoDate } from "../models/index.js";
import { addDays, enumerateDates, formatDate, toUtcDate } from "../generators/date-utils.js";

export interface DailyGenerationGapRecord {
  fromDate: IsoDate;
  toDate: IsoDate;
  missedDates: IsoDate[];
  gapDays: number;
  detectedOn: IsoDate;
}

export interface GapDetectionResult {
  status: "already-generated" | "on-schedule" | "gap-detected";
  lastGeneratedDate: IsoDate;
  targetDate: IsoDate;
  nextExpectedDate: IsoDate;
  missedDates: IsoDate[];
  shouldGenerateTargetDate: boolean;
}

/**
 * Determines whether a scheduled daily-generation run is on time, duplicated, or has skipped one
 * or more calendar days that must be surfaced instead of silently backfilled.
 */
export function detectDailyGenerationGap(args: {
  lastGeneratedDate: IsoDate;
  targetDate: IsoDate;
}): GapDetectionResult {
  const nextExpectedDate = formatDate(addDays(args.lastGeneratedDate, 1));
  const deltaDays = Math.floor(
    (toUtcDate(args.targetDate).getTime() - toUtcDate(args.lastGeneratedDate).getTime()) /
      86_400_000,
  );

  if (deltaDays <= 0) {
    return {
      status: "already-generated",
      lastGeneratedDate: args.lastGeneratedDate,
      targetDate: args.targetDate,
      nextExpectedDate,
      missedDates: [],
      shouldGenerateTargetDate: false,
    };
  }

  if (deltaDays === 1) {
    return {
      status: "on-schedule",
      lastGeneratedDate: args.lastGeneratedDate,
      targetDate: args.targetDate,
      nextExpectedDate,
      missedDates: [],
      shouldGenerateTargetDate: true,
    };
  }

  const gapEnd = formatDate(addDays(args.targetDate, -1));

  return {
    status: "gap-detected",
    lastGeneratedDate: args.lastGeneratedDate,
    targetDate: args.targetDate,
    nextExpectedDate,
    missedDates: enumerateDates(nextExpectedDate, gapEnd),
    shouldGenerateTargetDate: true,
  };
}

export function toGapRecord(
  result: GapDetectionResult,
  detectedOn: IsoDate,
): DailyGenerationGapRecord | null {
  if (result.status !== "gap-detected") {
    return null;
  }

  return {
    fromDate: result.missedDates[0]!,
    toDate: result.missedDates.at(-1)!,
    missedDates: [...result.missedDates],
    gapDays: result.missedDates.length,
    detectedOn,
  };
}

/**
 * Appends a newly-detected gap once; repeated reruns for the same missed-day window keep the state
 * stable instead of recording duplicate gap markers.
 */
export function mergeGapRecords(
  existing: readonly DailyGenerationGapRecord[],
  result: GapDetectionResult,
  detectedOn: IsoDate,
): DailyGenerationGapRecord[] {
  const record = toGapRecord(result, detectedOn);
  if (!record) {
    return [...existing];
  }

  const alreadyTracked = existing.some(
    (candidate) => candidate.fromDate === record.fromDate && candidate.toDate === record.toDate,
  );
  return alreadyTracked ? [...existing] : [...existing, record];
}
