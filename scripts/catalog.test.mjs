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

  it("refuses an SDK release claiming an SDK it was built against", async () => {
    const release = { ...sdkRelease("1.0.0"), sdk: { version: "0.9.0" } };
    const root = await fixture({ sdk: sdkRecord([release]) });

    await assert.rejects(catalog(root, "--write"), /cannot carry sdk evidence/);
  });

  it("refuses an SDK release that records no runtime", async () => {
    const { runtime: _runtime, ...release } = sdkRelease("1.0.0");
    const root = await fixture({ sdk: sdkRecord([release]) });

    await assert.rejects(catalog(root, "--write"), /records no usable runtime/);
  });

  it("refuses one runtime published under two versions", async () => {
    const shared = "e".repeat(64);
    const root = await fixture({
      sdk: sdkRecord([sdkRelease("1.0.0", shared), sdkRelease("1.0.1", shared)]),
    });

    await assert.rejects(catalog(root, "--write"), /is published twice/);
  });

  it("refuses a product built against an SDK runtime nobody published", async () => {
    const root = await fixture({
      sdk: sdkRecord([sdkRelease("1.0.0")]),
      products: { element_starter: productRecord([productRelease("2.0.0", sdkRelease("1.4.0"))]) },
    });

    await assert.rejects(catalog(root, "--write"), /has no published release/);
  });

  it("refuses a product naming a resource version other than the one carrying its runtime", async () => {
    const sdk = sdkRelease("1.0.0");
    const release = productRelease("2.0.0", sdk);
    release.sdk.resourceVersion = "1.1.0";
    const root = await fixture({
      sdk: sdkRecord([sdk]),
      products: { element_starter: productRecord([release]) },
    });

    await assert.rejects(catalog(root, "--write"), /that runtime was published as 1\.0\.0/);
  });

  it("publishes a product whose SDK runtime is downloadable", async () => {
    const sdk = sdkRelease("1.0.0");
    const root = await fixture({
      sdk: sdkRecord([sdk]),
      products: { element_starter: productRecord([productRelease("2.0.0", sdk)]) },
    });

    await catalog(root, "--write");

    const index = JSON.parse(await readFile(path.join(root, "index.json"), "utf8"));
    assert.equal(index.products.element_starter.stable.version, "2.0.0");
    assert.equal(index.sdk.stable.version, "1.0.0");
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
    assert.equal(stored.releases[0].runtime.hash, runtimeFor("0.3.0"));
    assert.deepEqual(stored.releases[0].cfx, { assetId: 42, versionId: 7 });
    assert.equal(stored.releases[0].sdk, undefined);
    assert.equal(stored.releases[0].product, undefined);
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

  it("refuses an SDK receipt with no runtime hash", async () => {
    const root = await fixture({ sdk: sdkRecord([]) });
    const { runtime: _runtime, ...release } = sdkRelease("0.3.0");

    await assert.rejects(
      record(root, { schemaVersion: 1, resource: "element_sdk", ...release }),
      /must record the runtime hash/,
    );
  });

  it("refuses a second SDK version carrying an already published runtime", async () => {
    const root = await fixture({ sdk: sdkRecord([]) });
    const receipt = { schemaVersion: 1, resource: "element_sdk", ...sdkRelease("0.3.0") };

    await record(root, receipt);
    await assert.rejects(
      record(root, { ...receipt, ...sdkRelease("0.3.1", runtimeFor("0.3.0")) }),
      /is already published as element_sdk 0\.3\.0/,
    );
  });

  it("records a product receipt carrying the SDK resource it needs", async () => {
    const root = await fixture({ sdk: sdkRecord([]) });
    const sdk = sdkRelease("1.0.0");

    await record(root, {
      schemaVersion: 2,
      product: "element_starter",
      resource: "element_starter",
      ...productRelease("2.0.0", sdk),
    });

    const stored = JSON.parse(
      await readFile(path.join(root, "products", "element_starter.json"), "utf8"),
    );
    assert.equal(stored.releases[0].sdk.resourceVersion, "1.0.0");
    assert.equal(stored.releases[0].sdk.runtimeHash, sdk.runtime.hash);
  });

  it("refuses a product receipt that names no SDK resource", async () => {
    const root = await fixture({ sdk: sdkRecord([]) });
    const release = productRelease("2.0.0", sdkRelease("1.0.0"));
    release.sdk = { version: "0.4.1" };

    await assert.rejects(
      record(root, {
        schemaVersion: 2,
        product: "element_starter",
        resource: "element_starter",
        ...release,
      }),
      /must record the SDK resource version and runtime hash/,
    );
  });
});

async function fixture({ sdk, products = {} }) {
  const root = await mkdtemp(path.join(tmpdir(), "el-registry-"));
  roots.push(root);
  await cp(scripts, path.join(root, "scripts"), { recursive: true });
  await mkdir(path.join(root, "products"), { recursive: true });
  for (const [resource, record] of Object.entries(products)) {
    await writeFile(path.join(root, "products", `${resource}.json`), json(record));
  }
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

function sdkRelease(version, runtimeHash = runtimeFor(version)) {
  return {
    version,
    channel: version.includes("-") ? "candidate" : "stable",
    source: {
      repository: "element-laboratories/platform",
      tag: `sdk-v${version}`,
      commit: "a".repeat(40),
    },
    artifact: { sha256: "c".repeat(64), bytes: 1024 },
    runtime: { hash: runtimeHash, packageVersion: "0.4.1", compilerVersion: "2.0.0-alpha.13" },
    cfx: { assetId: 42, versionId: 7 },
    publishedAt: "2026-07-28T00:00:00.000Z",
  };
}

function runtimeFor(version) {
  return [...version]
    .reduce((sum, char) => sum + char.charCodeAt(0), 0)
    .toString(16)
    .padStart(64, "0");
}

function productRecord(releases) {
  return { schemaVersion: 1, product: "element_starter", resource: "element_starter", releases };
}

function productRelease(version, sdk) {
  return {
    version,
    channel: version.includes("-") ? "candidate" : "stable",
    source: {
      repository: "element-laboratories/element-starter",
      tag: `v${version}`,
      commit: "b".repeat(40),
    },
    artifact: { sha256: "d".repeat(64), bytes: 2048 },
    sdk: { version: "0.4.1", resourceVersion: sdk.version, runtimeHash: sdk.runtime.hash },
    cfx: { assetId: 11, versionId: 3 },
    publishedAt: "2026-07-29T00:00:00.000Z",
  };
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}
