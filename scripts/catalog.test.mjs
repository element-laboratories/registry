import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { after, describe, it } from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const scripts = import.meta.dirname;
const roots = [];

after(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("release catalog", () => {
  it("publishes the SDK head beside the product heads", async () => {
    const root = await fixture({
      sdk: sdkRecord([sdkRelease("0.1.0"), sdkRelease("0.2.0-rc.1"), sdkRelease("0.1.1")]),
    });

    await catalog(root, "--write");

    const index = JSON.parse(await readFile(path.join(root, "index.json"), "utf8"));
    assert.equal(index.sdk.stable.version, "0.1.1");
    assert.equal(index.sdk.candidate.version, "0.2.0-rc.1");
    assert.deepEqual(index.products, {});
  });

  it("generates a catalog before any product directory exists", async () => {
    const root = await fixture({ sdk: sdkRecord([sdkRelease("1.0.0")]) });
    await rm(path.join(root, "products"), { recursive: true });

    await catalog(root, "--write");

    const index = JSON.parse(await readFile(path.join(root, "index.json"), "utf8"));
    assert.deepEqual(index.products, {});
    assert.equal(index.sdk.stable.version, "1.0.0");
  });

  it("reports a stale index rather than rewriting it", async () => {
    const root = await fixture({ sdk: sdkRecord([sdkRelease("1.0.0")]) });

    await assert.rejects(catalog(root, "--check"), /index\.json is stale/);
  });

  it("refuses the SDK recorded as a product", async () => {
    const root = await fixture({ sdk: sdkRecord([]) });
    await mkdir(path.join(root, "products"), { recursive: true });
    await writeFile(
      path.join(root, "products", "element_sdk.json"),
      json({ schemaVersion: 1, product: "element_sdk", resource: "element_sdk", releases: [] }),
    );

    await assert.rejects(catalog(root, "--write"), /not a product; record it in sdk\.json/);
  });

  it("refuses an SDK release carrying product-only evidence", async () => {
    const release = { ...sdkRelease("1.0.0"), cfx: { assetId: 1, versionId: 2 } };
    const root = await fixture({ sdk: sdkRecord([release]) });

    await assert.rejects(catalog(root, "--write"), /cannot carry sdk or cfx evidence/);
  });

  it("refuses an SDK prerelease on the stable channel", async () => {
    const release = { ...sdkRelease("1.0.0-rc.1"), channel: "stable" };
    const root = await fixture({ sdk: sdkRecord([release]) });

    await assert.rejects(catalog(root, "--write"), /cannot be a prerelease/);
  });
});

describe("record-release", () => {
  it("appends an SDK receipt to the SDK record and leaves products alone", async () => {
    const root = await fixture({ sdk: sdkRecord([]) });

    await record(root, { schemaVersion: 1, resource: "element_sdk", ...sdkRelease("0.3.0") });

    const stored = JSON.parse(await readFile(path.join(root, "sdk.json"), "utf8"));
    assert.equal(stored.releases.length, 1);
    assert.equal(stored.releases[0].version, "0.3.0");
    assert.equal(stored.releases[0].cfx, undefined);
    await catalog(root, "--write");
    const index = JSON.parse(await readFile(path.join(root, "index.json"), "utf8"));
    assert.equal(index.sdk.stable.version, "0.3.0");
  });

  it("accepts the identical SDK receipt twice and refuses rebinding it", async () => {
    const root = await fixture({ sdk: sdkRecord([]) });
    const receipt = { schemaVersion: 1, resource: "element_sdk", ...sdkRelease("0.3.0") };

    await record(root, receipt);
    await record(root, receipt);
    const stored = JSON.parse(await readFile(path.join(root, "sdk.json"), "utf8"));
    assert.equal(stored.releases.length, 1);

    await assert.rejects(
      record(root, { ...receipt, artifact: { sha256: "b".repeat(64), bytes: 2 } }),
      /already bound to different release evidence/,
    );
  });

  it("refuses an SDK receipt that claims a product identity", async () => {
    const root = await fixture({ sdk: sdkRecord([]) });

    await assert.rejects(
      record(root, {
        schemaVersion: 1,
        resource: "element_sdk",
        product: "element_sdk",
        ...sdkRelease("0.3.0"),
      }),
      /must not carry a product identity/,
    );
  });
});

async function fixture({ sdk }) {
  const root = await mkdtemp(path.join(tmpdir(), "el-registry-"));
  roots.push(root);
  await cp(scripts, path.join(root, "scripts"), { recursive: true });
  await mkdir(path.join(root, "products"), { recursive: true });
  await writeFile(path.join(root, "sdk.json"), json(sdk));
  await writeFile(path.join(root, "index.json"), json({ schemaVersion: 1 }));
  return root;
}

async function catalog(root, mode) {
  return await run(process.execPath, [path.join(root, "scripts", "catalog.mjs"), mode]);
}

async function record(root, receipt) {
  const receiptPath = path.join(root, "receipt.json");
  await writeFile(receiptPath, json(receipt));
  return await run(process.execPath, [
    path.join(root, "scripts", "record-release.mjs"),
    receiptPath,
  ]);
}

function sdkRecord(releases) {
  return { schemaVersion: 1, resource: "element_sdk", releases };
}

function sdkRelease(version) {
  return {
    version,
    channel: version.includes("-") ? "candidate" : "stable",
    source: { repository: "element-laboratories/platform", tag: `v${version}`, commit: "a".repeat(40) },
    artifact: { sha256: "c".repeat(64), bytes: 1024 },
    publishedAt: "2026-07-28T00:00:00.000Z",
  };
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}
