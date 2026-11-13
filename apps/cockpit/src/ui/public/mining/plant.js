const svgNs = "http://www.w3.org/2000/svg";
export function visibleModules(catalog, lines) {
  return catalog.modules.filter((module) => lines.has(module.line));
}
export function connections(catalog, moduleId, direction) {
  const endpoint = direction === "upstream" ? "target" : "source";
  const other = direction === "upstream" ? "source" : "target";
  return [
    ...new Set(
      catalog.streams
        .filter((stream) => stream[endpoint].module_id === moduleId)
        .map((stream) => stream[other].module_id),
    ),
  ];
}
export function relevantTags(catalog, moduleId) {
  const module = catalog.modules.find((item) => item.id === moduleId);
  const priorities = {
    crusher: ["vibration_rms", "bearing_temperature", "motor_current"],
    dms: ["medium_density", "feed_pressure"],
    water: ["level", "water_flow"],
  };
  const tags = catalog.telemetry_tags.filter((tag) => tag.module_id === moduleId);
  const preferred = priorities[module?.kind] ?? [];
  return [...tags]
    .sort((a, b) => {
      const rank = (tag) => {
        const index = preferred.findIndex(
          (metric) => tag.metric === metric || tag.id.endsWith(`.${metric}`),
        );
        return index < 0 ? 99 : index;
      };
      return rank(a) - rank(b);
    })
    .slice(0, preferred.length || 3);
}
function svg(tag, attributes = {}) {
  const node = document.createElementNS(svgNs, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  return node;
}
export function renderTop(
  container,
  catalog,
  lines,
  utilities,
  selected,
  select,
  statuses = new Map(),
  topology = new Set(),
) {
  container.replaceChildren();
  const defs = svg("defs");
  const marker = svg("marker", {
    id: "flow-arrow",
    viewBox: "0 0 10 10",
    refX: 9,
    refY: 5,
    markerWidth: 4,
    markerHeight: 4,
    orient: "auto-start-reverse",
  });
  marker.append(svg("path", { d: "M0 0 L10 5 L0 10", fill: "#5b6479" }));
  defs.append(marker);
  container.append(defs);
  const modules = visibleModules(catalog, lines);
  const ids = new Set(modules.map((module) => module.id));
  for (const stream of catalog.streams) {
    if (
      (!utilities && !stream.visible_by_default) ||
      !ids.has(stream.source.module_id) ||
      !ids.has(stream.target.module_id)
    )
      continue;
    container.append(
      svg("polyline", {
        points: stream.route_points_m.map(([x, , z]) => `${x},${z}`).join(" "),
        "marker-end": "url(#flow-arrow)",
      }),
    );
  }
  for (const module of modules) {
    const [x, , z] = module.position;
    const [width, , depth] = module.size;
    const group = svg("g", {
      transform: `translate(${x} ${z}) rotate(${(-(module.rotation[1] ?? 0) * 180) / Math.PI})`,
      class: module.id === selected ? "selected" : "",
    });
    group.setAttribute("data-status", statuses.get(module.id) ?? "unknown");
    if (topology.has(module.id)) group.setAttribute("data-topology", "true");
    const title = svg("title");
    title.textContent = `${module.label} · ${statuses.get(module.id) ?? "unknown"}${topology.has(module.id) ? " · topology context (not proven cause)" : ""}`;
    group.append(
      title,
      svg("rect", { x: -width / 2, y: -depth / 2, width, height: depth, rx: 0.3 }),
    );
    const label = svg("text", { "text-anchor": "middle", y: 0.5 });
    label.textContent = module.kind;
    group.append(label);
    group.addEventListener("click", () => select(module.id));
    container.append(group);
  }
}

export async function createPlant3D(container, catalog, select) {
  const THREE = await import("three");
  const { GLTFLoader } = await import("three/addons/loaders/GLTFLoader.js");
  const { OrbitControls } = await import("three/addons/controls/OrbitControls.js");
  const {
    fitModelToNode,
    fitSplatToNode,
    readBoundedBytes,
    sha256Hex,
    splatFit,
  } = await import("./appearance.js");
  const renderer = new THREE.WebGLRenderer({ antialias: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0xeef1f9);
  container.replaceChildren(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
  camera.position.set(85, 100, 110);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0, 0);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x64748b, 2.4));
  const light = new THREE.DirectionalLight(0xffffff, 2);
  light.position.set(-50, 80, 40);
  scene.add(light);
  const grid = new THREE.GridHelper(100, 10, 0xc5cfe6, 0xdde3f2);
  scene.add(grid);
  const loader = new GLTFLoader();
  const models = new Map();
  const targets = new Map();
  const statusBoxes = new Map();
  const templates = new Map();
  for (const module of catalog.modules) {
    const target = new THREE.Mesh(
      new THREE.BoxGeometry(...module.size),
      new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, transparent: true, opacity: 0 }),
    );
    target.rotation.set(...module.rotation);
    target.position.set(...module.position);
    target.userData.moduleId = module.id;
    scene.add(target);
    targets.set(module.id, target);
    const statusBox = new THREE.BoxHelper(target, 0x64748b);
    statusBox.visible = false;
    scene.add(statusBox);
    statusBoxes.set(module.id, statusBox);
  }
  const streams = [];
  for (const stream of catalog.streams) {
    const points = stream.route_points_m.map((point) => new THREE.Vector3(...point));
    const group = new THREE.Group();
    group.add(
      new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(points),
        new THREE.LineBasicMaterial({ color: 0x64748b }),
      ),
    );
    const last = points.at(-1),
      previous = [...points].reverse().find((point) => point.distanceTo(last) > 0.01);
    if (previous)
      group.add(
        new THREE.ArrowHelper(
          last.clone().sub(previous).normalize(),
          previous,
          previous.distanceTo(last),
          0x64748b,
          1.1,
          0.6,
        ),
      );
    scene.add(group);
    streams.push({ stream, group });
  }
  const selection = new THREE.BoxHelper(undefined, 0x4f46e5);
  selection.visible = false;
  scene.add(selection);
  let enabled = true;
  let disposed = false;
  let activeMode = null;
  let renderedAppearance = null;
  let visualRoot = null;
  let sparkRenderer = null;
  let appearanceController = null;
  let appearanceGeneration = 0;
  const splatMeshes = new Set();
  const splatSources = new Set();
  let selectedModuleId = null;
  let currentLines = new Set(catalog.modules.map((module) => module.line));
  let currentUtilities = false;
  let currentStatuses = new Map();
  let currentTopology = new Set();
  const render = () => {
    if (enabled && !disposed) renderer.render(scene, camera);
  };
  const updateLoop = () => {
    renderer.setAnimationLoop(enabled && activeMode === "reconstructed" ? render : null);
    if (enabled && activeMode !== "reconstructed") render();
  };
  const resize = () => {
    const width = container.clientWidth,
      height = container.clientHeight;
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    render();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  controls.addEventListener("change", render);
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let down;
  const onPointerDown = (event) => {
    down = [event.clientX, event.clientY];
  };
  const onPointerUp = (event) => {
    if (!down || Math.hypot(event.clientX - down[0], event.clientY - down[1]) > 5) return;
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      (-(event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects(
      [...targets.values()].filter((object) => object.visible),
      false,
    )[0];
    if (hit?.object.userData.moduleId) select(hit.object.userData.moduleId);
  };
  renderer.domElement.addEventListener("pointerdown", onPointerDown);
  renderer.domElement.addEventListener("pointerup", onPointerUp);

  function releaseVisual() {
    renderedAppearance = null;
    if (visualRoot) {
      scene.remove(visualRoot);
      visualRoot.clear();
      visualRoot = null;
    }
    for (const mesh of splatMeshes) {
      if (!splatSources.has(mesh)) {
        mesh.splats = undefined;
        mesh.dispose();
      }
    }
    for (const source of splatSources) source.dispose();
    splatMeshes.clear();
    splatSources.clear();
    if (sparkRenderer) {
      scene.remove(sparkRenderer);
      sparkRenderer.dispose();
      sparkRenderer = null;
    }
    models.clear();
  }

  function assertCurrent(generation, signal) {
    if (disposed || signal.aborted || generation !== appearanceGeneration)
      throw new DOMException("Appearance change was canceled.", "AbortError");
  }

  async function loadClean(generation, signal, root) {
    const concepts = [...new Set(catalog.modules.map((module) => module.appearance_concept))];
    await Promise.all(
      concepts.map(async (concept) => {
        if (templates.has(concept)) return;
        const gltf = await loader.loadAsync(
          `/mining/plant/modules/${encodeURIComponent(concept)}.glb`,
        );
        templates.set(concept, gltf.scene);
      }),
    );
    assertCurrent(generation, signal);
    for (const module of catalog.modules) {
      const object = templates.get(module.appearance_concept).clone(true);
      const placement = fitModelToNode(THREE, object, module);
      placement.userData.moduleId = module.id;
      root.add(placement);
      models.set(module.id, placement);
    }
  }

  async function loadReconstructed(generation, signal, root, bundle, showScreenedOut) {
    if (!bundle?.assetsById || !bundle?.moduleBindings)
      throw new Error("Pinned reconstructed asset manifest is unavailable.");
    const { SparkRenderer, SplatMesh } = await import("@sparkjsdev/spark");
    assertCurrent(generation, signal);
    sparkRenderer = new SparkRenderer({ renderer, onDirty: render });
    scene.add(sparkRenderer);
    for (const asset of bundle.assetsById.values()) {
      const placements = [...bundle.moduleBindings.values()].filter(
        ({ module, asset: binding }) => binding.id === asset.id && splatFit(asset, module, showScreenedOut),
      );
      if (!placements.length) continue;
      const expectedPath = `/mining/plant/reconstructed/splats/${asset.localPath.split("/").at(-1)}`;
      if (asset.localPath !== expectedPath)
        throw new Error("Reconstructed asset path is outside the pinned local package.");
      const response = await fetch(expectedPath, {
        signal,
        credentials: "same-origin",
        cache: "force-cache",
        redirect: "error",
      });
      if (!response.ok) throw new Error(`Reconstructed asset request failed (${response.status}).`);
      const bytes = await readBoundedBytes(response, 8 * 1_048_576, signal);
      if (await sha256Hex(bytes) !== asset.sha256)
        throw new Error(`Reconstructed asset integrity check failed for ${asset.id}.`);
      let source;
      for (const [index, { module }] of placements.entries()) {
        assertCurrent(generation, signal);
        const mesh = index === 0
          ? new SplatMesh({ fileBytes: bytes, fileName: expectedPath })
          : new SplatMesh({ splats: source.splats });
        splatMeshes.add(mesh);
        if (index === 0) {
          source = mesh;
          splatSources.add(mesh);
        }
        await mesh.initialized;
        assertCurrent(generation, signal);
        fitSplatToNode(THREE, mesh, asset, module, showScreenedOut);
        mesh.userData.moduleId = module.id;
        root.add(mesh);
        models.set(module.id, mesh);
      }
    }
  }

  function update(lines, utilities, moduleId, statuses = new Map(), topology = new Set()) {
    currentLines = new Set(lines);
    currentUtilities = utilities;
    currentStatuses = new Map(statuses);
    currentTopology = new Set(topology);
    selectedModuleId = moduleId;
    for (const module of catalog.modules) {
      const visible = lines.has(module.line);
      const target = targets.get(module.id);
      target.visible = visible;
      const model = models.get(module.id);
      if (model) model.visible = visible;
      const status = statuses.get(module.id);
      const box = statusBoxes.get(module.id);
      const colors = { warning: 0xb45309, high: 0xdc2626, stopped: 0x5b6479 };
      box.visible = visible && (!!colors[status] || topology.has(module.id) || selectedModuleId === module.id);
      box.material.color.setHex(
        topology.has(module.id)
          ? 0x2563eb
          : selectedModuleId === module.id
            ? 0x4f46e5
            : (colors[status] ?? 0x64748b),
      );
      if (box.visible) box.setFromObject(target);
    }
    for (const { stream, group } of streams)
      group.visible =
        (utilities || stream.visible_by_default) &&
        targets.get(stream.source.module_id).visible &&
        targets.get(stream.target.module_id).visible;
    const selected = targets.get(moduleId);
    selection.visible = !!selected?.visible;
    if (selected) selection.setFromObject(selected);
    resize();
  }

  resize();
  const viewer = {
    get renderedModuleCount() {
      return models.size;
    },
    update,
    async setVisualMode(mode, bundle, showScreenedOut = false, externalSignal) {
      if (disposed) throw new Error("Plant renderer is disposed.");
      if (!["clean", "reconstructed"].includes(mode))
        throw new Error("Unknown plant appearance mode.");
      if (externalSignal?.aborted)
        throw new DOMException("Appearance change was canceled.", "AbortError");
      if (
        renderedAppearance?.mode === mode &&
        (mode === "clean" ||
          (renderedAppearance.bundle === bundle &&
            renderedAppearance.showScreenedOut === showScreenedOut))
      )
        return;
      appearanceController?.abort();
      const controller = new AbortController();
      appearanceController = controller;
      if (externalSignal) {
        if (externalSignal.aborted) controller.abort();
        else externalSignal.addEventListener("abort", () => controller.abort(), { once: true });
      }
      const generation = ++appearanceGeneration;
      releaseVisual();
      activeMode = mode;
      const root = new THREE.Group();
      visualRoot = root;
      scene.add(root);
      try {
        if (mode === "clean") await loadClean(generation, controller.signal, root);
        else await loadReconstructed(generation, controller.signal, root, bundle, showScreenedOut);
        assertCurrent(generation, controller.signal);
        update(currentLines, currentUtilities, selectedModuleId, currentStatuses, currentTopology);
        updateLoop();
        renderedAppearance = { mode, bundle, showScreenedOut };
      } catch (error) {
        if (generation === appearanceGeneration) releaseVisual();
        throw error;
      }
    },
    setEnabled(value) {
      enabled = value;
      controls.enabled = value;
      updateLoop();
      if (enabled) resize();
    },
    dispose() {
      disposed = true;
      appearanceGeneration++;
      appearanceController?.abort();
      renderer.setAnimationLoop(null);
      releaseVisual();
      observer.disconnect();
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.domElement.removeEventListener("pointerup", onPointerUp);
      controls.removeEventListener("change", render);
      controls.dispose();
      disposeThreeResources([scene, ...templates.values()]);
      renderer.dispose();
    },
  };
  try {
    await viewer.setVisualMode("clean");
    return viewer;
  } catch (error) {
    viewer.dispose();
    throw error;
  }
}

function disposeThreeResources(roots) {
  const geometries = new Set();
  const materials = new Set();
  const textures = new Set();
  for (const root of roots) {
    root.traverse((object) => {
      if (object.geometry) geometries.add(object.geometry);
      for (const material of Array.isArray(object.material)
        ? object.material
        : object.material
          ? [object.material]
          : []) {
        materials.add(material);
        for (const value of Object.values(material)) {
          if (value?.isTexture) textures.add(value);
        }
      }
    });
  }
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  for (const texture of textures) texture.dispose();
}
