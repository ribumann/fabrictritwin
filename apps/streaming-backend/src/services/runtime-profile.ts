export type RuntimeProfile = "live" | "synthetic";

export function resolveRuntimeProfile(env: NodeJS.ProcessEnv = process.env): RuntimeProfile {
  const profile = env.DEMO_PROFILE;
  if (profile === undefined || profile === "live") {
    return "live";
  }
  if (profile === "synthetic") {
    return "synthetic";
  }
  throw new Error("DEMO_PROFILE must be exactly 'live' or 'synthetic'.");
}
