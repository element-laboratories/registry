import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const run = promisify(execFile);

const root = path.resolve(import.meta.dirname, "..");
const endpoint = trimSlash(required("TELEMETRY_URL"));
const token = required("CATALOG_INGEST_TOKEN");
const commit = await resolveCommit();

const index = await readFile(path.join(root, "index.json"), "utf8");
const sdk = JSON.parse(await readFile(path.join(root, "sdk.json"), "utf8"));
const products = Object.fromEntries(
  await Promise.all(
    (await productFiles()).map(async (file) => [
      path.basename(file, ".json"),
      JSON.parse(await readFile(file, "utf8")),
    ]),
  ),
);

const response = await fetch(`${endpoint}/internal/catalog`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({ schemaVersion: 1, commit, index, sdk, products }),
});
const body = await response.text();
if (!response.ok) {
  throw new Error(`Catalog push rejected with ${response.status}: ${body}`);
}
process.stdout.write(`${body}\n`);

const served = await fetch(`${endpoint}/catalog`, { headers: { "cache-control": "no-cache" } });
if (!served.ok) {
  throw new Error(`Catalog read back failed with ${served.status}`);
}
const document = await served.text();
if (document !== index) {
  throw new Error("The served catalog is not byte-identical to index.json");
}
process.stdout.write(`Serving index.json at ${endpoint}/catalog\n`);

function required(name) {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

function trimSlash(value) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

async function resolveCommit() {
  const value =
    process.env.GITHUB_SHA ?? (await run("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(value)) {
    throw new Error(`Refusing to push with ${value} as the source commit`);
  }
  return value;
}

async function productFiles() {
  let entries;
  try {
    entries = await readdir(path.join(root, "products"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return [];
  }
  return entries
    .filter((entry) => entry.endsWith(".json"))
    .sort()
    .map((entry) => path.join(root, "products", entry));
}
