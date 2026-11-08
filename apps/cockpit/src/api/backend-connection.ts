export function resolveBackendConnection(
  profile: "live" | "synthetic",
  baseUrl: string,
  scope = process.env.STREAMING_BACKEND_SCOPE,
): { anonymous: boolean } {
  if (profile === "live") return { anonymous: false };
  const url = new URL(baseUrl);
  if (url.username || url.password) {
    throw new Error("STREAMING_BACKEND_BASE_URL must not contain credentials.");
  }
  const anonymous =
    url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (!anonymous) {
    if (url.protocol !== "https:") {
      throw new Error(
        "A non-loopback synthetic Streaming Backend must use HTTPS and service authentication.",
      );
    }
    if (!scope?.trim()) {
      throw new Error(
        "STREAMING_BACKEND_SCOPE is required for hosted synthetic service authentication.",
      );
    }
  }
  return { anonymous };
}
