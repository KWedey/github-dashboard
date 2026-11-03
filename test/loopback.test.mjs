import test from "node:test";
import assert from "node:assert/strict";
import { isLoopbackCaller } from "../loopback.mjs";

const request = (remoteAddress, host, fetchSite) => ({ socket: { remoteAddress }, headers: { host, ...(fetchSite && { "sec-fetch-site": fetchSite }) } });

test("a loopback caller naming a loopback host is the owner", () => {
  for (const [ip, host] of [["127.0.0.1", "localhost:4747"], ["127.0.0.1", "127.0.0.1:4747"], ["::1", "[::1]:4747"], ["::ffff:127.0.0.1", "localhost"], ["127.0.0.1", "LOCALHOST:4747"]]) {
    assert.equal(isLoopbackCaller(request(ip, host)), true, `${ip} ${host}`);
  }
});

test("regression: a DNS-rebound page on loopback is not the owner", () => {
  assert.equal(isLoopbackCaller(request("127.0.0.1", "evil.example:4747")), false);
  assert.equal(isLoopbackCaller(request("127.0.0.1", "localhost.evil.example:4747")), false);
  assert.equal(isLoopbackCaller(request("::1", "127.0.0.1.nip.io:4747")), false);
});

test("no Host header, a malformed one, or a remote caller is not the owner", () => {
  assert.equal(isLoopbackCaller(request("127.0.0.1", undefined)), false);
  assert.equal(isLoopbackCaller(request("127.0.0.1", "local host")), false);
  assert.equal(isLoopbackCaller(request("10.0.0.202", "localhost:4747")), false);
});

test("a Host carrying userinfo, a path, or a fragment around a loopback name is not the owner", () => {
  for (const host of ["evil.example@localhost:4747", "localhost/evil.example", "localhost#evil", "localhost\\evil"]) {
    assert.equal(isLoopbackCaller(request("127.0.0.1", host)), false, host);
  }
});

test("regression: another site's page calling localhost is not the owner, the dashboard's own page and a typed URL are", () => {
  assert.equal(isLoopbackCaller(request("127.0.0.1", "localhost:4747", "cross-site")), false);
  assert.equal(isLoopbackCaller(request("127.0.0.1", "localhost:4747", "same-site")), false);
  assert.equal(isLoopbackCaller(request("127.0.0.1", "localhost:4747", "same-origin")), true);
  assert.equal(isLoopbackCaller(request("127.0.0.1", "localhost:4747", "none")), true);
});
