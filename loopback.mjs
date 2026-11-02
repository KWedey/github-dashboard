const LOOPBACK_IPS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

// A DNS-rebound page reaches us from loopback too, but its Host header still names its own domain.
export function isLoopbackCaller(remoteAddress, hostHeader) {
  if (!LOOPBACK_IPS.has(remoteAddress) || !hostHeader) return false;
  try { return LOOPBACK_HOSTS.has(new URL(`http://${hostHeader}`).hostname); } catch { return false; }
}
