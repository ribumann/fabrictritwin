import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { APPEARANCE_RELEASE, validateAppearanceBundle } from "../src/ui/public/mining/appearance.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, "src/ui/public/mining/plant/reconstructed");
const base = new URL(APPEARANCE_RELEASE.publicationBase);
const sourceFiles = {
  "plant/files.json": "files",
  "plant/metadata.json": "metadata",
  "demo/D01.json": "scene",
  "demo/quality.json": "quality",
};
const maxDocumentBytes = 1_048_576;
const maxSplatsBytes = 32 * 1_048_576;
const maxAssetBytes = 8 * 1_048_576;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function download(relativePath, maxBytes) {
  const url = new URL(relativePath, base);
  if (
    url.protocol !== "https:" ||
    url.origin !== base.origin ||
    url.hostname !== "red-wave-0c7bb6c0f.4.azurestaticapps.net"
  )
    throw new Error("Unapproved reconstructed asset destination.");
  const response = await fetch(url, {
    signal: AbortSignal.timeout(10_000),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`Asset request failed: ${response.status} ${relativePath}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maxBytes) throw new Error(`Asset exceeds its size limit: ${relativePath}`);
  return bytes;
}

const documents = new Map();
for (const [relativePath, key] of Object.entries(sourceFiles)) {
  const bytes = await download(relativePath, maxDocumentBytes);
  if (sha256(bytes) !== APPEARANCE_RELEASE.sourceHashes[key])
    throw new Error(`Pinned publication receipt mismatch: ${relativePath}`);
  documents.set(key, bytes);
}

const source = path.resolve(root, "../simulator/src/mining");
const catalog = JSON.parse(await fs.readFile(path.join(source, "plant-catalog.json"), "utf8"));
const parsed = Object.fromEntries(
  [...documents].map(([key, bytes]) => [key, JSON.parse(bytes.toString("utf8"))]),
);
const bundle = validateAppearanceBundle(
  catalog,
  parsed.metadata,
  parsed.scene,
  parsed.files,
  parsed.quality,
);

for (const module of catalog.modules) {
  const cleanPath = `modules/${module.appearance_concept}.glb`;
  const cleanBytes = await fs.readFile(path.join(root, "src/ui/public/mining/plant", cleanPath));
  if (sha256(cleanBytes) !== parsed.files[cleanPath])
    throw new Error(`Existing Clean GLB does not match the publication receipt: ${cleanPath}`);
}

let totalSplatsBytes = 0;
for (const asset of bundle.assetsById.values()) {
  const bytes = await download(`plant/${asset.sourcePath}`, maxAssetBytes);
  if (sha256(bytes) !== asset.sha256)
    throw new Error(`Gaussian asset bytes do not match their receipt: ${asset.sourcePath}`);
  totalSplatsBytes += bytes.length;
  const destination = path.join(target, "splats", path.basename(asset.localPath));
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, bytes);
}
if (totalSplatsBytes > maxSplatsBytes)
  throw new Error("Gaussian asset package exceeds its total size limit.");

const sourceDirectory = path.join(target, "source");
await fs.mkdir(sourceDirectory, { recursive: true });
await fs.rm(path.join(sourceDirectory, "scene.json"), { force: true });
const sourceNames = {
  files: "files.json",
  metadata: "metadata.json",
  scene: "D01.json",
  quality: "quality.json",
};
for (const [key, bytes] of documents) {
  await fs.writeFile(path.join(sourceDirectory, sourceNames[key]), bytes);
}
console.log(
  `Pinned reconstructed assets verified and materialized (${bundle.assetsById.size} PLY files, ${totalSplatsBytes} bytes).`,
);
