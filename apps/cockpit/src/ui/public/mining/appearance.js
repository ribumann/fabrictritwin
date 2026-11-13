export const APPEARANCE_RELEASE = Object.freeze({
  publicationBase: "https://red-wave-0c7bb6c0f.4.azurestaticapps.net/",
  sourceRepository: "ribumann/3d-scene-toolchain",
  sourcePullRequest: 3,
  sourceBranch: "feat/diamond-plant-splats",
  sourceHead: "fb6ec273b8f50bc91b960549f5b52d41e267cb76",
  assetGenerationSource: "891d4f3d877d1d8acc7097c017b4e865b73ec8e2",
  assetGenerationRun: "43381383927",
  sourceHashes: Object.freeze({
    files: "e33422f24d9f3aa109bbc4eea45c5df6640044d129236768ffa264594b62daa6",
    metadata: "828f7b17ae2488a3d1e64fd82a0a124014ef9c53899ab8a75a858d838cbf9ac4",
    scene: "8775f03b538ddb14449ab42cd2a9987076784ee84478674867a7eb53854d13c5",
    quality: "4603723f5883da1320f62d82cbe1ea90b340f715a5668cbfbc6db910e60a0dad",
  }),
  sdk: "speridlabs/idol",
  sdkRevision: "8db700349a5570aac390e4780fa32e3eed6b587a",
});

