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
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
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
  const statusBoxes = new Map();
  const templates = new Map();
  // Twelve pinned authored concepts are reused for the twenty-four catalog placements.
  await Promise.all(
    [...new Set(catalog.modules.map((module) => module.appearance_concept))].map(
      async (concept) => {
        const gltf = await loader.loadAsync(
          `/mining/plant/modules/${encodeURIComponent(concept)}.glb`,
        );
        templates.set(concept, gltf.scene);
      },
    ),
  );
  for (const module of catalog.modules) {
    const object = templates.get(module.appearance_concept).clone(true);
    const bounds = new THREE.Box3().setFromObject(object);
    const size = bounds.getSize(new THREE.Vector3());
    if (![size.x, size.y, size.z].every((value) => value > 0))
      throw new Error("Invalid authored mesh bounds.");
    const center = bounds.getCenter(new THREE.Vector3());
    object.position.sub(center);
    const placement = new THREE.Group();
    placement.add(object);
    placement.scale.set(module.size[0] / size.x, module.size[1] / size.y, module.size[2] / size.z);
    placement.rotation.set(...module.rotation);
    placement.position.set(...module.position);
    placement.userData.moduleId = module.id;
    scene.add(placement);
    models.set(module.id, placement);
    const statusBox = new THREE.BoxHelper(placement, 0x64748b);
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
  let selected = null;
  const selection = new THREE.BoxHelper(undefined, 0x4f46e5);
  selection.visible = false;
  scene.add(selection);
  let enabled = true;
  const render = () => {
    if (enabled) renderer.render(scene, camera);
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
  renderer.domElement.addEventListener("pointerdown", (event) => {
    down = [event.clientX, event.clientY];
  });
  renderer.domElement.addEventListener("pointerup", (event) => {
    if (!down || Math.hypot(event.clientX - down[0], event.clientY - down[1]) > 5) return;
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      (-(event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects(
      [...models.values()].filter((object) => object.visible),
      true,
    )[0];
    let node = hit?.object;
    while (node && !node.userData.moduleId) node = node.parent;
    if (node) select(node.userData.moduleId);
  });
  resize();
  return {
    update(lines, utilities, moduleId, statuses = new Map(), topology = new Set()) {
      for (const module of catalog.modules) models.get(module.id).visible = lines.has(module.line);
      const colors = { warning: 0xb45309, high: 0xdc2626, stopped: 0x5b6479 };
      for (const module of catalog.modules) {
        const status = statuses.get(module.id),
          box = statusBoxes.get(module.id);
        box.visible = lines.has(module.line) && (!!colors[status] || topology.has(module.id));
        box.material.color.setHex(
          topology.has(module.id) ? 0x2563eb : (colors[status] ?? 0x64748b),
        );
      }
      for (const { stream, group } of streams)
        group.visible =
          (utilities || stream.visible_by_default) &&
          models.get(stream.source.module_id).visible &&
          models.get(stream.target.module_id).visible;
      selected = models.get(moduleId);
      selection.visible = !!selected?.visible;
      if (selected) selection.setFromObject(selected);
      resize();
    },
    setEnabled(value) {
      enabled = value;
      controls.enabled = value;
      if (enabled) resize();
    },
    dispose() {
      observer.disconnect();
      controls.dispose();
      scene.traverse((object) => {
        object.geometry?.dispose();
        if (Array.isArray(object.material))
          object.material.forEach((material) => material.dispose());
        else object.material?.dispose();
      });
      renderer.dispose();
    },
  };
}
