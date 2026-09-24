import { describe, expect, it } from "vitest";
import { EXTRAPOLATION_MARGIN, floorHits, snapshotPoints } from "./align";
import {
  columnKey,
  estimateFloorY,
  floorPlan,
  invert,
  MAX_RANGE,
  MIN_HITS,
  MIN_RANGE,
  OBSTACLE_MIN_HEIGHT,
  transformPoint,
  turnAngle,
  unproject,
  type Vec3,
  VOXEL_SIZE,
  VoxelMap,
  voxelCentre,
  voxelIndex,
  voxelKey,
  voxelOf,
} from "./map";

// --- a tiny camera model, column-major like WebXR ---------------------------------------------

const FOV_Y = (60 * Math.PI) / 180;
const ASPECT = 4 / 3;
const NEAR = 0.1;
const FAR = 20;

function perspective(): number[] {
  const f = 1 / Math.tan(FOV_Y / 2);
  return [
    f / ASPECT,
    0,
    0,
    0,
    0,
    f,
    0,
    0,
    0,
    0,
    (FAR + NEAR) / (NEAR - FAR),
    -1,
    0,
    0,
    (2 * FAR * NEAR) / (NEAR - FAR),
    0,
  ];
}

function invPerspective(): number[] {
  const f = 1 / Math.tan(FOV_Y / 2);
  const a = (FAR + NEAR) / (NEAR - FAR);
  const b = (2 * FAR * NEAR) / (NEAR - FAR);
  return [ASPECT / f, 0, 0, 0, 0, 1 / f, 0, 0, 0, 0, 0, 1 / b, 0, 0, -1, a / b];
}

/** Rotation Ry(yaw)·Rx(pitch) as rows, i.e. the camera looks along -z turned by yaw, tilted by pitch. */
function rotation(yaw: number, pitch: number): number[][] {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  return [
    [cy, sy * sp, sy * cp],
    [0, cp, -sp],
    [-sy, cy * sp, cy * cp],
  ];
}

/** Camera pose (view → world), column-major. */
function pose(yaw: number, pos: Vec3, pitch = 0): number[] {
  const r = rotation(yaw, pitch);
  const at = (row: number, col: number) => (r[row] as number[])[col] as number;
  return [
    at(0, 0),
    at(1, 0),
    at(2, 0),
    0,
    at(0, 1),
    at(1, 1),
    at(2, 1),
    0,
    at(0, 2),
    at(1, 2),
    at(2, 2),
    0,
    pos[0],
    pos[1],
    pos[2],
    1,
  ];
}

/** World → view: the transposed rotation and the rotated, negated position. */
function invPose(yaw: number, pos: Vec3, pitch = 0): number[] {
  const r = rotation(yaw, pitch);
  const at = (row: number, col: number) => (r[row] as number[])[col] as number;
  const t = [0, 1, 2].map((c) => -(at(0, c) * pos[0] + at(1, c) * pos[1] + at(2, c) * pos[2]));
  return [
    at(0, 0),
    at(0, 1),
    at(0, 2),
    0,
    at(1, 0),
    at(1, 1),
    at(1, 2),
    0,
    at(2, 0),
    at(2, 1),
    at(2, 2),
    0,
    t[0] as number,
    t[1] as number,
    t[2] as number,
    1,
  ];
}

// --- a simulated room: walls/floor/ceiling plus a table ---------------------------------------

const ROOM = { min: [-2, 0, -1.5] as Vec3, max: [2, 2.5, 1.5] as Vec3 };
const TABLE = { min: [0.4, 0, -1.2] as Vec3, max: [1.4, 0.75, -0.6] as Vec3 };

/** Distance along a ray to the first surface: inside the room box, or the outside of the table. */
function raycast(origin: Vec3, dir: Vec3): number {
  let best = Number.POSITIVE_INFINITY;
  for (let a = 0; a < 3; a++) {
    const d = dir[a] as number;
    if (d === 0) continue;
    const wall = d > 0 ? ROOM.max[a] : ROOM.min[a];
    const t = ((wall as number) - (origin[a] as number)) / d;
    if (t > 0) best = Math.min(best, t);
  }
  // Slab test against the table.
  let tNear = Number.NEGATIVE_INFINITY;
  let tFar = Number.POSITIVE_INFINITY;
  for (let a = 0; a < 3; a++) {
    const d = dir[a] as number;
    const o = origin[a] as number;
    const lo = TABLE.min[a] as number;
    const hi = TABLE.max[a] as number;
    if (d === 0) {
      if (o < lo || o > hi) return best;
      continue;
    }
    const t1 = (lo - o) / d;
    const t2 = (hi - o) / d;
    tNear = Math.max(tNear, Math.min(t1, t2));
    tFar = Math.min(tFar, Math.max(t1, t2));
  }
  if (tNear <= tFar && tNear > 0) best = Math.min(best, tNear);
  return best;
}

