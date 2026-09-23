// Face prints come from OpenCV's SFace and are compared by cosine distance (1 − cosine similarity):
// 0 = same direction, larger = less alike. Calibrated 2026-09 on 123 people / 808 photos across six
// ethnic groups, choosing values by the WORST group, not the average.
/**
 * Max distance to accept a face as someone. OpenCV's published SFace threshold (cosine similarity
 * 0.363); it kept every group's false-match rate at or below 1%.
 */
export const MATCH_THRESHOLD = 0.637;
/** The best person must beat the runner-up person by at least this much, or the answer is "unsure". */
export const MATCH_MARGIN = 0.1;
/**
 * Adding a face under a new name is refused only when it is this close to someone else — stricter
 * than MATCH_THRESHOLD, so look-alike colleagues can still both be added; if the camera later
 * hesitates between them, MATCH_MARGIN shows "Not sure" instead of a wrong name.
 */
export const DUPLICATE_THRESHOLD = 0.536;
export const MAX_NAME_LENGTH = 40;
/** Enrollment photo quality floor. YuNet scored every real test photo 0.85 or higher. */
export const MIN_FACE_SCORE = 0.8;
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

/** Cosine distance. A zero-length print gives NaN, which every rule treats as "no match". */
export function distance(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) {
    throw new RangeError(`Face descriptors differ in length: ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    aa += x * x;
    bb += y * y;
  }
  return 1 - dot / Math.sqrt(aa * bb);
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

  const other = ranked.find((p) => p.key !== key);
  if (other && other.distance <= DUPLICATE_THRESHOLD) {
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
