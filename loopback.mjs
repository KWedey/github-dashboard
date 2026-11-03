const LOOPBACK_IPS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const LOOPBACK_HOST = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i;
const OWN_PAGE_FETCH_SITES = new Set([undefined, "same-origin", "none"]);

// A DNS-rebound page reaches us from loopback but names its own domain in Host;
// another site's page names localhost too, and only its Sec-Fetch-Site gives it away.
export function isLoopbackCaller(req) {
  return LOOPBACK_IPS.has(req.socket.remoteAddress)
    && LOOPBACK_HOST.test(req.headers.host ?? "")
    && OWN_PAGE_FETCH_SITES.has(req.headers["sec-fetch-site"]);
}