/** Distance from a point to the nearest simulated surface. */
function surfaceDistance(p: Vec3): number {
  const room = Math.min(
    ...[0, 1, 2].flatMap((a) => [
      Math.abs((p[a] as number) - (ROOM.min[a] as number)),
      Math.abs((p[a] as number) - (ROOM.max[a] as number)),
    ]),
  );
  // Distance to the table box surface (outside or inside).
  const d = [0, 1, 2].map((a) =>
    Math.max(
      (TABLE.min[a] as number) - (p[a] as number),
      0,
      (p[a] as number) - (TABLE.max[a] as number),
    ),
  );
  const outside = Math.hypot(...d);
  const inside = Math.min(
    ...[0, 1, 2].flatMap((a) => [
      Math.abs((p[a] as number) - (TABLE.min[a] as number)),
      Math.abs((p[a] as number) - (TABLE.max[a] as number)),
    ]),
  );
  const isInside = d.every((x) => x === 0);
  return Math.min(room, isInside ? inside : outside);
}

/** Simulates a phone scan: someone walks to a few spots and sweeps the phone round, level and tilted down. */
function scanRoom(steps: number, cols = 48, rows = 36): Vec3[] {
  const map = new VoxelMap();
  const inv = invPerspective();
  const spots: Vec3[] = [
    [-1.2, 1.4, 0.8],
    [-0.4, 1.4, 0.2],
    [0.9, 1.4, 0.7],
  ];
  for (const eye of spots) {
    for (const pitch of [0, -0.6]) {
      for (let f = 0; f < steps; f++) {
        const viewToWorld = pose((f / steps) * Math.PI * 2, eye, pitch);
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            const u = (c + 0.5) / cols;
            const v = (r + 0.5) / rows;
            // Ray for this sample in view space, then world space.
            const near = transformPoint(inv, 2 * u - 1, 1 - 2 * v, -1);
            const len = Math.hypot(...near);
            const dirView: Vec3 = [near[0] / len, near[1] / len, near[2] / len];
            const tip = transformPoint(viewToWorld, dirView[0], dirView[1], dirView[2]);
            const dirWorld: Vec3 = [tip[0] - eye[0], tip[1] - eye[1], tip[2] - eye[2]];
            const t = raycast(eye, dirWorld);
            // WebXR depth is the distance from the view plane, i.e. along the forward (-z) axis.
            const depth = t * -dirView[2];
            const p = unproject(u, v, depth, inv, viewToWorld);
            if (p) map.add(p[0], p[1], p[2]);
          }
        }
      }
    }
  }
  return [...map.confirmed()];
}

// --- tests --------------------------------------------------------------------------------------

describe("unproject", () => {
  it("round-trips a projected world point", () => {
    const proj = perspective();
    const yaw = 0.7;
    const pitch = -0.4;
    const eye: Vec3 = [0.5, 1.2, -0.3];
    const world: Vec3 = [1.1, 0.4, -2.4];
    const view = transformPoint(invPose(yaw, eye, pitch), ...world);
    const ndc = transformPoint(proj, ...view);
    const u = (ndc[0] + 1) / 2;
    const v = (1 - ndc[1]) / 2;
    const p = unproject(u, v, -view[2], invPerspective(), pose(yaw, eye, pitch));
    expect(p).not.toBeNull();
    (p as Vec3).forEach((value, a) => {
      expect(value).toBeCloseTo(world[a] as number, 9);
    });
  });

  it("puts the top-left of the view up and to the left", () => {
    const p = unproject(0, 0, 1, invPerspective(), pose(0, [0, 0, 0])) as Vec3;
    expect(p[0]).toBeLessThan(0);
    expect(p[1]).toBeGreaterThan(0);
    expect(p[2]).toBeCloseTo(-1, 9);
  });

  it("ignores depth outside the trusted range and invalid readings", () => {
    const args = [invPerspective(), pose(0, [0, 0, 0])] as const;
    expect(unproject(0.5, 0.5, MIN_RANGE - 0.01, ...args)).toBeNull();
    expect(unproject(0.5, 0.5, MAX_RANGE + 0.01, ...args)).toBeNull();
    expect(unproject(0.5, 0.5, 0, ...args)).toBeNull();
    expect(unproject(0.5, 0.5, Number.NaN, ...args)).toBeNull();
    expect(unproject(0.5, 0.5, MIN_RANGE, ...args)).not.toBeNull();
  });
});

