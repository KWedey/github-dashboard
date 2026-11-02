import test from "node:test";
import assert from "node:assert/strict";
import { isLoopbackCaller } from "../loopback.mjs";

test("a loopback caller naming a loopback host is the owner", () => {
  for (const [ip, host] of [["127.0.0.1", "localhost:4747"], ["127.0.0.1", "127.0.0.1:4747"], ["::1", "[::1]:4747"], ["::ffff:127.0.0.1", "localhost"]]) {
    assert.equal(isLoopbackCaller(ip, host), true, `${ip} ${host}`);
  }
});

test("regression: a DNS-rebound page on loopback is not the owner", () => {
  assert.equal(isLoopbackCaller("127.0.0.1", "evil.example:4747"), false);
  assert.equal(isLoopbackCaller("127.0.0.1", "localhost.evil.example:4747"), false);
  assert.equal(isLoopbackCaller("::1", "127.0.0.1.nip.io:4747"), false);
});

test("no Host header, a malformed one, or a remote caller is not the owner", () => {
  assert.equal(isLoopbackCaller("127.0.0.1", undefined), false);
  assert.equal(isLoopbackCaller("127.0.0.1", "local host"), false);
  assert.equal(isLoopbackCaller("10.0.0.202", "localhost:4747"), false);
});
