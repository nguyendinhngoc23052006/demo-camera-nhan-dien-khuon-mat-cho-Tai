import type { ModelState } from "./camera";
import { checkEnrollment, checkPhoto, isValidName, MAX_NAME_LENGTH, nameKey } from "./core/faces";
import { addEntry, type Entry, getGallery, removePerson, subscribe } from "./gallery";
import { type DetectedFace, detectPhotoFaces, loadPhoto } from "./vision";

type Tone = "muted" | "busy" | "ok" | "error";

const PHOTO_HINT = "JPG or PNG. On a phone you can take one now.";

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el as T;
}

export function createEnrollView(options: { ensureModels: () => Promise<void> }) {
  const form = byId<HTMLFormElement>("enroll-form");
  const nameInput = byId<HTMLInputElement>("enroll-name");
  const nameError = byId<HTMLParagraphElement>("name-error");
  const fileInput = byId<HTMLInputElement>("enroll-photo");
  const picker = byId<HTMLLabelElement>("picker");
  const preview = byId<HTMLCanvasElement>("enroll-preview");
  const photoStatus = byId<HTMLParagraphElement>("photo-status");
  const message = byId<HTMLParagraphElement>("enroll-message");
  const submit = byId<HTMLButtonElement>("enroll-submit");
  const list = byId<HTMLUListElement>("people-list");
  const empty = byId<HTMLDivElement>("people-empty");
  const count = byId<HTMLSpanElement>("people-count");

  nameInput.maxLength = MAX_NAME_LENGTH;

  let models: ModelState = "loading";
  let photo: { canvas: HTMLCanvasElement; descriptor: readonly number[] } | null = null;
  // Bumped per photo pick, so a slow check of an old photo can't overwrite a newer one.
  let pick = 0;

  function setPhotoStatus(tone: Tone, text: string): void {
    photoStatus.dataset.tone = tone;
    photoStatus.textContent = text;
  }

  function setBusy(busy: boolean): void {
    picker.dataset.busy = String(busy);
    submit.disabled = busy;
  }

  function showNameError(text: string | null): void {
    nameError.hidden = text === null;
    nameError.textContent = text ?? "";
    nameInput.setAttribute("aria-invalid", String(text !== null));
  }

  function showMessage(tone: "ok" | "error" | null, text = "", detail = ""): void {
    message.hidden = tone === null;
    if (tone === null) return;
    message.dataset.tone = tone;
    if (!detail) {
      message.textContent = text;
      return;
    }
    const strong = document.createElement("strong");
    strong.textContent = text;
    message.replaceChildren(strong, ` ${detail}`);
  }

  function clearPhoto(): void {
    photo = null;
    picker.dataset.state = "empty";
    preview.width = 0;
    preview.height = 0;
    setPhotoStatus("muted", PHOTO_HINT);
  }

  function drawPreview(canvas: HTMLCanvasElement, faces: readonly DetectedFace[], ok: boolean) {
    const ctx = preview.getContext("2d");
    if (!ctx) return;
    preview.width = canvas.width;
    preview.height = canvas.height;
    ctx.drawImage(canvas, 0, 0);
    const css = getComputedStyle(document.documentElement);
    const color = css.getPropertyValue(ok ? "--green" : "--red").trim();
    const line = Math.max(2, Math.max(canvas.width, canvas.height) / 180);
    ctx.lineJoin = "round";
    for (const { box } of faces) {
      ctx.beginPath();
      ctx.roundRect(box.x, box.y, box.width, box.height, Math.min(box.width, box.height) / 8);
      ctx.strokeStyle = "rgba(0, 0, 0, 0.35)";
      ctx.lineWidth = line * 2;
      ctx.stroke();
      ctx.strokeStyle = color;
      ctx.lineWidth = line;
      ctx.stroke();
    }
    picker.dataset.state = "preview";
  }

  async function handlePhoto(file: File): Promise<void> {
    const id = ++pick;
    photo = null;
    showMessage(null);
    setBusy(true);
    try {
      setPhotoStatus(
        "busy",
        models === "ready" ? "Looking for a face…" : "Loading the face models first…",
      );
      try {
        await options.ensureModels();
      } catch {
        if (id === pick) {
          clearPhoto();
          setPhotoStatus(
            "error",
            "The face models didn't load. Try again at the top, then pick the photo again.",
          );
        }
        return;
      }
      if (id !== pick) return;
      setPhotoStatus("busy", "Looking for a face…");

      let canvas: HTMLCanvasElement;
      try {
        canvas = await loadPhoto(file);
      } catch (error) {
        if (id === pick) {
          console.error(error);
          clearPhoto();
          setPhotoStatus("error", "This file couldn't be opened as a photo. Try a JPG or PNG.");
        }
        return;
      }
      let faces: DetectedFace[];
      try {
        faces = await detectPhotoFaces(canvas);
      } catch (error) {
        if (id === pick) {
          console.error(error);
          clearPhoto();
          setPhotoStatus("error", "Face detection failed — reload the page and try again.");
        }
        return;
      }
      if (id !== pick) return;

      const check = checkPhoto(
        faces.map((f) => ({ score: f.score, width: f.box.width, height: f.box.height })),
      );
      const [face] = faces;
      drawPreview(canvas, faces, check.ok);
      if (check.ok && face) {
        photo = { canvas, descriptor: face.descriptor };
        setPhotoStatus("ok", "Face found. Looks good.");
      } else if (!check.ok) {
        setPhotoStatus("error", check.message);
      }
    } finally {
      if (id === pick) setBusy(false);
    }
  }

  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    // Clear the input so choosing the same file again still fires "change".
    fileInput.value = "";
    if (file) void handlePhoto(file);
  });

  nameInput.addEventListener("input", () => {
    showNameError(null);
    if (message.dataset.tone === "error") showMessage(null);
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    showMessage(null);
    showNameError(null);

    const name = nameInput.value;
    if (!isValidName(name)) {
      showNameError("Type a name first.");
      nameInput.focus();
      return;
    }
    if (!photo) {
      showMessage("error", "Choose a photo with one clear face first.");
      return;
    }
    const gallery = getGallery();
    const check = checkEnrollment(name, photo.descriptor, gallery);
    if (!check.ok) {
      if (check.error === "invalid-name") showNameError(check.message);
      else showMessage("error", check.message);
      return;
    }
    const known = gallery.some((e) => nameKey(e.name) === nameKey(check.name));
    try {
      addEntry(check.name, photo.canvas.toDataURL("image/jpeg", 0.85), photo.descriptor);
    } catch (error) {
      showMessage("error", error instanceof Error ? error.message : "Couldn't save this face.");
      return;
    }
    nameInput.value = "";
    clearPhoto();
    showMessage(
      "ok",
      known ? `Added another photo of ${check.name}.` : `Added ${check.name}.`,
      "Open Camera to try it.",
    );
  });

  function personItem(key: string, entries: readonly Entry[]): HTMLLIElement {
    const [first] = entries;
    const name = first?.name ?? "";
    const item = document.createElement("li");
    item.className = "person";

    const thumb = document.createElement("img");
    thumb.className = "thumb";
    thumb.src = first?.photo ?? "";
    thumb.alt = "";
    thumb.decoding = "async";

    const meta = document.createElement("div");
    meta.className = "person-meta";
    const title = document.createElement("p");
    title.className = "person-name";
    title.textContent = name;
    const photos = document.createElement("p");
    photos.className = "person-photos";
    photos.textContent = entries.length === 1 ? "1 photo" : `${entries.length} photos`;
    meta.append(title, photos);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "btn btn-ghost";
    remove.textContent = "Remove";
    remove.setAttribute("aria-label", `Remove ${name}`);
    remove.addEventListener("click", () => {
      try {
        removePerson(key);
      } catch (error) {
        showMessage("error", error instanceof Error ? error.message : "Couldn't remove.");
      }
    });

    item.append(thumb, meta, remove);
    return item;
  }

  function renderPeople(): void {
    const groups = new Map<string, Entry[]>();
    for (const entry of getGallery()) {
      const key = nameKey(entry.name);
      const group = groups.get(key);
      if (group) group.push(entry);
      else groups.set(key, [entry]);
    }
    list.replaceChildren(...Array.from(groups, ([key, entries]) => personItem(key, entries)));
    list.hidden = groups.size === 0;
    empty.hidden = groups.size > 0;
    count.hidden = groups.size === 0;
    count.textContent = String(groups.size);
  }

  subscribe(renderPeople);
  renderPeople();
  clearPhoto();
  setBusy(false);

  return {
    setModelState(next: ModelState): void {
      models = next;
    },
  };
}
