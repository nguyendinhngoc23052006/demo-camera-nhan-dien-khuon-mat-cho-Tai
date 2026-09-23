import { describe, expect, it } from "vitest";
import {
  checkEnrollment,
  checkPhoto,
  distance,
  type Enrollment,
  isValidName,
  MATCH_MARGIN,
  MATCH_THRESHOLD,
  MAX_NAME_LENGTH,
  MIN_FACE_SCORE,
  MIN_FACE_SIZE,
  matchFace,
  nameKey,
  normalizeName,
} from "./faces";

// Enrollment refuses a face this close to a different person.
const RADIUS = MATCH_THRESHOLD;
const EPS = MATCH_MARGIN / 4;

// Offsets land on axes where the base is 0, so (0 + d) - 0 === d and boundary cases are exact.
const PROBE_AXES = 8;
const BASE: readonly number[] = Array.from({ length: 128 }, (_, i) =>
  i < PROBE_AXES ? 0 : Math.sin(i) / 10,
);

/** A descriptor exactly `d` from BASE, moved along one probe axis. */
function away(d: number, axis = 0): number[] {
  const v = [...BASE];
  v[axis] = d;
  return v;
}

let nextId = 0;
function entry(name: string, descriptor: readonly number[]): Enrollment {
  nextId += 1;
  return { id: `e${nextId}`, name, descriptor };
}

describe("normalizeName", () => {
  it("trims and collapses inner whitespace of any kind to one space", () => {
    expect(normalizeName("  Nguyễn \t Văn\n\u00a0Tài  ")).toBe("Nguyễn Văn Tài");
  });

  it("composes to NFC", () => {
    const decomposed = "Ta\u0300i";
    expect(normalizeName(decomposed)).toBe("Tài");
    expect(normalizeName(decomposed)).toHaveLength(3);
  });
});

describe("nameKey", () => {
  it("folds case, surrounding and inner whitespace", () => {
    expect(nameKey("  tài ")).toBe(nameKey("Tài"));
    expect(nameKey("TÀI")).toBe(nameKey("tài"));
    expect(nameKey("Nguyễn   Tài")).toBe(nameKey("nguyễn tài"));
  });

  it("folds composed and decomposed forms together", () => {
    expect(nameKey("Ta\u0300i")).toBe(nameKey("Tài"));
  });

  it("keeps diacritics: Tài and Tai are different people", () => {
    expect(nameKey("Tài")).not.toBe(nameKey("Tai"));
  });
});

describe("isValidName", () => {
  it("rejects empty and whitespace-only names", () => {
    expect(isValidName("")).toBe(false);
    expect(isValidName(" \t\n ")).toBe(false);
  });

  it("accepts 1 up to MAX_NAME_LENGTH characters", () => {
    expect(isValidName("A")).toBe(true);
    expect(isValidName("Nguyễn Văn Tài")).toBe(true);
    expect(isValidName("a".repeat(MAX_NAME_LENGTH))).toBe(true);
    expect(isValidName("a".repeat(MAX_NAME_LENGTH + 1))).toBe(false);
  });

  it("measures the normalized name, not the raw input", () => {
    expect(isValidName(`   ${"a".repeat(MAX_NAME_LENGTH)}   `)).toBe(true);
  });

  it("rejects control characters", () => {
    expect(isValidName("Tai\u0000")).toBe(false);
    expect(isValidName("Tai\u007f")).toBe(false);
    expect(isValidName("Ta\u0085i")).toBe(false);
  });
});

describe("distance", () => {
  it("is 0 for identical descriptors", () => {
    expect(distance(BASE, [...BASE])).toBe(0);
  });

  it("is euclidean and symmetric", () => {
    expect(distance([1, 2], [4, 6])).toBe(5);
    expect(distance([4, 6], [1, 2])).toBe(5);
    expect(distance(BASE, away(MATCH_THRESHOLD))).toBe(MATCH_THRESHOLD);
    expect(distance(away(3, 0), away(4, 1))).toBeCloseTo(5, 12);
  });

  it("accepts typed arrays", () => {
    expect(distance(new Float32Array([0, 0]), [3, 4])).toBe(5);
  });

  it("throws on descriptors of different lengths", () => {
    expect(() => distance([1, 2, 3], [1, 2])).toThrow(RangeError);
  });
});

