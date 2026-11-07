-- T060c: this DDL is executed by infra/fabric/notebooks/notebook-content.py's schema-DDL cell
-- (a hand-kept copy -- keep both files in sync), not run directly anywhere else. Run
-- scripts/simulate/load-history-to-tables.ps1 after seeding to apply it and load data.
CREATE SCHEMA IF NOT EXISTS dbo;

CREATE TABLE IF NOT EXISTS dbo.Athlete (
  athleteId STRING NOT NULL,
  displayName STRING NOT NULL,
  functionalThresholdPower INT NOT NULL,
  thresholdPace STRUCT<swim:DOUBLE,bike:DOUBLE,run:DOUBLE> NOT NULL,
  restingHeartRate INT NOT NULL,
  thresholdHeartRate INT NOT NULL,
  dateOfBirth DATE,
  createdAt TIMESTAMP NOT NULL
) USING DELTA;

CREATE TABLE IF NOT EXISTS dbo.TrainingBlock (
  trainingBlockId STRING NOT NULL,
  athleteId STRING NOT NULL,
  startDate DATE NOT NULL,
  endDate DATE NOT NULL,
  goalRaceId STRING
) USING DELTA;

CREATE TABLE IF NOT EXISTS dbo.TrainingBlockPhase (
  trainingBlockPhaseId STRING NOT NULL,
  trainingBlockId STRING NOT NULL,
  phase STRING NOT NULL,
  startDate DATE NOT NULL,
  endDate DATE NOT NULL
) USING DELTA;

-- NOTE (T060 fix): AthleteDateKey below is a physical column, not a computed one, because
-- Direct Lake semantic model tables cannot use DAX calculated columns (Fabric Direct Lake
-- rejects "Standard expression context" calculated columns at import time). It must be
-- populated by the ETL/seeding step as `athleteId || '|' || date_format(<date column>, 'yyyy-MM-dd')`
-- to exactly match the key format produced by the TrainingCalendar semantic-model M query
-- (infra/fabric/powerbi-semantic-model/definition/tables/TrainingCalendar.tmdl), which is what
-- these tables are related to via TrainingSession_TrainingCalendar / RecoveryMetrics_TrainingCalendar
-- / etc. in relationships.tmdl.
CREATE TABLE IF NOT EXISTS dbo.TrainingSession (
  sessionId STRING NOT NULL,
  athleteId STRING NOT NULL,
  trainingBlockId STRING NOT NULL,
  discipline STRING NOT NULL,
  plannedDate TIMESTAMP NOT NULL,
  plannedDurationMinutes INT NOT NULL,
  targetZone STRING NOT NULL,
  status STRING NOT NULL,
  rpe INT,
  source STRING NOT NULL,
  AthleteDateKey STRING NOT NULL
) USING DELTA;

CREATE TABLE IF NOT EXISTS dbo.RecoveryMetrics (
  athleteId STRING NOT NULL,
  date DATE NOT NULL,
  hrv DOUBLE NOT NULL,
  restingHeartRate INT NOT NULL,
  sleepScore DOUBLE NOT NULL,
  bodyWeightKg DOUBLE NOT NULL,
  sorenessScore DOUBLE NOT NULL,
  source STRING NOT NULL,
  AthleteDateKey STRING NOT NULL
) USING DELTA;

CREATE TABLE IF NOT EXISTS dbo.NutritionLog (
  athleteId STRING NOT NULL,
  date TIMESTAMP NOT NULL,
  mealType STRING NOT NULL,
  calories DOUBLE NOT NULL,
  carbsGrams DOUBLE NOT NULL,
  proteinGrams DOUBLE NOT NULL,
  fatGrams DOUBLE NOT NULL,
  hydrationMl DOUBLE NOT NULL,
  source STRING NOT NULL,
  AthleteDateKey STRING NOT NULL
) USING DELTA;

CREATE TABLE IF NOT EXISTS dbo.SleepSession (
  athleteId STRING NOT NULL,
  date DATE NOT NULL,
  totalSleepMinutes INT NOT NULL,
  deepSleepMinutes INT NOT NULL,
  remSleepMinutes INT NOT NULL,
  sleepScore DOUBLE NOT NULL,
  source STRING NOT NULL,
  AthleteDateKey STRING NOT NULL
) USING DELTA;

CREATE TABLE IF NOT EXISTS dbo.Race (
  raceId STRING NOT NULL,
  athleteId STRING NOT NULL,
  name STRING NOT NULL,
  date DATE NOT NULL,
  distance STRING NOT NULL,
  goalTimeSeconds INT NOT NULL,
  status STRING NOT NULL,
  predictedFinishTimeSeconds INT,
  actualFinishTimeSeconds INT,
  pacingEvennessStdDev DOUBLE,
  AthleteDateKey STRING NOT NULL
) USING DELTA;

CREATE TABLE IF NOT EXISTS dbo.Equipment (
  equipmentId STRING NOT NULL,
  athleteId STRING NOT NULL,
  type STRING NOT NULL,
  cumulativeDistanceKm DOUBLE NOT NULL
) USING DELTA;
