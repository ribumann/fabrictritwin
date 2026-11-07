# Fabric notebook source
# METADATA ********************
# META {
# META   "kernel_info": {
# META     "name": "synapse_pyspark"
# META   },
# META   "dependencies": {
# META     "lakehouse": {
# META       "default_lakehouse": "{{LAKEHOUSE_ITEM_ID}}",
# META       "default_lakehouse_name": "{{LAKEHOUSE_DISPLAY_NAME}}",
# META       "default_lakehouse_workspace_id": "{{WORKSPACE_ID}}"
# META     }
# META   }
# META }

# CELL ********************

workspace_id = "{{WORKSPACE_ID}}"
workspace_name = "{{WORKSPACE_NAME}}"
lakehouse_id = "{{LAKEHOUSE_ITEM_ID}}"
lakehouse_name = "{{LAKEHOUSE_DISPLAY_NAME}}"
athlete_id = ""
environment = "dev"

# METADATA ********************
# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark",
# META   "tags": [
# META     "parameters"
# META   ]
# META }

# CELL ********************

from pyspark.sql import functions as F
from delta.tables import DeltaTable

# Fully-qualified 3-part schema name (workspace.lakehouse.schema) -- see the parameters cell's note
# on why this notebook never relies on a default-lakehouse Spark session context. Backtick-quoted
# because both workspace and lakehouse display names may contain hyphens, which are not valid in an
# unquoted Spark SQL identifier.
schema_fqn = f"`{workspace_name}`.`{lakehouse_name}`.dbo"

history_root = (
    f"abfss://{workspace_id}@onelake.dfs.fabric.microsoft.com/{lakehouse_id}"
    f"/Files/history-seeding/{environment}"
)

try:
    entries = notebookutils.fs.ls(history_root)
except Exception as ex:
    raise RuntimeError(
        f"Could not list seeded history folders under {history_root}. Has the simulator seeded "
        f"any athlete history yet for environment '{environment}'? Underlying error: {ex}"
    )

discovered_athlete_ids = sorted(entry.name for entry in entries if entry.isDir)

if athlete_id:
    # Optional single-athlete filter for interactive/manual runs.
    if athlete_id not in discovered_athlete_ids:
        raise ValueError(
            f"athlete_id '{athlete_id}' was requested but no seeded folder for it was found under "
            f"{history_root}. Discovered athlete folders: {discovered_athlete_ids}"
        )
    athlete_ids = [athlete_id]
else:
    athlete_ids = discovered_athlete_ids

if not athlete_ids:
    raise RuntimeError(f"No seeded athlete folders found under {history_root}. Nothing to load.")

print(f"Discovered {len(athlete_ids)} seeded athlete folder(s) under {history_root}: {athlete_ids}")

# METADATA ********************
# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# CELL ********************

# Idempotent schema/table DDL. This MUST stay in sync with
# infra/fabric/lakehouse/create-lakehouse-tables.sql (that file is the authoritative schema
# reference for the Lakehouse; this cell is its executable form, run from inside Fabric's
# Spark-capable notebook surface since T036's provisioning script cannot execute Spark SQL
# directly over a plain REST call). AthleteDateKey columns are physical (not DAX-calculated) per
# the T060 Direct Lake fix -- see the comment in create-lakehouse-tables.sql for why.
spark.sql(f"CREATE SCHEMA IF NOT EXISTS {schema_fqn}")

spark.sql(f"""
CREATE TABLE IF NOT EXISTS {schema_fqn}.Athlete (
  athleteId STRING NOT NULL,
  displayName STRING NOT NULL,
  functionalThresholdPower INT NOT NULL,
  thresholdPace STRUCT<swim:DOUBLE,bike:DOUBLE,run:DOUBLE> NOT NULL,
  restingHeartRate INT NOT NULL,
  thresholdHeartRate INT NOT NULL,
  dateOfBirth DATE,
  createdAt TIMESTAMP NOT NULL
) USING DELTA
""")

spark.sql(f"""
CREATE TABLE IF NOT EXISTS {schema_fqn}.TrainingBlock (
  trainingBlockId STRING NOT NULL,
  athleteId STRING NOT NULL,
  startDate DATE NOT NULL,
  endDate DATE NOT NULL,
  goalRaceId STRING
) USING DELTA
""")

spark.sql(f"""
CREATE TABLE IF NOT EXISTS {schema_fqn}.TrainingBlockPhase (
  trainingBlockPhaseId STRING NOT NULL,
  trainingBlockId STRING NOT NULL,
  phase STRING NOT NULL,
  startDate DATE NOT NULL,
  endDate DATE NOT NULL
) USING DELTA
""")

spark.sql(f"""
CREATE TABLE IF NOT EXISTS {schema_fqn}.TrainingSession (
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
) USING DELTA
""")

spark.sql(f"""
CREATE TABLE IF NOT EXISTS {schema_fqn}.RecoveryMetrics (
  athleteId STRING NOT NULL,
  date DATE NOT NULL,
  hrv DOUBLE NOT NULL,
  restingHeartRate INT NOT NULL,
  sleepScore DOUBLE NOT NULL,
  bodyWeightKg DOUBLE NOT NULL,
  sorenessScore DOUBLE NOT NULL,
  source STRING NOT NULL,
  AthleteDateKey STRING NOT NULL
) USING DELTA
""")

spark.sql(f"""
CREATE TABLE IF NOT EXISTS {schema_fqn}.NutritionLog (
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
) USING DELTA
""")