describe("matchFace", () => {
  it("returns unknown for an empty gallery", () => {
    expect(matchFace(BASE, [])).toEqual({ kind: "unknown" });
  });

  it("matches a person just inside the threshold", () => {
    const d = MATCH_THRESHOLD - EPS;
    expect(matchFace(BASE, [entry("Tài", away(d))])).toEqual({
      kind: "match",
      name: "Tài",
      distance: d,
    });
  });

  it("matches a person exactly at the threshold", () => {
    expect(matchFace(BASE, [entry("Tài", away(MATCH_THRESHOLD))])).toMatchObject({
      kind: "match",
      name: "Tài",
    });
  });

  it("returns unknown just outside the threshold", () => {
    expect(matchFace(BASE, [entry("Tài", away(MATCH_THRESHOLD + EPS))])).toEqual({
      kind: "unknown",
    });
  });

  it("is unsure when the runner-up is closer than the margin", () => {
    const best = MATCH_THRESHOLD - MATCH_MARGIN;
    const gallery = [
      entry("Minh", away(best + MATCH_MARGIN - EPS, 1)),
      entry("Tài", away(best, 0)),
    ];
    expect(matchFace(BASE, gallery)).toEqual({
      kind: "unsure",
      names: ["Tài", "Minh"],
      distance: best,
    });
  });

  it("matches when the runner-up is just beyond the margin", () => {
    const best = MATCH_THRESHOLD - MATCH_MARGIN;
    const gallery = [
      entry("Tài", away(best, 0)),
      entry("Minh", away(best + MATCH_MARGIN + EPS, 1)),
    ];
    expect(matchFace(BASE, gallery)).toEqual({ kind: "match", name: "Tài", distance: best });
  });

  it("matches when the runner-up is exactly the margin behind", () => {
    const gallery = [entry("Tài", away(0, 0)), entry("Minh", away(MATCH_MARGIN, 1))];
    expect(matchFace(BASE, gallery)).toMatchObject({ kind: "match", name: "Tài" });
  });

  it("is unsure when a runner-up outside the threshold is still within the margin", () => {
    const gallery = [
      entry("Tài", away(MATCH_THRESHOLD - EPS, 0)),
      entry("Minh", away(MATCH_THRESHOLD + EPS, 1)),
    ];
    expect(matchFace(BASE, gallery)).toMatchObject({ kind: "unsure", names: ["Tài", "Minh"] });
  });

  it("counts two samples of one name as one person, never unsure against yourself", () => {
    const gallery = [entry("Tài", away(EPS, 0)), entry("Tài", away(EPS * 2, 1))];
    expect(matchFace(BASE, gallery)).toEqual({ kind: "match", name: "Tài", distance: EPS });
  });

  it("groups samples by name key and shows the earliest sample's name", () => {
    const gallery = [
      entry("Tài", away(MATCH_THRESHOLD + MATCH_MARGIN * 2, 0)),
      entry("  tài ", away(EPS, 1)),
    ];
    expect(matchFace(BASE, gallery)).toEqual({ kind: "match", name: "Tài", distance: EPS });
  });

  it("uses a person's nearest sample, not their first one", () => {
    const gallery = [
      entry("Tài", away(MATCH_THRESHOLD + MATCH_MARGIN * 2, 0)),
      entry("Tài", away(MATCH_THRESHOLD - EPS, 1)),
    ];
    expect(matchFace(BASE, gallery)).toMatchObject({ kind: "match", name: "Tài" });
  });

  it("treats Tài and Tai as two people", () => {
    const gallery = [entry("Tài", away(EPS, 0)), entry("Tai", away(EPS * 2, 1))];
    expect(matchFace(BASE, gallery)).toMatchObject({ kind: "unsure", names: ["Tài", "Tai"] });
  });

  it("returns unknown, never a match, for a face print containing NaN", () => {
    const query = [...BASE];
    query[3] = Number.NaN;
    expect(matchFace(query, [entry("Tài", away(EPS))])).toEqual({ kind: "unknown" });
  });
});

