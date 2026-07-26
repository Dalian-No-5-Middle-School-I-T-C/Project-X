function envFlag(name: string, fallback = false): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

/**
 * Enables the remote API surface used by Windows scanner clients to upload
 * locally captured pages. This does not enable TWAIN/native scanner routes on
 * the server.
 */
export function isScannerClientApiEnabled(): boolean {
  return envFlag("PROJECTX_ENABLE_SCANNER_CLIENT_API");
}

/**
 * Packaged scanner clients serve their UI from a loopback HTTP origin. The
 * preferred port is 5174, but Electron may fall back to a random free port.
 */
export function isScannerClientOrigin(origin: string): boolean {
  if (!isScannerClientApiEnabled()) return false;

  try {
    const url = new URL(origin);
    if (url.protocol !== "http:") return false;
    const hostname = url.hostname.toLowerCase();
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
  } catch {
    return false;
  }
}
