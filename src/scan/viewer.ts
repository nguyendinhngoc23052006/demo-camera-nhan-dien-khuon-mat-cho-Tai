// Shows a finished room scan: an orbitable 3D model (three.js) or a top-down plan (2D canvas).
import {
  AmbientLight,
  BoxGeometry,
  BufferGeometry,
  Color,
  DirectionalLight,
  Float32BufferAttribute,
  InstancedMesh,
  Line,
  LineBasicMaterial,
  Matrix4,
  MeshLambertMaterial,
  PerspectiveCamera,
  Scene,
  WebGLRenderer,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  columnKey,
  estimateFloorY,
  floorPlan,
  type RoomScan,
  VOXEL_SIZE,
  voxelCentre,
} from "./map";

export type ViewMode = "3d" | "map";

// Height colours: floor stone → furniture sage → walls slate.
const FLOOR = new Color("#d8cfbd");
const LOW = new Color("#8fbf9f");
const HIGH = new Color("#7d9cc4");
const PATH = "#3ddc84";

export interface Viewer {
  show(scan: RoomScan): void;
  setMode(mode: ViewMode): void;
  dispose(): void;
}

export function createViewer(model: HTMLCanvasElement, plan: HTMLCanvasElement): Viewer {
  const renderer = new WebGLRenderer({ canvas: model, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  const scene = new Scene();
  scene.add(new AmbientLight("#ffffff", 1.4));
  const sun = new DirectionalLight("#ffffff", 1.6);
  sun.position.set(3, 6, 2);
  scene.add(sun);
  const camera = new PerspectiveCamera(55, 1, 0.05, 100);
  const controls = new OrbitControls(camera, model);
  controls.enableDamping = false;
  controls.addEventListener("change", render);

  let mode: ViewMode = "3d";
  let current: RoomScan | null = null;
  let disposables: { dispose(): void }[] = [];

  function render(): void {
    renderer.render(scene, camera);
  }

  function resize(): void {
    const { clientWidth: w, clientHeight: h } = model;
    if (w === 0 || h === 0) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    render();
    if (mode === "map" && current) drawPlan(plan, current);
  }
  const observer = new ResizeObserver(resize);
  observer.observe(model);
  observer.observe(plan);

  function clear(): void {
    for (const d of disposables) d.dispose();
    disposables = [];
    for (const child of [...scene.children]) {
      if (child instanceof InstancedMesh || child instanceof Line) scene.remove(child);
    }
  }

  return {
    show(scan: RoomScan): void {
      clear();
      current = scan;
      const floorY = estimateFloorY(scan.voxels) ?? 0;
      const box = new BoxGeometry(VOXEL_SIZE * 0.92, VOXEL_SIZE * 0.92, VOXEL_SIZE * 0.92);
      const material = new MeshLambertMaterial();
      const mesh = new InstancedMesh(box, material, Math.max(1, scan.voxels.length));
      mesh.count = scan.voxels.length;
      const matrix = new Matrix4();
      const colour = new Color();
      const min = [Infinity, Infinity, Infinity];
      const max = [-Infinity, -Infinity, -Infinity];
      scan.voxels.forEach(([i, j, k], n) => {
        const [x, y, z] = voxelCentre(i, j, k);
        matrix.makeTranslation(x, y, z);
        mesh.setMatrixAt(n, matrix);
        const height = y - floorY;
        if (height < VOXEL_SIZE * 1.5) colour.copy(FLOOR);
        else colour.lerpColors(LOW, HIGH, Math.min(1, height / 2));
        mesh.setColorAt(n, colour);
        for (const [a, v] of [x, y, z].entries()) {
          min[a] = Math.min(min[a] as number, v);
          max[a] = Math.max(max[a] as number, v);
        }
      });
      scene.add(mesh);
      disposables.push(box, material);

      if (scan.path.length > 1) {
        const geometry = new BufferGeometry();
        geometry.setAttribute("position", new Float32BufferAttribute(scan.path.flat(), 3));
        const line = new Line(geometry, new LineBasicMaterial({ color: PATH }));
        scene.add(line);
        disposables.push(geometry, line.material);
      }

      // Frame the whole room from above one corner.
      const centre = [0, 1, 2].map((a) => ((min[a] as number) + (max[a] as number)) / 2);
      const size = Math.max(...[0, 1, 2].map((a) => (max[a] as number) - (min[a] as number)), 1);
      const [cx = 0, cy = 0, cz = 0] = centre;
      controls.target.set(cx, cy, cz);
      camera.position.set(cx + size * 0.7, cy + size * 0.9, cz + size * 0.9);
      controls.update();
      resize();
    },

    setMode(next: ViewMode): void {
      mode = next;
      model.hidden = next !== "3d";
      plan.hidden = next !== "map";
      resize();
    },

    dispose(): void {
      observer.disconnect();
      clear();
      controls.dispose();
      renderer.dispose();
    },
  };
}

/** Top-down plan: seen floor, obstacles between knee and head height, and the walked path. */
function drawPlan(canvas: HTMLCanvasElement, scan: RoomScan): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const ratio = Math.min(window.devicePixelRatio, 2);
  canvas.width = Math.round(canvas.clientWidth * ratio);
  canvas.height = Math.round(canvas.clientHeight * ratio);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const plan = floorPlan(scan.voxels, estimateFloorY(scan.voxels) ?? 0);
  if (!plan) return;

  const cols = plan.maxI - plan.minI + 1;
  const rows = plan.maxK - plan.minK + 1;
  const pad = 16 * ratio;
  const cell = Math.min((canvas.width - 2 * pad) / cols, (canvas.height - 2 * pad) / rows);
  const left = (canvas.width - cols * cell) / 2;
  const top = (canvas.height - rows * cell) / 2;
  const toX = (x: number) => left + (x / VOXEL_SIZE - plan.minI) * cell;
  const toY = (z: number) => top + (z / VOXEL_SIZE - plan.minK) * cell;

  const css = getComputedStyle(canvas);
  const floorColour = css.getPropertyValue("--plan-floor").trim() || "#3a3934";
  const wallColour = css.getPropertyValue("--plan-wall").trim() || "#f4f3ef";
  for (let i = plan.minI; i <= plan.maxI; i++) {
    for (let k = plan.minK; k <= plan.maxK; k++) {
      const key = columnKey(i, k);
      const wall = plan.obstacles.has(key);
      if (!wall && !plan.floor.has(key)) continue;
      ctx.fillStyle = wall ? wallColour : floorColour;
      ctx.fillRect(
        left + (i - plan.minI) * cell,
        top + (k - plan.minK) * cell,
        cell + 0.5,
        cell + 0.5,
      );
    }
  }

  const [start] = scan.path;
  if (scan.path.length > 1) {
    ctx.strokeStyle = PATH;
    ctx.lineWidth = 2.5 * ratio;
    ctx.lineJoin = "round";
    ctx.beginPath();
    scan.path.forEach(([x, , z], n) => {
      if (n === 0) ctx.moveTo(toX(x), toY(z));
      else ctx.lineTo(toX(x), toY(z));
    });
    ctx.stroke();
  }
  if (start) {
    ctx.fillStyle = PATH;
    ctx.beginPath();
    ctx.arc(toX(start[0]), toY(start[2]), 5 * ratio, 0, Math.PI * 2);
    ctx.fill();
  }
}
