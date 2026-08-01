import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const SDK_RESOURCE = "element_sdk";
const identifier = (value) => typeof value === "string" && /^[a-z][a-z0-9_-]*$/.test(value);
const sha256 = (value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const portalIds = (cfx) =>
  Number.isSafeInteger(cfx?.assetId) && Number.isSafeInteger(cfx?.versionId);

const receiptPath = process.argv[2];
if (receiptPath === undefined) {
  throw new Error("Usage: npm run record -- <deployment-receipt.json>");
}
const root = path.resolve(import.meta.dirname, "..");
const receipt = JSON.parse(await readFile(path.resolve(receiptPath), "utf8"));
if (!identifier(receipt?.resource)) {
  throw new Error("Unsupported deployment receipt");
}

const isSdk = receipt.resource === SDK_RESOURCE;
if (isSdk) {
  if (receipt.schemaVersion !== 1) {
    throw new Error("Unsupported SDK deployment receipt");
  }
  if (receipt.product !== undefined) {
    throw new Error(`${SDK_RESOURCE} is not a product and must not carry a product identity`);
  }
  if (receipt.sdk !== undefined) {
    throw new Error(`${SDK_RESOURCE} releases cannot carry sdk evidence`);
  }
  if (!sha256(receipt.runtime?.hash)) {
    throw new Error(`${SDK_RESOURCE} releases must record the runtime hash they publish`);
  }
  if (!portalIds(receipt.cfx)) {
    throw new Error(`${SDK_RESOURCE} releases must record the portal asset they were uploaded to`);
  }
} else {
  if (receipt.schemaVersion !== 2 || !identifier(receipt.product)) {
    throw new Error("Unsupported deployment receipt");
  }
  if (!sha256(receipt.sdk?.runtimeHash) || typeof receipt.sdk?.resourceVersion !== "string") {
    throw new Error("A product release must record the SDK resource version and runtime hash");
  }
  if (!portalIds(receipt.cfx)) {
    throw new Error("A product release must record the portal asset it was uploaded to");
  }
}

const file = isSdk
  ? path.join(root, "sdk.json")
  : path.join(root, "products", `${receipt.resource}.json`);
await mkdir(path.dirname(file), { recursive: true });
let record;
try {
  record = JSON.parse(await readFile(file, "utf8"));
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
  record = isSdk
    ? { schemaVersion: 1, resource: receipt.resource, releases: [] }
    : {
        schemaVersion: 1,
        product: receipt.product,
        resource: receipt.resource,
        releases: [],
      };
}
if (record.resource !== receipt.resource || (!isSdk && record.product !== receipt.product)) {
  throw new Error(`Receipt identity does not match ${file}`);
}
const release = {
  version: receipt.version,
  channel: receipt.channel,
  source: receipt.source,
  artifact: receipt.artifact,
  ...(isSdk ? { runtime: receipt.runtime } : { sdk: receipt.sdk }),
  cfx: receipt.cfx,
  publishedAt: receipt.publishedAt,
};

const sameArchive = record.releases.find(
  (entry) =>
    entry.artifact?.sha256 === release.artifact?.sha256 && entry.version !== release.version,
);
if (sameArchive !== undefined) {
  throw new Error(`These bytes are already published as ${receipt.resource} ${sameArchive.version}`);
}

const existing = record.releases.find((entry) => entry.version === release.version);
if (existing !== undefined) {
  if (JSON.stringify(existing) !== JSON.stringify(release)) {
    throw new Error(`Version ${release.version} is already bound to different release evidence`);
  }
  process.exit(0);
}
record.releases.push(release);
await writeFile(file, `${JSON.stringify(record, null, 2)}\n`, "utf8");
