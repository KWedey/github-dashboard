import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("../server.mjs", import.meta.url));

function freePort() {
  return new Promise((resolve) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
}

async function demoServer(t) {
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, DEMO: "1", PORT: String(port), HOST: "127.0.0.1" }, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => child.kill());
  await new Promise((resolve, reject) => {
    child.stdout.on("data", (d) => { if (String(d).includes("github-dashboard →")) resolve(); });
    child.on("exit", (code) => reject(new Error(`server exited with ${code} before listening`)));
  });
  return { port, child };
}

function rawStatusLine(port, request) {
  return new Promise((resolve, reject) => {
    let reply = "";
    const s = net.connect(port, "127.0.0.1", () => s.write(request));
    s.on("data", (d) => { reply += d; }).on("close", () => resolve(reply.split("\r\n")[0])).on("error", reject);
  });
}

test("regression: a malformed Host or request target cannot take the server down", async (t) => {
  const { port, child } = await demoServer(t);
  assert.equal(await rawStatusLine(port, "GET / HTTP/1.1\r\nHost: local host\r\nConnection: close\r\n\r\n"), "HTTP/1.1 200 OK");
  assert.equal(await rawStatusLine(port, "GET http://[/ HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"), "HTTP/1.1 400 Bad Request");
  assert.equal(child.exitCode, null);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/me`)).status, 200);
});