spark.sql(f"""
CREATE TABLE IF NOT EXISTS {schema_fqn}.SleepSession (
  athleteId STRING NOT NULL,
  date DATE NOT NULL,
  totalSleepMinutes INT NOT NULL,
  deepSleepMinutes INT NOT NULL,
  remSleepMinutes INT NOT NULL,
  sleepScore DOUBLE NOT NULL,
  source STRING NOT NULL,
  AthleteDateKey STRING NOT NULL
) USING DELTA
""")

spark.sql(f"""
CREATE TABLE IF NOT EXISTS {schema_fqn}.Race (
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
) USING DELTA
""")

spark.sql(f"""
CREATE TABLE IF NOT EXISTS {schema_fqn}.Equipment (
  equipmentId STRING NOT NULL,
  athleteId STRING NOT NULL,
  type STRING NOT NULL,
  cumulativeDistanceKm DOUBLE NOT NULL
) USING DELTA
""")

print("Schema/table DDL applied (idempotent).")

# METADATA ********************
# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# CELL ********************

# Helper functions: read one entity's seeded JSONL file from Files/, and idempotently MERGE it
# into its Delta table in Tables/ (upsert on the entity's natural/business key so re-running this
# notebook for the same athlete never duplicates rows).
def read_jsonl(files_root, entity_name):
    path = f"{files_root}/{entity_name}.jsonl"
    return spark.read.json(path)


def merge_into(df, table_name, merge_keys):
    target = f"{schema_fqn}.{table_name}"
    row_count = df.count()
    if row_count == 0:
        print(f"  {table_name}: 0 rows in source file, nothing to merge.")
        return 0

    delta_table = DeltaTable.forName(spark, target)
    merge_condition = " AND ".join(f"t.{key} = s.{key}" for key in merge_keys)
    (
        delta_table.alias("t")
        .merge(df.alias("s"), merge_condition)
        .whenMatchedUpdateAll()
        .whenNotMatchedInsertAll()
        .execute()
    )
    print(f"  {table_name}: merged {row_count} row(s) on {merge_keys}.")
    return row_count

# METADATA ********************
# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# CELL ********************

# Table-driven load: one entry per seeded JSONL file (apps/simulator/src/services/seed-history.ts
# `writeLakehouseFiles`). `date_key_source` names the column AthleteDateKey is derived from, for
# the 5 tables the T060 Direct Lake fix added a physical AthleteDateKey column to; the derivation
# formula (athleteId || '|' || date_format(<col>, 'yyyy-MM-dd')) MUST exactly match the
# TrainingCalendar semantic-model M query so the Direct Lake relationships resolve.
ENTITIES = [
    {"name": "Athlete", "keys": ["athleteId"], "casts": {"dateOfBirth": "date", "createdAt": "timestamp"}, "date_key_source": None},
    {"name": "TrainingBlock", "keys": ["trainingBlockId"], "casts": {"startDate": "date", "endDate": "date"}, "date_key_source": None},
    {"name": "TrainingBlockPhase", "keys": ["trainingBlockPhaseId"], "casts": {"startDate": "date", "endDate": "date"}, "date_key_source": None},
    {"name": "Equipment", "keys": ["equipmentId"], "casts": {}, "date_key_source": None},
    {"name": "TrainingSession", "keys": ["sessionId"], "casts": {"plannedDate": "timestamp"}, "date_key_source": "plannedDate"},
    {"name": "RecoveryMetrics", "keys": ["AthleteDateKey"], "casts": {"date": "date"}, "date_key_source": "date"},
    {"name": "NutritionLog", "keys": ["athleteId", "date", "mealType"], "casts": {"date": "timestamp"}, "date_key_source": "date"},
    {"name": "SleepSession", "keys": ["AthleteDateKey"], "casts": {"date": "date"}, "date_key_source": "date"},
    {"name": "Race", "keys": ["raceId"], "casts": {"date": "date"}, "date_key_source": "date"},
]

total_rows = 0
for current_athlete_id in athlete_ids:
    files_root = f"{history_root}/{current_athlete_id}"
    print(f"--- Loading seeded history for athlete '{current_athlete_id}' from: {files_root} ---")

    for entity in ENTITIES:
        print(f"Loading {entity['name']}...")
        df = read_jsonl(files_root, entity["name"])

        # `dateOfBirth` is a genuinely optional TS field (`dateOfBirth?:`) that may be entirely
        # absent from the single Athlete row's JSON -- guard against `spark.read.json` then omitting
        # the column altogether, which would otherwise fail the merge's whenNotMatchedInsertAll().
        if entity["name"] == "Athlete" and "dateOfBirth" not in df.columns:
            df = df.withColumn("dateOfBirth", F.lit(None).cast("date"))

        for column, target_type in entity["casts"].items():
            df = df.withColumn(column, F.col(column).cast(target_type))

        if entity["name"] == "Athlete":
            # Pin the struct's field order/types to exactly match dbo.Athlete's
            # STRUCT<swim:DOUBLE,bike:DOUBLE,run:DOUBLE> regardless of the source JSON's key order.
            df = df.withColumn(
                "thresholdPace",
                F.struct(
                    F.col("thresholdPace.swim").cast("double").alias("swim"),
                    F.col("thresholdPace.bike").cast("double").alias("bike"),
                    F.col("thresholdPace.run").cast("double").alias("run"),
                ),
            )

        if entity["date_key_source"]:
            df = df.withColumn(
                "AthleteDateKey",
                F.concat_ws("|", F.col("athleteId"), F.date_format(F.col(entity["date_key_source"]), "yyyy-MM-dd")),
            )

        total_rows += merge_into(df, entity["name"], entity["keys"])

print(f"History load complete for {len(athlete_ids)} athlete(s) {athlete_ids}: {total_rows} row(s) merged across {len(ENTITIES)} table(s) each.")

# METADATA ********************
# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }
