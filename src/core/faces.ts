// Calibrated 2026-09 on face-api's fixture faces (8 people x 5 photos): same-person distances had a
// median of 0.44, different people never came closer than 0.59.
/** Max euclidean distance to accept a face as someone. (face-api's own default is 0.6; we are stricter.) */
export const MATCH_THRESHOLD = 0.55;
/** The best person must beat the runner-up person by at least this much, or the answer is "unsure". */
export const MATCH_MARGIN = 0.08;
export const MAX_NAME_LENGTH = 40;
/** Enrollment photo quality floor. Real, slightly angled faces score 0.6–0.8, so 0.8 refused good photos. */
export const MIN_FACE_SCORE = 0.6;
export const MIN_FACE_SIZE = 80; // px, shorter side of the detected box

export interface Enrollment {
  id: string;
  name: string;
  descriptor: readonly number[];
}

export function normalizeName(raw: string): string {
  return raw.normalize("NFC").trim().replace(/\s+/g, " ");
}

/** The identity key. Diacritics are kept: "Tài" and "Tai" are different people. */
export function nameKey(name: string): string {
  return normalizeName(name).toLowerCase();
}

export function isValidName(name: string): boolean {
  const normalized = normalizeName(name);
  // Length in UTF-16 units, the same unit <input maxlength> counts, so the form and this rule agree.
  return (
    normalized.length >= 1 && normalized.length <= MAX_NAME_LENGTH && !/\p{Cc}/u.test(normalized)
  );
}

export function distance(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) {
    throw new RangeError(`Face descriptors differ in length: ${a.length} vs ${b.length}`);
  }
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = (a[i] as number) - (b[i] as number);
    sum += d * d;
  }
  return Math.sqrt(sum);
}

export type MatchResult =
  | { kind: "match"; name: string; distance: number }
  | { kind: "unsure"; names: [string, string]; distance: number }
  | { kind: "unknown" };

interface Person {
  key: string;
  name: string;
  distance: number;
}

// Samples are grouped by person before ranking so two photos of one person never stand as each
// other's runner-up. A person's distance is their NEAREST sample: extra photos exist to cover
// other angles and lighting, so one that differs from this frame must not count against a match.
function rankPersons(query: ArrayLike<number>, gallery: readonly Enrollment[]): Person[] {
  const byKey = new Map<string, Person>();
  for (const entry of gallery) {
    const key = nameKey(entry.name);
    const d = distance(query, entry.descriptor);
    const person = byKey.get(key);
    if (!person) byKey.set(key, { key, name: entry.name, distance: d });
    else if (d < person.distance) person.distance = d;
  }
  return [...byKey.values()].sort((a, b) => a.distance - b.distance);
}

export function matchFace(query: ArrayLike<number>, gallery: readonly Enrollment[]): MatchResult {
  const [best, runnerUp] = rankPersons(query, gallery);
  // Written as !(<=) so a NaN distance is unknown, never a match.
  if (!best || !(best.distance <= MATCH_THRESHOLD)) return { kind: "unknown" };
  if (runnerUp && runnerUp.distance - best.distance < MATCH_MARGIN) {
    return { kind: "unsure", names: [best.name, runnerUp.name], distance: best.distance };
  }
  return { kind: "match", name: best.name, distance: best.distance };
}

export type EnrollError = "invalid-name" | "looks-like-someone-else" | "not-the-same-person";

export type EnrollCheck =
  | { ok: true; name: string }
  | { ok: false; error: EnrollError; message: string; conflictName?: string };

export function checkEnrollment(
  name: string,
  descriptor: ArrayLike<number>,
  gallery: readonly Enrollment[],
): EnrollCheck {
  if (!isValidName(name)) {
    return {
      ok: false,
      error: "invalid-name",
      message: `Type a name of 1–${MAX_NAME_LENGTH} characters.`,
    };
  }
  const key = nameKey(name);
  const ranked = rankPersons(descriptor, gallery);

  // Refuse only faces the camera would already take for someone else. A wider radius (threshold +
  // margin) refused ~2% of pairs of different people in calibration, which compounds with every
  // person added; faces just outside the threshold are left to the camera's "unsure" margin.
  const other = ranked.find((p) => p.key !== key);
  if (other && other.distance <= MATCH_THRESHOLD) {
    return {
      ok: false,
      error: "looks-like-someone-else",
      message: `This face looks too much like ${other.name}, so the camera could mix them up. If it is ${other.name}, add the photo under that name.`,
      conflictName: other.name,
    };
  }

  const self = ranked.find((p) => p.key === key);
  if (self && self.distance > MATCH_THRESHOLD) {
    return {
      ok: false,
      error: "not-the-same-person",
      message: `This doesn't look like the ${self.name} you already added. Use a different name, or pick a clearer photo of ${self.name}.`,
      conflictName: self.name,
    };
  }

  return { ok: true, name: self ? self.name : normalizeName(name) };
}

export type PhotoError = "no-face" | "many-faces" | "too-small" | "unclear";
export type PhotoCheck = { ok: true } | { ok: false; error: PhotoError; message: string };

export function checkPhoto(
  faces: readonly { score: number; width: number; height: number }[],
): PhotoCheck {
  const [face] = faces;
  if (!face) {
    return {
      ok: false,
      error: "no-face",
      message: "No face found. Pick a photo where the face is clear and looking at the camera.",
    };
  }
  if (faces.length > 1) {
    return {
      ok: false,
      error: "many-faces",
      message: `This photo has ${faces.length} faces. Pick one with just one person in it.`,
    };
  }
  if (Math.min(face.width, face.height) < MIN_FACE_SIZE) {
    return {
      ok: false,
      error: "too-small",
      message: "The face is too small. Pick a photo taken closer up.",
    };
  }
  if (face.score < MIN_FACE_SCORE) {
    return {
      ok: false,
      error: "unclear",
      message: "The face isn't clear enough. Pick a sharper, well-lit photo facing the camera.",
    };
  }
  return { ok: true };
}
