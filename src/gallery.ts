import { type Enrollment, nameKey } from "./core/faces";

export type Entry = Enrollment & { photo: string };

// v2: SFace face prints; v1 (face-api) prints are not comparable and are never read.
const KEY = "face-demo:gallery:v2";
const PROBE_KEY = "face-demo:probe";
// SFace always yields 128 values; anything else can't be compared.
const DESCRIPTOR_LENGTH = 128;

const opened = openStorage();
let entries: readonly Entry[] = opened.entries;
const store: Storage | null = opened.store;
const listeners = new Set<() => void>();

/** Set once at startup when faces can't be kept across a reload. The UI must show it. */
export const storageWarning: string | null = opened.warning;

function openStorage(): { store: Storage | null; entries: Entry[]; warning: string | null } {
  let storage: Storage;
  let raw: string | null;
  try {
    storage = window.sessionStorage;
    raw = storage.getItem(KEY);
    // A saved gallery proves writes work, and a test write could only fail because it is full.
    if (raw === null) {
      storage.setItem(PROBE_KEY, "1");
      storage.removeItem(PROBE_KEY);
    }
  } catch {
    return {
      store: null,
      entries: [],
      warning: "This browser blocks storage — faces will be forgotten on reload.",
    };
  }
  if (raw === null) return { store: storage, entries: [], warning: null };
  const parsed = parse(raw);
  if (!parsed) {
    return {
      store: null,
      entries: [],
      warning: "Saved faces couldn't be read — faces you add now will be forgotten on reload.",
    };
  }
  return { store: storage, entries: parsed, warning: null };
}

function parse(raw: string): Entry[] | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(value) || !value.every(isEntry)) return null;
  return value;
}

function isEntry(value: unknown): value is Entry {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.id === "string" &&
    typeof e.name === "string" &&
    typeof e.photo === "string" &&
    e.photo.startsWith("data:image/") &&
    Array.isArray(e.descriptor) &&
    e.descriptor.length === DESCRIPTOR_LENGTH &&
    e.descriptor.every((n) => typeof n === "number" && Number.isFinite(n))
  );
}

function isQuotaError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === "QuotaExceededError" || error.name === "NS_ERROR_DOM_QUOTA_REACHED")
  );
}

/** Writes first, then swaps the in-memory list, so a failed write changes nothing. */
function commit(next: readonly Entry[]): void {
  if (store) {
    try {
      store.setItem(KEY, JSON.stringify(next));
    } catch (error) {
      if (isQuotaError(error)) throw new Error("Storage is full — remove someone first.");
      throw error;
    }
  }
  entries = next;
  for (const fn of listeners) fn();
}

export function getGallery(): readonly Entry[] {
  return entries;
}

export function addEntry(name: string, photo: string, descriptor: ArrayLike<number>): Entry {
  const entry: Entry = {
    id: crypto.randomUUID(),
    name,
    photo,
    descriptor: Array.from(descriptor),
  };
  // Same rule as reading back: an entry parse() would reject must never be written.
  if (!isEntry(entry)) throw new Error("This face couldn't be saved — pick the photo again.");
  commit([...entries, entry]);
  return entry;
}

export function removePerson(key: string): void {
  commit(entries.filter((e) => nameKey(e.name) !== key));
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
