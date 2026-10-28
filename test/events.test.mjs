import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createStreams, sseFrame } from "../events.mjs";

function page(t) {
  const req = new EventEmitter();
  t.after(() => req.emit("close"));
  return { req, res: { frames: [], writeHead() {}, write(f) { this.frames.push(f); } } };
}

test("an owner-only event reaches the owner's pages and no guest's", (t) => {
  const streams = createStreams({ first: () => sseFrame("feed", { state: "off" }) }), owner = page(t), guest = page(t);
  streams.open(owner.req, owner.res, { login: "octocat", owner: true });
  streams.open(guest.req, guest.res, { login: "hubot", owner: false });
  streams.broadcast("quota", { at: "now" }, (s) => s.owner);
  assert.deepEqual(owner.res.frames, [sseFrame("feed", { state: "off" }), sseFrame("quota", { at: "now" })]);
  assert.deepEqual(guest.res.frames, [sseFrame("feed", { state: "off" })]);
});

test("an unfiltered event reaches every page, and a closed page gets nothing more", (t) => {
  const streams = createStreams(), a = page(t), b = page(t);
  streams.open(a.req, a.res, { login: "octocat" });
  streams.open(b.req, b.res, { login: "hubot" });
  b.req.emit("close");
  streams.broadcast("feed", { state: "live" });
  assert.equal(a.res.frames.at(-1), sseFrame("feed", { state: "live" }));
  assert.equal(b.res.frames.length, 1);
});
