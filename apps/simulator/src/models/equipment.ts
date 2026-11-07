/**
 * Supported equipment categories in the seeded model.
 */
export type EquipmentType = "bike" | "shoes" | "wetsuit" | "other";

/**
 * Optional athlete equipment tracked for future wear analyses.
 */
export interface Equipment {
  equipmentId: string;
  athleteId: string;
  type: EquipmentType;
  cumulativeDistanceKm: number;
}