export async function readBoundedBytes(response, maximumBytes, signal) {
  const reader = response.body?.getReader();
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maximumBytes) throw new Error("Pinned appearance asset exceeds its size limit.");
    return bytes;
  }
  const chunks = [];
  let total = 0;
  while (true) {
    if (signal?.aborted) {
      await reader.cancel();
      throw new DOMException("Appearance change was canceled.", "AbortError");
    }
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new Error("Pinned appearance asset exceeds its size limit.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function sha256Hex(bytes) {
  if (!globalThis.crypto?.subtle) throw new Error("Secure asset integrity checks are unavailable.");
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

const vectorIsValid = (value) =>
  Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
const digestIsValid = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

function validBounds(bounds) {
  return (
    bounds &&
    vectorIsValid(bounds.min) &&
    vectorIsValid(bounds.max) &&
    bounds.min.every((minimum, index) => {
      const maximum = bounds.max[index];
      return maximum > minimum && Number.isFinite(maximum - minimum);
    })
  );
}

export function localSplatPath(uri) {
  if (typeof uri !== "string") throw new Error("Gaussian asset URI is missing.");
  const match = /^\/api\/assets\/plant\/splats\/(object-\d{3}\.ply)$/.exec(uri);
  if (!match) throw new Error("Gaussian asset URI is outside the pinned plant path.");
  return `/mining/plant/reconstructed/splats/${match[1]}`;
}

function sameVector(left, right) {
  return (
    vectorIsValid(left) &&
    vectorIsValid(right) &&
    left.every((value, index) => Math.abs(value - right[index]) <= 1e-8)
  );
}

export function validateAppearanceBundle(catalog, metadata, scene, files, quality) {
  if (
    metadata?.plant_id !== "D01" ||
    metadata.scene_sha256 !== APPEARANCE_RELEASE.sourceHashes.scene ||
    metadata.modules?.length !== 24 ||
    metadata.equipment?.length !== 64 ||
    metadata.streams?.length !== 50 ||
    metadata.telemetry_tags?.length !== 56 ||
    catalog?.modules?.length !== 24 ||
    catalog?.streams?.length !== 50 ||
    catalog?.telemetry_tags?.length !== 56 ||
    scene?.assets?.length !== 12 ||
    !files ||
    !quality?.assets
  )
    throw new Error("Pinned reconstructed scene does not match the D01 plant contract.");

  const appearanceAssets = Array.isArray(metadata.appearance_assets)
    ? metadata.appearance_assets
    : Object.values(metadata.appearance_assets ?? {});
  if (appearanceAssets.length !== 12) throw new Error("Pinned appearance asset set is incomplete.");

  const sceneAssets = new Map(scene.assets.map((asset) => [asset.id, asset]));
  const assetsById = new Map();
  for (const source of appearanceAssets) {
    const localPath = localSplatPath(source.uri);
    const fileName = localPath.slice(localPath.lastIndexOf("/") + 1);
    const sourcePath = `splats/${fileName}`;
    const sourceId = `D01-splat-${fileName.slice(0, -".ply".length)}`;
    const digest = source.sha256;
    if (
      source.id !== sourceId ||
      !digestIsValid(digest) ||
      files[sourcePath] !== digest ||
      assetsById.has(source.id)
    )
      throw new Error(`Gaussian asset receipt mismatch: ${source.id ?? "unknown asset"}.`);
    const sceneAsset = sceneAssets.get(source.id);
    if (
      !sceneAsset ||
      sceneAsset.kind !== "ply" ||
      sceneAsset.uri !== source.uri ||
      sceneAsset.sha256 !== digest ||
      sceneAsset.provenance?.model !== APPEARANCE_RELEASE.sdk ||
      sceneAsset.provenance?.sdk_revision !== APPEARANCE_RELEASE.sdkRevision
    )
      throw new Error(`Gaussian scene binding mismatch: ${source.id}.`);
    const screen = quality.assets[digest];
    if (
      !screen ||
      !["accepted", "excluded"].includes(screen.status) ||
      !Array.isArray(screen.reasons) ||
      (screen.status === "accepted" && screen.reasons.length !== 0) ||
      (screen.status === "excluded" && screen.reasons.length === 0) ||
      !validBounds(screen.render_bounds)
    )
      throw new Error(`Gaussian quality record is missing or invalid: ${source.id}.`);
    assetsById.set(source.id, {
      id: source.id,
      uri: source.uri,
      sourcePath,
      localPath,
      sha256: digest,
      quality: screen,
      provenance: sceneAsset.provenance,
    });
  }
  if (sceneAssets.size !== assetsById.size)
    throw new Error("Scene contains an unbound Gaussian asset.");

  const metadataModules = new Map(metadata.modules.map((module) => [module.id, module]));
  const moduleBindings = new Map();
  let acceptedPlacements = 0;
  for (const module of catalog.modules) {
    const authored = metadataModules.get(module.id);
    const asset = assetsById.get(authored?.appearance_asset_id);
    if (
      !authored ||
      !asset ||
      authored.appearance_concept !== module.appearance_concept ||
      !sameVector(authored.position, module.position) ||
      !sameVector(authored.rotation, module.rotation) ||
      !sameVector(authored.size, module.size) ||
      moduleBindings.has(module.id)
    )
      throw new Error(`Reconstructed appearance does not match module ${module.id}.`);
    if (asset.quality.status === "accepted") acceptedPlacements++;
    moduleBindings.set(module.id, { module, asset });
  }
  if (metadataModules.size !== moduleBindings.size || acceptedPlacements !== 20)
    throw new Error("Default Gaussian screening must expose exactly twenty authored placements.");
  return { assetsById, moduleBindings };
}

export function splatIssue(asset, node) {
  const quality = asset?.quality;
  if (quality?.status === "excluded") {
    return `Screened out: ${quality.reasons.join(", ") || "invalid visible extent"}.`;
  }
  if (
    quality?.status !== "accepted" ||
    !validBounds(quality.render_bounds) ||
    !vectorIsValid(node?.size) ||
    !node.size.every((value) => value > 0)
  )
    return "Missing or invalid visible Gaussian bounds.";
  const fits = quality.render_bounds.min.map(
    (value, index) => node.size[index] / (quality.render_bounds.max[index] - value),
  );
  if (Math.max(...fits) / Math.min(...fits) > 8)
    return "Excluded: fitting this appearance would require over 8x aspect distortion against its provisional object box.";
  return null;
}

export function splatFit(asset, node, showScreenedOut = false) {
  const issue = splatIssue(asset, node);
  if (
    issue &&
    !(showScreenedOut && asset?.quality?.status === "excluded" && validBounds(asset.quality.render_bounds))
  )
    return null;
  const bounds = asset?.quality?.render_bounds;
  if (
    !["accepted", "excluded"].includes(asset?.quality?.status) ||
    !validBounds(bounds) ||
    !vectorIsValid(node?.size) ||
    !node.size.every((value) => value > 0)
  )
    return null;
  const scale = Math.min(
    ...bounds.min.map((value, index) => node.size[index] / (bounds.max[index] - value)),
  );
  if (!Number.isFinite(scale) || scale <= 0) return null;
  return {
    center: bounds.min.map((value, index) => (value + bounds.max[index]) / 2),
    scale: [scale, scale, scale],
    offsetY: ((bounds.max[1] - bounds.min[1]) * scale - node.size[1]) / 2,
  };
}

export function fitSplatToNode(THREE, object, asset, node, showScreenedOut = false) {
  const fit = splatFit(asset, node, showScreenedOut);
  if (!fit) throw new Error("Gaussian appearance has missing or invalid bounds.");
  object.rotation.set(...node.rotation);
  if (
    asset.provenance.model === APPEARANCE_RELEASE.sdk &&
    asset.provenance.sdk_revision === APPEARANCE_RELEASE.sdkRevision
  )
    object.rotateX(Math.PI);
  object.scale.set(...fit.scale);
  const offset = new THREE.Vector3(...fit.center)
    .multiply(object.scale)
    .applyQuaternion(object.quaternion);
  object.position.set(...node.position).sub(offset);
  object.position.add(
    new THREE.Vector3(0, fit.offsetY, 0).applyEuler(new THREE.Euler(...node.rotation)),
  );
}

export function fitModelToNode(THREE, object, node) {
  object.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(object);
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  if (
    bounds.isEmpty() ||
    ![size.x, size.y, size.z].every((value) => Number.isFinite(value) && value > 0)
  )
    throw new Error("GLB has empty or degenerate bounds.");
  const outer = new THREE.Group();
  const normalized = new THREE.Group();
  const centered = new THREE.Group();
  centered.position.copy(center).negate();
  centered.add(object);
  normalized.scale.set(node.size[0] / size.x, node.size[1] / size.y, node.size[2] / size.z);
  normalized.add(centered);
  outer.position.set(...node.position);
  outer.rotation.set(...node.rotation);
  outer.add(normalized);
  return outer;
}
