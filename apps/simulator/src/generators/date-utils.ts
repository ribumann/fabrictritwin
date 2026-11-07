import type { IsoDate, IsoDateTime } from "../models/index.js";

const DAY_IN_MS = 86_400_000;

/**
 * Parses a date-like value into a UTC Date.
 */
export function toUtcDate(value: Date | IsoDate | IsoDateTime): Date {
  if (value instanceof Date) {
    return new Date(value.getTime());
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return new Date(`${value}T00:00:00.000Z`);
  }

  return new Date(value);
}

/**
 * Formats a UTC date as YYYY-MM-DD.
 */
export function formatDate(value: Date): IsoDate {
  return value.toISOString().slice(0, 10);
}

/**
 * Formats a UTC date as an ISO-8601 timestamp.
 */
export function formatDateTime(value: Date): IsoDateTime {
  return value.toISOString();
}

/**
 * Adds whole UTC days to a date-like value.
 */
export function addDays(value: Date | IsoDate | IsoDateTime, days: number): Date {
  return new Date(toUtcDate(value).getTime() + days * DAY_IN_MS);
}

/**
 * Returns a sorted list of all inclusive dates in a range.
 */
export function enumerateDates(startDate: IsoDate, endDate: IsoDate): IsoDate[] {
  const dates: IsoDate[] = [];
  let current = toUtcDate(startDate);
  const end = toUtcDate(endDate).getTime();

  while (current.getTime() <= end) {
    dates.push(formatDate(current));
    current = addDays(current, 1);
  }

  return dates;
}

/**
 * Returns the number of inclusive whole days in the range.
 */
export function getInclusiveDayCount(startDate: IsoDate, endDate: IsoDate): number {
  return Math.floor((toUtcDate(endDate).getTime() - toUtcDate(startDate).getTime()) / DAY_IN_MS) + 1;
}

/**
 * Applies a UTC time-of-day to a date string.
 */
export function withUtcTime(date: IsoDate, hour: number, minute: number): IsoDateTime {
  const value = toUtcDate(date);
  value.setUTCHours(hour, minute, 0, 0);

  return formatDateTime(value);
}

/**
 * Extracts the date portion from an ISO timestamp.
 */
export function getDatePortion(timestamp: IsoDateTime): IsoDate {
  return timestamp.slice(0, 10);
}
