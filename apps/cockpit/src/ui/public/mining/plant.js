const svgNs = "http://www.w3.org/2000/svg";
const routeColors = { process: 0x64748b, water: 0x2563a6, observed: 0x08765c };
function routeStyle(stream, evidence) {
  return evidence?.measuredRoutes?.has(stream.id)
    ? "observed"
    : stream.material.includes("water")
      ? "water"
      : "process";
}
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
  evidence,
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
        "data-route": routeStyle(stream, evidence),
        "stroke-width": evidence?.measuredRoutes?.get(stream.id)?.width ?? 0.18,
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
    const status = statuses.get(module.id) ?? "unknown";
    group.setAttribute("data-status", status.replaceAll(" ", "-"));
    if (topology.has(module.id)) group.setAttribute("data-topology", "true");
    const title = svg("title");
    title.textContent = `${module.label} · ${status}${status.startsWith("sensor evidence") ? " · freshness/quality only, not equipment health" : ""}${topology.has(module.id) ? " · topology context (not proven cause)" : ""}`;
    group.append(
      title,
      svg("rect", { x: -width / 2, y: -depth / 2, width, height: depth, rx: 0.3 }),
    );
    const label = svg("text", { "text-anchor": "middle", y: 0.5 });
    label.textContent = module.kind;
    group.append(label);
    if (module.kind === "crusher" && evidence?.lineStates?.has(module.line)) {
      const state = evidence.lineStates.get(module.line);
      const marker = svg("circle", {
        cx: -width / 2,
        cy: -depth / 2,
        r: 0.75,
        class: "plant-line-marker",
        "data-line-state": state,
      });
      const markerTitle = svg("title");
      markerTitle.textContent = `Line ${module.line}: ${state} (line controller, not equipment health)`;
      marker.append(markerTitle);
      group.append(marker);
    }
    group.addEventListener("click", () => select(module.id));
    container.append(group);
    const reading = evidence?.readings.get(module.id);
    if (reading && (reading.current || module.id === selected)) {
      const badge = svg("text", {
        x,
        y: z - depth / 2 - 1,
        "text-anchor": "middle",
        class: "plant-svg-reading",
        "data-current": reading.current,
      });
      badge.textContent = reading.label;
      container.append(badge);
    }
  }
}

