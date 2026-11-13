import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import {
  APPEARANCE_RELEASE,
  validateAppearanceBundle,
} from "../src/ui/public/mining/appearance.js";

const require = createRequire(import.meta.url);
fs.cpSync("src/ui/public", "dist/ui/public", { recursive: true });
const canonicalJsonBytes = (bytes) =>
  Buffer.from(bytes.toString("utf8").replace(/\r\n/g, "\n"), "utf8");
fs.mkdirSync("dist/ui/public/vendor", { recursive: true });
fs.copyFileSync(
  require.resolve("powerbi-client/dist/powerbi.js"),
  "dist/ui/public/vendor/powerbi.js",
);
const three = path.resolve(path.dirname(require.resolve("three")), "..");
fs.rmSync("dist/ui/public/vendor/three", { recursive: true, force: true });
for (const item of [
  "build/three.module.js",
  "build/three.core.js",
  "examples/jsm/postprocessing/Pass.js",
  "examples/jsm/loaders/GLTFLoader.js",
  "examples/jsm/controls/OrbitControls.js",
  "examples/jsm/utils/BufferGeometryUtils.js",
  "examples/jsm/utils/SkeletonUtils.js",
]) {
  const target = path.join("dist/ui/public/vendor/three", item);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(three, item), target);
}
fs.copyFileSync(path.join(three, "LICENSE"), "dist/ui/public/vendor/three/LICENSE");
const sparkDist = path.dirname(require.resolve("@sparkjsdev/spark"));
const sparkRoot = path.resolve(sparkDist, "..");
const sparkPackage = JSON.parse(fs.readFileSync(path.join(sparkRoot, "package.json"), "utf8"));
if (sparkPackage.version !== "2.4.0")
  throw new Error("Pinned local Gaussian renderer version mismatch.");
const sparkTarget = "dist/ui/public/vendor/spark";
fs.rmSync(sparkTarget, { recursive: true, force: true });
fs.mkdirSync(sparkTarget, { recursive: true });
fs.copyFileSync(path.join(sparkDist, "spark.module.js"), path.join(sparkTarget, "spark.module.js"));
fs.copyFileSync(path.join(sparkRoot, "LICENSE"), path.join(sparkTarget, "LICENSE"));
// Canonical plant data and receipts belong to the simulator package, not this view.
const catalogDir = process.env.MINING_CATALOG_DIR ?? "../simulator/src/mining";
const catalog = path.join(catalogDir, "plant-catalog.json");
const receipt = path.join(catalogDir, "catalog-receipt.json");
for (const [source, target] of [
  [catalog, "catalog.json"],
  [receipt, "catalog-receipt.json"],
]) {
  if (!fs.existsSync(source)) throw new Error(`Missing canonical mining package: ${source}`);
  fs.copyFileSync(source, path.join("dist/ui/public/mining", target));
}
const manifest = JSON.parse(fs.readFileSync(receipt, "utf8"));
const catalogBytes = canonicalJsonBytes(fs.readFileSync(catalog));
if (createHash("sha256").update(catalogBytes).digest("hex") !== manifest.catalog.sha256) {
  throw new Error("Canonical catalog receipt mismatch.");
}
fs.writeFileSync("dist/ui/public/mining/catalog.json", catalogBytes);
const catalogDocument = JSON.parse(catalogBytes.toString("utf8"));
const reconstructedSource = "src/ui/public/mining/plant/reconstructed/source";
const appearanceDocuments = {};
for (const [key, file] of Object.entries({
  files: "files.json",
  metadata: "metadata.json",
  scene: "D01.json",
  quality: "quality.json",
})) {
  const source = path.join(reconstructedSource, file);
  if (!fs.existsSync(source))
    throw new Error("Pinned reconstructed release is missing; run npm run prepare:reconstructed-assets --workspace apps/cockpit.");
  const bytes = canonicalJsonBytes(fs.readFileSync(source));
  if (createHash("sha256").update(bytes).digest("hex") !== APPEARANCE_RELEASE.sourceHashes[key])
    throw new Error(`Pinned reconstructed release receipt mismatch: ${file}`);
  appearanceDocuments[key] = JSON.parse(bytes.toString("utf8"));
  fs.writeFileSync(
    path.join("dist/ui/public/mining/plant/reconstructed/source", file),
    bytes,
  );
}
const appearanceBundle = validateAppearanceBundle(
  catalogDocument,
  appearanceDocuments.metadata,
  appearanceDocuments.scene,
  appearanceDocuments.files,
  appearanceDocuments.quality,
);
for (const concept of new Set(catalogDocument.modules.map((module) => module.appearance_concept))) {
  const asset = `modules/${concept}.glb`;
  const source = path.join("src/ui/public/mining/plant", asset);
  if (
    !fs.existsSync(source) ||
    createHash("sha256").update(fs.readFileSync(source)).digest("hex") !== appearanceDocuments.files[asset]
  )
    throw new Error(`Clean appearance receipt mismatch: ${asset}`);
}
let splatsBytes = 0;
for (const asset of appearanceBundle.assetsById.values()) {
  const source = path.join("src/ui/public/mining/plant/reconstructed", asset.sourcePath);
  if (!fs.existsSync(source))
    throw new Error(`Missing pinned reconstructed asset ${asset.sourcePath}; run npm run prepare:reconstructed-assets --workspace apps/cockpit.`);
  const bytes = fs.readFileSync(source);
  if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256)
    throw new Error(`Reconstructed appearance receipt mismatch: ${asset.sourcePath}`);
  splatsBytes += bytes.byteLength;
}
if (splatsBytes > 32 * 1_048_576)
  throw new Error("Reconstructed appearance package exceeds its build-size limit.");
for (const asset of manifest.assets.filter(
  (item) =>
    item.path === "layout.svg" || item.path === "plant.glb" || item.path.startsWith("modules/"),
)) {
  const source = path.join("src/ui/public/mining/plant", asset.path);
  if (
    !fs.existsSync(source) ||
    createHash("sha256").update(fs.readFileSync(source)).digest("hex") !== asset.sha256
  ) {
    throw new Error(
      `Missing or mismatched pinned asset ${asset.path}; run npm run prepare:mining-assets --workspace apps/cockpit.`,
    );
  }
}
