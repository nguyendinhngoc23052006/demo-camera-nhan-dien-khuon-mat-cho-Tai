import { describe, expect, it } from "vitest";
import {
  fitInverseDepth,
  MIN_DEPTH_RATIO,
  MIN_FIT_POINTS,
  metricDepth,
  projectToView,
} from "./align";
import { invert, unproject, type Vec3 } from "./map";

// A model that predicts inverse depth with an unknown scale and shift.
const TRUE = { scale: 0.37, shift: -0.05 };
const predict = (depth: number) => (1 / depth - TRUE.shift) / TRUE.scale;

describe("fitInverseDepth", () => {
  it("recovers scale and shift from exact samples", () => {
    const samples = [0.8, 1.1, 1.6, 2.2, 2.9, 3.5, 4.1].map((d) => ({
      pred: predict(d),
      depth: d,
    }));
    const fit = fitInverseDepth(samples);
    expect(fit?.scale).toBeCloseTo(TRUE.scale, 9);
    expect(fit?.shift).toBeCloseTo(TRUE.shift, 9);
    for (const d of [0.5, 1.3, 3.8])
      expect(metricDepth(predict(d), fit as never)).toBeCloseTo(d, 9);
  });

  it("ignores a couple of wild outliers", () => {
    const samples = [0.8, 1.1, 1.6, 2.2, 2.9, 3.5, 4.1, 1.9, 2.5, 3.1].map((d) => ({
      pred: predict(d),
      depth: d,
    }));
    samples[2] = { pred: predict(0.5), depth: 3.9 }; // hit on a far wall, model saw a near chair
    samples[7] = { pred: predict(4), depth: 0.9 };
    const fit = fitInverseDepth(samples);
    expect(metricDepth(predict(2), fit as never)).toBeCloseTo(2, 9);
  });

  it("refuses too few points or points all at one distance", () => {
    const few = Array.from({ length: MIN_FIT_POINTS - 1 }, (_, i) => 1 + i).map((d) => ({
      pred: predict(d),
      depth: d,
    }));
    expect(fitInverseDepth(few)).toBeNull();
    const flat = Array.from({ length: 8 }, (_, i) => {
      const d = 2 + (i % 2) * (2 * MIN_DEPTH_RATIO - 2.01) * 0.01;
      return { pred: predict(d), depth: d };
    });
    expect(fitInverseDepth(flat)).toBeNull();
  });

  it("refuses a fit that makes nearer things farther", () => {
    const backwards = [0.8, 1.1, 1.6, 2.2, 2.9, 3.5].map((d) => ({ pred: -predict(d), depth: d }));
    expect(fitInverseDepth(backwards)).toBeNull();
  });
});

describe("projectToView", () => {
  // Same camera conventions as map.test.ts: a 60° perspective looking along -z.
  const f = 1 / Math.tan(Math.PI / 6);
  const proj = [f / (4 / 3), 0, 0, 0, 0, f, 0, 0, 0, 0, -1.01, -1, 0, 0, -0.201, 0];
  const pose = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.4, 1.5, -0.2, 1];

  it("is the inverse of unproject", () => {
    const worldToView = invert(pose) as number[];
    const invProj = invert(proj) as number[];
    const world = unproject(0.3, 0.7, 2.4, invProj, pose) as Vec3;
    const p = projectToView(world, worldToView, proj);
    expect(p?.u).toBeCloseTo(0.3, 9);
    expect(p?.v).toBeCloseTo(0.7, 9);
    expect(p?.depth).toBeCloseTo(2.4, 9);
  });

  it("returns null behind the camera or outside the picture", () => {
    const worldToView = invert(pose) as number[];
    expect(projectToView([0.4, 1.5, 3], worldToView, proj)).toBeNull();
    expect(projectToView([10, 1.5, -1.2], worldToView, proj)).toBeNull();
  });
});
