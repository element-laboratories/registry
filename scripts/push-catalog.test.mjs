import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import process from "node:process";
import { after, describe, it } from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const script = path.join(import.meta.dirname, "push-catalog.mjs");
const root = path.resolve(import.meta.dirname, "..");
const COMMIT = "0".repeat(39) + "1";
const servers = [];

after(async () => {
  for (const server of servers.splice(0)) {
    await new Promise((resolve) => server.close(resolve));
  }
});

describe("catalog push", () => {
  it("sends the ledger and proves what is served", async () => {
    const received = [];
    const index = await readFile(path.join(root, "index.json"), "utf8");
    const url = await telemetry(async (request, body) => {
      received.push({ request, body });
      if (request.url === "/internal/catalog") return { status: 200, body: '{"ok":true}' };
      return { status: 200, body: index };
    });

    const { stdout } = await push(url);

    const [ingest, read] = received;
    assert.equal(ingest.request.method, "POST");
    assert.equal(ingest.request.url, "/internal/catalog");
    assert.equal(ingest.request.headers.authorization, "Bearer test-token");
    assert.equal(read.request.url, "/catalog");

    const payload = JSON.parse(ingest.body);
    assert.equal(payload.schemaVersion, 1);
    assert.equal(payload.commit, COMMIT);
    assert.equal(payload.index, index);
    assert.deepEqual(payload.sdk, JSON.parse(await readFile(path.join(root, "sdk.json"), "utf8")));
    for (const entry of await readdir(path.join(root, "products"))) {
      const name = path.basename(entry, ".json");
      assert.deepEqual(
        payload.products[name],
        JSON.parse(await readFile(path.join(root, "products", entry), "utf8")),
      );
    }
    assert.match(stdout, /Serving index\.json/u);
  });

  it("fails with the detail when the ledger is refused", async () => {
    const url = await telemetry(() => ({
      status: 422,
      body: '{"error":"invalid_ledger","detail":"Unsupported schemaVersion at sdk"}',
    }));

    await assert.rejects(push(url), /422.*Unsupported schemaVersion at sdk/su);
  });

  it("fails when the service serves something other than index.json", async () => {
    const url = await telemetry((request) =>
      request.url === "/internal/catalog"
        ? { status: 200, body: '{"ok":true}' }
        : { status: 200, body: '{"schemaVersion":1,"sdk":{},"products":{}}' },
    );

    await assert.rejects(push(url), /not byte-identical/u);
  });

  it("refuses to push without a token", async () => {
    const url = await telemetry(() => ({ status: 200, body: '{"ok":true}' }));

    await assert.rejects(push(url, { CATALOG_INGEST_TOKEN: "" }), /CATALOG_INGEST_TOKEN is not set/u);
  });

  it("refuses an abbreviated source commit", async () => {
    const url = await telemetry(() => ({ status: 200, body: '{"ok":true}' }));

    await assert.rejects(push(url, { GITHUB_SHA: "0abcdef" }), /as the source commit/u);
  });
});

function push(url, overrides = {}) {
  return run(process.execPath, [script], {
    env: {
      ...process.env,
      TELEMETRY_URL: url,
      CATALOG_INGEST_TOKEN: "test-token",
      GITHUB_SHA: COMMIT,
      ...overrides,
    },
  });
}

async function telemetry(handler) {
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", async () => {
      const result = await handler(request, Buffer.concat(chunks).toString("utf8"));
      response.writeHead(result.status, { "content-type": "application/json; charset=utf-8" });
      response.end(result.body);
    });
  });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