describe("voxel keys", () => {
  it("round-trips negative and positive indices", () => {
    for (const idx of [
      [0, 0, 0],
      [-1, -1, -1],
      [123, -456, 789],
      [-32768, 32767, -5],
    ] as Vec3[]) {
      expect(voxelIndex(voxelKey(...idx))).toEqual(idx);
    }
  });

  it("puts a point into the voxel whose box contains it", () => {
    const [i, j, k] = voxelOf(-0.01, 0.07, 0.049);
    expect([i, j, k]).toEqual([-1, 1, 0]);
    const c = voxelCentre(i, j, k);
    expect(c[0]).toBeCloseTo(-VOXEL_SIZE / 2, 9);
  });
});

describe("VoxelMap", () => {
  it("confirms a voxel only on its MIN_HITS-th hit", () => {
    const map = new VoxelMap();
    for (let n = 1; n < MIN_HITS; n++) expect(map.add(0.01, 0.01, 0.01)).toBe("added");
    expect(map.add(0.02, 0.02, 0.02)).toBe("confirmed");
    expect(map.add(0.03, 0.03, 0.03)).toBe("added");
    expect(map.size).toBe(1);
    expect([...map.confirmed()]).toEqual([[0, 0, 0]]);
  });
});

describe("scanning a simulated room", () => {
  const voxels = scanRoom(24);

  it("builds a substantial map", () => {
    expect(voxels.length).toBeGreaterThan(2000);
  });

  it("puts rebuilt voxels on the real surfaces", () => {
    const off = voxels.filter((v) => surfaceDistance(voxelCentre(...v)) > VOXEL_SIZE * 1.5);
    expect(off.length / voxels.length).toBeLessThan(0.01);
  });

  it("shows the table as an obstacle and open floor around it on the plan", () => {
    const plan = floorPlan(voxels);
    expect(plan).not.toBeNull();
    const at = (x: number, z: number) => {
      const [i, , k] = voxelOf(x, 0, z);
      return columnKey(i, k);
    };
    expect(plan?.obstacles.has(at(0.9, -0.9))).toBe(true);
    expect(plan?.obstacles.has(at(-0.2, 0.9))).toBe(false);
    expect(plan?.floor.has(at(-0.2, 0.9))).toBe(true);
    // Walls bound the plan, give or take the voxel a wall-plane point rounds into.
    const slack = VOXEL_SIZE + 1e-9;
    expect(Math.abs((plan?.minI ?? 0) * VOXEL_SIZE - ROOM.min[0])).toBeLessThanOrEqual(slack);
    expect(Math.abs(((plan?.maxI ?? 0) + 1) * VOXEL_SIZE - ROOM.max[0])).toBeLessThanOrEqual(slack);
  });

  it("returns no plan for an empty scan", () => {
    expect(floorPlan([])).toBeNull();
  });
});

describe("invert", () => {
  it("inverts the projection and a pose", () => {
    const check = (m: number[], expected: number[]) => {
      const inv = invert(m);
      expect(inv).not.toBeNull();
      (inv as number[]).forEach((value, i) => {
        expect(value).toBeCloseTo(expected[i] as number, 9);
      });
    };
    check(perspective(), invPerspective());
    check(pose(0.8, [1, 2, 3], -0.3), invPose(0.8, [1, 2, 3], -0.3));
  });

  it("returns null for a singular matrix", () => {
    expect(invert(new Array(16).fill(0))).toBeNull();
  });
});

describe("estimateFloorY", () => {
  it("finds the simulated room's floor, not its ceiling", () => {
    const floor = estimateFloorY(scanRoom(12)) ?? Number.NaN;
    expect(Math.abs(floor - ROOM.min[1])).toBeLessThanOrEqual(VOXEL_SIZE + 1e-9);
  });

  it("returns null for an empty scan", () => {
    expect(estimateFloorY([])).toBeNull();
  });
});

describe("turnAngle", () => {
  it("measures turning and tilting between two poses, ignoring position", () => {
    expect(turnAngle(pose(0, [0, 0, 0]), pose(0, [5, 1, 2]))).toBeCloseTo(0, 9);
    expect(turnAngle(pose(0, [0, 0, 0]), pose(Math.PI / 6, [0, 0, 0]))).toBeCloseTo(30, 9);
    expect(turnAngle(pose(0.3, [0, 0, 0]), pose(0.3, [0, 0, 0], -Math.PI / 4))).toBeCloseTo(45, 9);
  });
});

