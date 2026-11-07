/**
 * Shared date/time aliases used by the simulator domain model.
 */
export type IsoDate = string;

/**
 * Shared timestamp alias used by the simulator domain model.
 */
export type IsoDateTime = string;

/**
 * Provenance for seeded and daily-generated historical records.
 */
export type HistoricalSource = "seeded" | "daily-generated";

/**
 * Provenance for training-session records, including live sessions.
 */
export type TrainingSessionSource = HistoricalSource | "live";

/**
 * Provenance for nutrition records, which may later include live fueling events.
 */
export type NutritionLogSource = HistoricalSource | "live";
