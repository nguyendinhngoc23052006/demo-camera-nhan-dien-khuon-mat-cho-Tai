import { describe, expect, it } from "vitest";
import { similarityTransform } from "./vision";

describe("similarityTransform", () => {
  it("matches OpenCV's alignment matrix for real YuNet landmarks", () => {
    // YuNet landmarks on an LFW photo, and the matrix OpenCV's FaceRecognizerSF logic produced.
    const landmarks = [
      [105.211, 112.424],
      [145.001, 111.556],
      [128.306, 134.848],
      [111.022, 153.018],
      [145.552, 153.055],
    ];
    const expected = [0.93065, -0.04141, -56.6765, 0.04141, 0.93065, -57.1171];
    similarityTransform(landmarks).forEach((value, i) => {
      expect(value).toBeCloseTo(expected[i] as number, 2);
    });
  });
});