describe("snapshotPoints on the simulated room", () => {
  // A camera image's depth estimate: true inverse depth under an unknown scale and shift.
  const SIZE = 160;
  const SCALE = 0.42;
  const SHIFT = -0.03;
  const eye: Vec3 = [-0.4, 1.4, 0.2];
  const viewToWorld = pose(-2.4, eye, -0.35); // facing the table
  const inv = invPerspective();
  const rayDepth = (u: number, v: number) => {
    const near = transformPoint(inv, 2 * u - 1, 1 - 2 * v, -1);
    const len = Math.hypot(...near);
    const dirView: Vec3 = [near[0] / len, near[1] / len, near[2] / len];
    const tip = transformPoint(viewToWorld, ...dirView);
    const t = raycast(eye, [tip[0] - eye[0], tip[1] - eye[1], tip[2] - eye[2]]);
    return t * -dirView[2];
  };
  const disp = new Float32Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      disp[y * SIZE + x] = (1 / rayDepth((x + 0.5) / SIZE, (y + 0.5) / SIZE) - SHIFT) / SCALE;
    }
  }
  // Hit tests: a 5×4 fan of rays, like scanner.ts.
  const hits: Vec3[] = [];
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 5; c++) {
      const u = 0.1 + 0.2 * c;
      const v = 0.12 + 0.25 * r;
      const p = unproject(u, v, rayDepth(u, v), inv, viewToWorld);
      if (p) hits.push(p);
    }
  }
  const snapshot = { disp, size: SIZE, viewToWorld, projection: perspective() };

  it("recovers the depth scale from the hits", () => {
    const result = snapshotPoints(snapshot, hits);
    expect(result?.fit.scale).toBeCloseTo(SCALE, 2);
  });

  it("puts the snapshot's points on the real surfaces", () => {
    const points = snapshotPoints(snapshot, hits)?.points ?? [];
    expect(points.length).toBeGreaterThan(1000);
    const off = points.filter((p) => surfaceDistance(p) > VOXEL_SIZE * 1.5);
    expect(off.length / points.length).toBeLessThan(0.05);
  });

  it("drops points beyond the distances it was fitted on", () => {
    // Only hits on the near half of the picture: far parts of the room must not be extrapolated.
    const near = hits.filter((h) => Math.hypot(h[0] - eye[0], h[2] - eye[2]) < 2.2);
    const result = snapshotPoints(snapshot, near);
    const limit = (result?.fit.far ?? 0) * (1 + EXTRAPOLATION_MARGIN);
    const view = invert(snapshot.viewToWorld) as number[];
    const depths = (result?.points ?? []).map((p) => -transformPoint(view, ...p)[2]);
    expect(depths.length).toBeGreaterThan(0);
    expect(Math.max(...depths)).toBeLessThanOrEqual(limit + 1e-9);
  });

  it("fills surfaces with connected blocks, not a sparse lattice", () => {
    // One snapshot is all a direction gets in a one-spot scan: its points must cover surfaces
    // densely enough that each shown block has neighbours, and stray points must not show.
    const map = new VoxelMap();
    for (const p of snapshotPoints(snapshot, hits)?.points ?? []) map.add(...p);
    const shown = [...map.confirmed()];
    const keys = new Set(shown.map((v) => voxelKey(...v)));
    const isolated = shown.filter(([i, j, k]) => {
      for (let a = -1; a <= 1; a++)
        for (let b = -1; b <= 1; b++)
          for (let c = -1; c <= 1; c++)
            if ((a || b || c) && keys.has(voxelKey(i + a, j + b, k + c))) return false;
      return true;
    });
    expect(shown.length).toBeGreaterThan(2000);
    expect(isolated.length / shown.length).toBeLessThan(0.02);
  });

  it("gives up when too few hits land in the picture", () => {
    expect(snapshotPoints(snapshot, hits.slice(0, 3))).toBeNull();
  });

  it("finds the scale from the floor alone, with the table in the way (one-spot scan)", () => {
    const floor = floorHits(viewToWorld, perspective());
    expect(floor.every((h) => h[1] === 0)).toBe(true);
    // Rays that meet the table or a wall's foot first sit just nearer than the floor: tolerated.
    const result = snapshotPoints(snapshot, floor, true);
    expect(Math.abs((result?.fit.scale ?? 0) / SCALE - 1)).toBeLessThan(0.03);
    const points = result?.points ?? [];
    expect(points.length).toBeGreaterThan(1000);
    const off = points.filter((p) => surfaceDistance(p) > VOXEL_SIZE * 2);
    expect(off.length / points.length).toBeLessThan(0.05);
    // Nothing lies beyond the floor, and floor-level noise lies exactly on it.
    expect(points.filter((p) => p[1] < 0 || (p[1] > 0 && p[1] < OBSTACLE_MIN_HEIGHT))).toEqual([]);
  });
});
