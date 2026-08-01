import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const productsRoot = path.join(root, "products");
const sdkPath = path.join(root, "sdk.json");
const indexPath = path.join(root, "index.json");
const SDK_RESOURCE = "element_sdk";
const mode = process.argv[2];
if (mode !== "--check" && mode !== "--write") {
  throw new Error("Usage: node scripts/catalog.mjs <--check|--write>");
}

const sdkRecord = JSON.parse(await readFile(sdkPath, "utf8"));
validateSdkRecord(sdkRecord, "sdk.json");
const publishedRuntimes = new Map();
for (const release of sdkRecord.releases) {
  const versions = publishedRuntimes.get(release.runtime.hash) ?? [];
  versions.push(release.version);
  publishedRuntimes.set(release.runtime.hash, versions);
}

const files = (await readdir(productsRoot).catch(ignoreMissing))
  .filter((file) => file.endsWith(".json"))
  .sort();
const products = {};
for (const file of files) {
  const record = JSON.parse(await readFile(path.join(productsRoot, file), "utf8"));
  validateRecord(record, file);
  if (file !== `${record.resource}.json`) {
    throw new Error(`${file}: filename must match resource '${record.resource}'`);
  }
  if (record.resource === SDK_RESOURCE) {
    throw new Error(`${file}: ${SDK_RESOURCE} is not a product; record it in sdk.json`);
  }
  products[record.resource] = heads(record.releases);
}

const generated = `${JSON.stringify(
  { schemaVersion: 1, sdk: heads(sdkRecord.releases), products },
  null,
  2,
)}\n`;
if (mode === "--write") {
  await writeFile(indexPath, generated, "utf8");
} else {
  const current = await readFile(indexPath, "utf8");
  if (current !== generated) {
    throw new Error("index.json is stale; run npm run generate");
  }
}

function assertSdkRuntimePublished(release, file) {
  const versions = publishedRuntimes.get(release.sdk.runtimeHash);
  if (versions === undefined) {
    throw new Error(
      `${file}: release ${release.version} needs an ${SDK_RESOURCE} runtime that has no published release`,
    );
  }
  if (!versions.includes(release.sdk.resourceVersion)) {
    throw new Error(
      `${file}: release ${release.version} depends on ${SDK_RESOURCE} ${release.sdk.resourceVersion}, but that runtime is published as ${versions.join(", ")}`,
    );
  }
}

function validateRecord(record, file) {
  if (
    record?.schemaVersion !== 1 ||
    !identifier(record.product) ||
    !identifier(record.resource) ||
    !Array.isArray(record.releases)
  ) {
    throw new Error(`${file}: invalid product record`);
  }
  validateReleases(record.releases, file, true);
}

function validateSdkRecord(record, file) {
  if (
    record?.schemaVersion !== 1 ||
    record.resource !== SDK_RESOURCE ||
    !Array.isArray(record.releases)
  ) {
    throw new Error(`${file}: invalid SDK record`);
  }
  validateReleases(record.releases, file, false);
}

function validateReleases(releases, file, isProduct) {
  const versions = new Set();
  const archives = new Set();
  for (const release of releases) {
    if (
      semver(release?.version) === null ||
      !["stable", "candidate"].includes(release?.channel) ||
      !/^[0-9a-f]{40}$/.test(release?.source?.commit ?? "") ||
      !/^[0-9a-f]{64}$/.test(release?.artifact?.sha256 ?? "") ||
      !Number.isSafeInteger(release?.artifact?.bytes) ||
      release.artifact.bytes < 1 ||
      Number.isNaN(Date.parse(release?.publishedAt ?? "")) ||
      typeof release?.source?.repository !== "string" ||
      typeof release?.source?.tag !== "string"
    ) {
      throw new Error(`${file}: invalid release ${release?.version ?? "<unknown>"}`);
    }
    if (
      !Number.isSafeInteger(release?.cfx?.assetId) ||
      !Number.isSafeInteger(release?.cfx?.versionId)
    ) {
      throw new Error(`${file}: release ${release.version} records no portal asset`);
    }
    if (isProduct) {
      if (
        semver(release?.sdk?.version) === null ||
        semver(release?.sdk?.resourceVersion) === null ||
        !/^[0-9a-f]{64}$/.test(release?.sdk?.runtimeHash ?? "")
      ) {
        throw new Error(`${file}: invalid release ${release.version}`);
      }
      assertSdkRuntimePublished(release, file);
    } else {
      if (release.sdk !== undefined) {
        throw new Error(`${file}: SDK release ${release.version} cannot carry sdk evidence`);
      }
      if (
        !/^[0-9a-f]{64}$/.test(release?.runtime?.hash ?? "") ||
        semver(release?.runtime?.packageVersion) === null ||
        typeof release?.runtime?.compilerVersion !== "string"
      ) {
        throw new Error(`${file}: SDK release ${release.version} records no usable runtime`);
      }
      if (archives.has(release.artifact.sha256)) {
        throw new Error(`${file}: archive ${release.artifact.sha256} is published twice`);
      }
      archives.add(release.artifact.sha256);
    }
    if (release.channel === "stable" && semver(release.version).prerelease.length > 0) {
      throw new Error(`${file}: stable release ${release.version} cannot be a prerelease`);
    }
    if (release.channel === "candidate" && semver(release.version).prerelease.length === 0) {
      throw new Error(`${file}: candidate release ${release.version} must be a prerelease`);
    }
    if (versions.has(release.version)) {
      throw new Error(`${file}: version ${release.version} is rebound`);
    }
    versions.add(release.version);
  }
}

function heads(releases) {
  return {
    stable: head(releases.filter((release) => release.channel === "stable")),
    candidate: head(releases.filter((release) => release.channel === "candidate")),
  };
}

function head(releases) {
  const latest = releases.toSorted((a, b) => compare(semver(b.version), semver(a.version)))[0];
  return latest === undefined
    ? null
    : { version: latest.version, publishedAt: latest.publishedAt };
}

function ignoreMissing(error) {
  if (error?.code === "ENOENT") return [];
  throw error;
}

function identifier(value) {
  return typeof value === "string" && /^[a-z][a-z0-9_-]*$/.test(value);
}

function semver(value) {
  const match =
    typeof value === "string"
      ? /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
          value,
        )
      : null;
  if (match === null) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4]?.split(".") ?? [],
  };
}

function compare(a, b) {
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] > b.core[index] ? 1 : -1;
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length === 0 ? 1 : -1;
  }
  const count = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < count; index += 1) {
    const left = a.prerelease[index];
    const right = b.prerelease[index];
    if (left === undefined || right === undefined) return left === undefined ? -1 : 1;
    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    const leftValue = leftNumeric ? Number(left) : left;
    const rightValue = rightNumeric ? Number(right) : right;
    if (leftValue !== rightValue) return leftValue > rightValue ? 1 : -1;
  }
  return 0;
}
