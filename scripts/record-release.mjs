import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const SDK_RESOURCE = "element_sdk";
const identifier = (value) => typeof value === "string" && /^[a-z][a-z0-9_-]*$/.test(value);

const receiptPath = process.argv[2];
if (receiptPath === undefined) {
  throw new Error("Usage: npm run record -- <deployment-receipt.json>");
}
const root = path.resolve(import.meta.dirname, "..");
const receipt = JSON.parse(await readFile(path.resolve(receiptPath), "utf8"));
if (receipt?.schemaVersion !== 1 || !identifier(receipt?.resource)) {
  throw new Error("Unsupported deployment receipt");
}

const isSdk = receipt.resource === SDK_RESOURCE;
if (isSdk) {
  if (receipt.product !== undefined) {
    throw new Error(`${SDK_RESOURCE} is not a product and must not carry a product identity`);
  }
  if (receipt.sdk !== undefined || receipt.cfx !== undefined) {
    throw new Error(`${SDK_RESOURCE} releases cannot carry sdk or cfx evidence`);
  }
} else if (!identifier(receipt?.product)) {
  throw new Error("Unsupported deployment receipt");
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
  ...(isSdk ? {} : { sdk: receipt.sdk, cfx: receipt.cfx }),
  publishedAt: receipt.publishedAt,
};
const existing = record.releases.find((entry) => entry.version === release.version);
if (existing !== undefined) {
  if (JSON.stringify(existing) !== JSON.stringify(release)) {
    throw new Error(`Version ${release.version} is already bound to different release evidence`);
  }
  process.exit(0);
}
record.releases.push(release);
await writeFile(file, `${JSON.stringify(record, null, 2)}\n`, "utf8");
