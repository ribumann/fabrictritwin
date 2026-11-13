import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";

const require = createRequire(import.meta.url);
fs.cpSync("src/ui/public", "dist/ui/public", { recursive: true });
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
const catalogBytes = fs.readFileSync(catalog);
if (createHash("sha256").update(catalogBytes).digest("hex") !== manifest.catalog.sha256) {
  throw new Error("Canonical catalog receipt mismatch.");
}
fs.writeFileSync("dist/ui/public/mining/catalog.json", catalogBytes);
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