describe("checkEnrollment", () => {
  it("accepts a new person and returns the normalized name", () => {
    expect(checkEnrollment("  Nguyễn   Tài ", BASE, [])).toEqual({ ok: true, name: "Nguyễn Tài" });
  });

  it("rejects an invalid name before looking at the face", () => {
    const gallery = [entry("Minh", away(0))];
    expect(checkEnrollment("   ", BASE, gallery)).toMatchObject({
      ok: false,
      error: "invalid-name",
    });
    expect(checkEnrollment("a".repeat(MAX_NAME_LENGTH + 1), BASE, [])).toMatchObject({
      ok: false,
      error: "invalid-name",
    });
  });

  it("rejects a face the camera would take for someone else, naming them", () => {
    const result = checkEnrollment("Tài", BASE, [entry("Minh", away(RADIUS - EPS))]);
    expect(result).toMatchObject({
      ok: false,
      error: "looks-like-someone-else",
      conflictName: "Minh",
    });
    expect(!result.ok && result.message).toContain("Minh");
  });

  it("rejects a face exactly at the threshold from someone else", () => {
    expect(checkEnrollment("Tài", BASE, [entry("Minh", away(RADIUS))])).toMatchObject({
      ok: false,
      error: "looks-like-someone-else",
    });
  });

  it("accepts a face just beyond the threshold from everyone else", () => {
    expect(checkEnrollment("Tài", BASE, [entry("Minh", away(RADIUS + EPS))])).toEqual({
      ok: true,
      name: "Tài",
    });
  });

  it("names the nearest of several look-alikes", () => {
    const gallery = [entry("Minh", away(RADIUS - EPS, 0)), entry("Lan", away(EPS, 1))];
    expect(checkEnrollment("Tài", BASE, gallery)).toMatchObject({ conflictName: "Lan" });
  });

  it("checks looks-like-someone-else before not-the-same-person", () => {
    const gallery = [entry("Tài", away(RADIUS * 2, 0)), entry("Minh", away(EPS, 1))];
    expect(checkEnrollment("Tài", BASE, gallery)).toMatchObject({
      ok: false,
      error: "looks-like-someone-else",
      conflictName: "Minh",
    });
  });

  it("accepts another photo under an existing name, returning their display name", () => {
    const gallery = [entry("Tài", away(MATCH_THRESHOLD - EPS))];
    expect(checkEnrollment("  tài ", BASE, gallery)).toEqual({ ok: true, name: "Tài" });
  });

  it("accepts another photo exactly at the threshold from that person", () => {
    expect(checkEnrollment("Tài", BASE, [entry("Tài", away(MATCH_THRESHOLD))])).toEqual({
      ok: true,
      name: "Tài",
    });
  });

  it("rejects someone else's face under an existing name, naming that person", () => {
    const result = checkEnrollment("tài", BASE, [entry("Tài", away(MATCH_THRESHOLD + EPS))]);
    expect(result).toMatchObject({
      ok: false,
      error: "not-the-same-person",
      conflictName: "Tài",
    });
    expect(!result.ok && result.message).toContain("Tài");
  });

  it("accepts a photo near any one of the person's samples", () => {
    const gallery = [entry("Tài", away(RADIUS * 2, 0)), entry("Tài", away(MATCH_THRESHOLD, 1))];
    expect(checkEnrollment("Tài", BASE, gallery)).toEqual({ ok: true, name: "Tài" });
  });

  it("treats Tai as a new person distinct from Tài", () => {
    const tai = [entry("Tài", away(RADIUS + EPS))];
    expect(checkEnrollment("Tai", BASE, tai)).toEqual({ ok: true, name: "Tai" });
    expect(checkEnrollment("Tai", BASE, [entry("Tài", away(0))])).toMatchObject({
      ok: false,
      error: "looks-like-someone-else",
      conflictName: "Tài",
    });
  });
});

describe("checkPhoto", () => {
  const good = { score: MIN_FACE_SCORE, width: MIN_FACE_SIZE, height: MIN_FACE_SIZE };

  it("accepts exactly one face at the size and score floors", () => {
    expect(checkPhoto([good])).toEqual({ ok: true });
  });

  it("rejects a photo with no face", () => {
    expect(checkPhoto([])).toMatchObject({ ok: false, error: "no-face" });
  });

  it("rejects a photo with more than one face, even good ones", () => {
    expect(checkPhoto([good, good])).toMatchObject({ ok: false, error: "many-faces" });
  });

  it("rejects a face whose shorter side is below the minimum", () => {
    expect(
      checkPhoto([{ ...good, width: MIN_FACE_SIZE - 1, height: MIN_FACE_SIZE * 3 }]),
    ).toMatchObject({ ok: false, error: "too-small" });
    expect(
      checkPhoto([{ ...good, width: MIN_FACE_SIZE * 3, height: MIN_FACE_SIZE - 1 }]),
    ).toMatchObject({ ok: false, error: "too-small" });
  });

  it("rejects a face scored below the floor", () => {
    expect(checkPhoto([{ ...good, score: MIN_FACE_SCORE - 0.01 }])).toMatchObject({
      ok: false,
      error: "unclear",
    });
  });

  it("reports too-small before unclear", () => {
    expect(
      checkPhoto([
        { score: MIN_FACE_SCORE - 0.01, width: MIN_FACE_SIZE - 1, height: MIN_FACE_SIZE },
      ]),
    ).toMatchObject({ ok: false, error: "too-small" });
  });

  it("gives every rejection a message", () => {
    const rejections = [
      checkPhoto([]),
      checkPhoto([good, good]),
      checkPhoto([{ ...good, width: MIN_FACE_SIZE - 1 }]),
      checkPhoto([{ ...good, score: MIN_FACE_SCORE - 0.01 }]),
    ];
    for (const r of rejections) expect(!r.ok && r.message.length > 0).toBe(true);
  });
});
