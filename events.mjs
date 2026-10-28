export const sseFrame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

export function createStreams({ first = () => "", pingMs = 25 * 1000 } = {}) {
  const streams = new Set();
  return {
    open(req, res, who) {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-store, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
      res.write(first());
      const entry = { res, ...who };
      streams.add(entry);
      const ping = setInterval(() => res.write(": ping\n\n"), pingMs);
      req.on("close", () => { clearInterval(ping); streams.delete(entry); });
    },
    broadcast(event, data, to = () => true) {
      for (const s of streams) if (to(s)) s.res.write(sseFrame(event, data));
    },
  };
}