export async function createPlant3D(container, catalog, select) {
  const THREE = await import("three");
  const { GLTFLoader } = await import("three/addons/loaders/GLTFLoader.js");
  const { OrbitControls } = await import("three/addons/controls/OrbitControls.js");
  const { fitModelToNode, fitSplatToNode, readBoundedBytes, sha256Hex, splatFit } =
    await import("./appearance.js");
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0xeef1f9);
  container.replaceChildren(renderer.domElement);
  let overlay;
  const badges = new Map();
  const renderedBadges = [];
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
  camera.position.set(85, 100, 110);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.minDistance = 20;
  controls.maxDistance = 250;
  controls.maxPolarAngle = Math.PI / 2.05;
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
      new THREE.MeshBasicMaterial({
        colorWrite: false,
        depthWrite: false,
        transparent: true,
        opacity: 0,
      }),
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
    const measured = new THREE.Group();
    for (let i = 1; i < points.length; i++) {
      const length = points[i].distanceTo(points[i - 1]);
      if (length < 0.01) continue;
      const segment = new THREE.Mesh(
        new THREE.CylinderGeometry(1, 1, length, 8),
        new THREE.MeshBasicMaterial({ color: routeColors.observed }),
      );
      segment.position
        .copy(points[i - 1])
        .add(points[i])
        .multiplyScalar(0.5);
      segment.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        points[i]
          .clone()
          .sub(points[i - 1])
          .normalize(),
      );
      measured.add(segment);
    }
    measured.visible = false;
    group.add(measured);
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
    streams.push({ stream, group, measured });
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
  let currentEvidence;
  const position = new THREE.Vector3();
  const cameraSpace = new THREE.Vector3();
  function projectReadings() {
    const width = container.clientWidth,
      height = container.clientHeight;
    renderedBadges.length = 0;
    for (const [id, badge] of badges) {
      const target = targets.get(id);
      position.copy(target.position);
      position.y += target.geometry.parameters.height / 2 + 1;
      cameraSpace.copy(position).applyMatrix4(camera.matrixWorldInverse);
      position.project(camera);
      const x = ((position.x + 1) * width) / 2;
      const y = ((1 - position.y) * height) / 2;
      // Selected equipment wins collisions; clips and overlaps are omitted, not relocated.
      const offset = badge.offsetWidth / 2;
      const visible =
        target.visible &&
        cameraSpace.z < -camera.near &&
        Math.abs(position.z) < 1 &&
        x - offset > 4 &&
        x + offset < width - 4 &&
        y > 24 &&
        y < height &&
        !renderedBadges.some(
          (item) => Math.abs(item.x - x) < item.offset + offset + 5 && Math.abs(item.y - y) < 24,
        );
      badge.style.visibility = visible ? "visible" : "hidden";
      if (!visible) continue;
      badge.style.left = `${x}px`;
      badge.style.top = `${y}px`;
      renderedBadges.push({ x, y, offset });
    }
  }
  const render = () => {
    if (enabled && !disposed) {
      renderer.render(scene, camera);
      projectReadings();
    }
  };
  const updateLoop = () => {
    renderer.setAnimationLoop(enabled && activeMode === "reconstructed" ? render : null);
    if (enabled && activeMode !== "reconstructed") render();
  };
  let framed = false;
  const fit = () => {
    const bounds = new THREE.Box3();
    const boxes = [...targets.values()].map((target) => new THREE.Box3().setFromObject(target));
    for (const box of boxes) bounds.union(box);
    const center = bounds.getCenter(new THREE.Vector3());
    const direction = new THREE.Vector3(0.45, 1.18, 1.15).normalize();
    camera.position.copy(center).add(direction);
    camera.lookAt(center);
    const inverse = camera.quaternion.clone().invert();
    const vertical = Math.tan((camera.fov * Math.PI) / 360);
    const horizontal = vertical * camera.aspect;
    let distance = 0;
    for (const box of boxes)
      for (const x of [box.min.x, box.max.x])
        for (const y of [box.min.y, box.max.y])
          for (const z of [box.min.z, box.max.z]) {
            const point = new THREE.Vector3(x, y, z).sub(center).applyQuaternion(inverse);
            distance = Math.max(
              distance,
              Math.abs(point.x) / horizontal + point.z,
              Math.abs(point.y) / vertical + point.z,
            );
          }
    camera.position.copy(center).addScaledVector(direction, distance * 1.24);
    controls.target.copy(center);
    controls.update();
    render();
  };
  const resize = () => {
    const width = container.clientWidth,
      height = container.clientHeight;
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    if (!framed) {
      framed = true;
      fit();
    }
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
        ({ module, asset: binding }) =>
          binding.id === asset.id && splatFit(asset, module, showScreenedOut),
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
      if ((await sha256Hex(bytes)) !== asset.sha256)
        throw new Error(`Reconstructed asset integrity check failed for ${asset.id}.`);
      let source;
      for (const [index, { module }] of placements.entries()) {
        assertCurrent(generation, signal);
        const mesh =
          index === 0
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

  function update(
    lines,
    utilities,
    moduleId,
    statuses = new Map(),
    topology = new Set(),
    evidence,
  ) {
    currentLines = new Set(lines);
    currentUtilities = utilities;
    currentStatuses = new Map(statuses);
    currentTopology = new Set(topology);
    currentEvidence = evidence;
    selectedModuleId = moduleId;
    for (const module of catalog.modules) {
      const visible = lines.has(module.line);
      const target = targets.get(module.id);
      target.visible = visible;
      const model = models.get(module.id);
      if (model) model.visible = visible;
      const status = statuses.get(module.id);
      const box = statusBoxes.get(module.id);
      const colors = {
        warning: 0xb45309,
        high: 0xdc2626,
        stopped: 0x5b6479,
      };
      box.visible =
        visible && (!!colors[status] || topology.has(module.id) || selectedModuleId === module.id);
      box.material.color.setHex(
        topology.has(module.id)
          ? 0x2563eb
          : selectedModuleId === module.id
            ? 0x4f46e5
            : (colors[status] ?? 0x64748b),
      );
      if (box.visible) box.setFromObject(target);
    }
    for (const { stream, group, measured } of streams) {
      group.visible =
        (utilities || stream.visible_by_default) &&
        targets.get(stream.source.module_id).visible &&
        targets.get(stream.target.module_id).visible;
      const color = routeColors[routeStyle(stream, evidence)];
      group.children[0].material.color.setHex(color);
      group.children[2]?.setColor(color);
      const rate = evidence?.measuredRoutes?.get(stream.id);
      measured.visible = !!rate;
      for (const segment of measured.children) {
        segment.scale.set(rate ? rate.width / 2 : 1, 1, rate ? rate.width / 2 : 1);
      }
    }
    badges.clear();
    overlay?.replaceChildren();
    const labels = [...(evidence?.readings ?? [])].filter(
      ([id, reading]) => reading.current || id === moduleId,
    );
    for (const [line, state] of evidence?.lineStates ?? []) {
      const id = `D01.${line}.crusher`;
      const existing = labels.find(([key]) => key === id);
      if (existing) existing[1] = { ...existing[1], line, state };
      else labels.push([id, { line, state, current: false, label: "" }]);
    }
    if (labels.length && !overlay) {
      overlay = document.createElement("div");
      overlay.className = "plant-overlays";
      overlay.setAttribute("aria-hidden", "true");
      container.append(overlay);
    }
    labels.sort(([a], [b]) => Number(b === moduleId) - Number(a === moduleId));
    for (const [id, reading] of labels) {
      const badge = document.createElement("span");
      badge.className = "plant-reading";
      badge.dataset.current = String(reading.current);
      if (reading.line) badge.dataset.lineState = reading.state;
      badge.textContent = reading.line
        ? `Line ${reading.line} ${reading.state}${reading.label ? ` · ${reading.label}` : ""}`
        : reading.label;
      badges.set(id, badge);
      overlay.append(badge);
    }
    const selected = targets.get(moduleId);
    selection.visible = !!selected?.visible;
    if (selected) selection.setFromObject(selected);
    resize();
  }

  resize();
  const viewer = {
    fit,
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
        update(
          currentLines,
          currentUtilities,
          selectedModuleId,
          currentStatuses,
          currentTopology,
          currentEvidence,
        );
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
      overlay?.remove();
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
