import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = process.env.MINING_CATALOG_DIR ?? path.resolve(root, "../simulator/src/mining");
const receipt = JSON.parse(await fs.readFile(path.join(source, "catalog-receipt.json"), "utf8"));
const target = path.join(root, "src/ui/public/mining/plant");
const base = new URL(receipt.catalog.source_url);
base.pathname = base.pathname.slice(0, base.pathname.lastIndexOf("/") + 1);
if (base.protocol !== "https:" || base.hostname !== "red-wave-0c7bb6c0f.4.azurestaticapps.net") {
  throw new Error("Unapproved canonical asset source.");
}
for (const asset of receipt.assets.filter(
  (asset) =>
    asset.path === "layout.svg" || asset.path === "plant.glb" || asset.path.startsWith("modules/"),
)) {
  if (!/^(?:modules\/[a-z]+\.glb|layout\.svg|plant\.glb)$/.test(asset.path))
    throw new Error("Unsafe asset path.");
  const response = await fetch(new URL(asset.path, base), {
    signal: AbortSignal.timeout(10_000),
    redirect: "error",
  });
  if (!response.ok)
    throw new Error(`Canonical asset request failed: ${response.status} ${asset.path}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256)
    throw new Error(`Asset receipt mismatch: ${asset.path}`);
  const destination = path.join(target, ...asset.path.split("/"));
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, bytes);
}
await fs.copyFile(path.join(source, "LICENSE"), path.join(target, "LICENSE"));
console.log(
  "Materialized canonical authored plant assets; every binary matched its pinned receipt.",
);
