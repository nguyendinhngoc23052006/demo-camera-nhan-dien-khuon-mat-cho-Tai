import type { ModelState } from "./camera";
import {
  checkEnrollment,
  checkPhoto,
  checkShot,
  type Enrollment,
  isValidName,
  MAX_NAME_LENGTH,
  nameKey,
  type PhotoError,
} from "./core/faces";
import { addEntry, type Entry, getGallery, removePerson, subscribe } from "./gallery";
import { type DetectedFace, detectFaces, detectPhotoFaces, grabFrame, loadPhoto } from "./vision";

type Tone = "muted" | "busy" | "ok" | "error";
type Photo = { canvas: HTMLCanvasElement; descriptor: readonly number[] };

/** Photos the camera takes per person, each from a slightly different angle. */
const CAMERA_SHOTS = 3;
const PHOTO_HINT = `JPG or PNG, or use the camera to take ${CAMERA_SHOTS} photos.`;
/** Pause between face checks while the camera is taking photos, ms. */
const CAMERA_CHECK_MS = 250;
const CAMERA_HINT: Record<PhotoError, string> = {
  "no-face": "Look at the camera.",
  "many-faces": "Only the person being added, please.",
  "too-small": "Come a little closer.",
  unclear: "Face the camera, in good light.",
};

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
  const video = byId<HTMLVideoElement>("enroll-video");
  const cameraButton = byId<HTMLButtonElement>("enroll-camera");
  const preview = byId<HTMLCanvasElement>("enroll-preview");
  const photoStatus = byId<HTMLParagraphElement>("photo-status");
  const message = byId<HTMLParagraphElement>("enroll-message");
  const submit = byId<HTMLButtonElement>("enroll-submit");
  const list = byId<HTMLUListElement>("people-list");
  const empty = byId<HTMLDivElement>("people-empty");
  const count = byId<HTMLSpanElement>("people-count");

  nameInput.maxLength = MAX_NAME_LENGTH;

  let models: ModelState = "loading";
  // One picked photo, or the camera's shots of one person.
  let photos: Photo[] = [];
  // Bumped per photo pick or camera start, so a slow check of an old one can't overwrite a newer one.
  let pick = 0;
  let stream: MediaStream | null = null;
  let timer = 0;

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
    photos = [];
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
    stopCamera();
    photos = [];
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
        photos = [{ canvas, descriptor: face.descriptor }];
        setPhotoStatus("ok", "Face found. Looks good.");
      } else if (!check.ok) {
        setPhotoStatus("error", check.message);
      }
    } finally {
      if (id === pick) setBusy(false);
    }
  }

  function stopCamera(): void {
    clearTimeout(timer);
    if (!stream) return;
    for (const track of stream.getTracks()) track.stop();
    stream = null;
    video.pause();
    video.srcObject = null;
    cameraButton.textContent = "Use the camera";
  }

  /** Shows the camera's shots side by side, as they will be saved. */
  function drawShots(shots: readonly Photo[]): void {
    const ctx = preview.getContext("2d");
    if (!ctx) return;
    preview.width = shots.reduce((w, s) => w + s.canvas.width, 0);
    preview.height = Math.max(...shots.map((s) => s.canvas.height));
    let x = 0;
    for (const { canvas } of shots) {
      ctx.drawImage(canvas, x, 0);
      x += canvas.width;
    }
    picker.dataset.state = "preview";
  }

  async function startCamera(): Promise<void> {
    const id = ++pick;
    stopCamera();
    clearPhoto();
    showMessage(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setPhotoStatus("error", "The camera needs a secure page. Open this site over https.");
      return;
    }
    setBusy(true);
    try {
      setPhotoStatus(
        "busy",
        models === "ready" ? "Starting the camera…" : "Loading the face models first…",
      );
      try {
        await options.ensureModels();
      } catch {
        if (id === pick) {
          setPhotoStatus("error", "The face models didn't load. Try again at the top of the page.");
        }
        return;
      }
      if (id !== pick) return;
      let media: MediaStream;
      try {
        media = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "user" },
          audio: false,
        });
      } catch (error) {
        if (id === pick) setPhotoStatus("error", cameraError(error));
        return;
      }
      if (id !== pick) {
        for (const track of media.getTracks()) track.stop();
        return;
      }
      stream = media;
      video.srcObject = media;
      try {
        await video.play();
      } catch (error) {
        console.error(error);
        if (id === pick) {
          stopCamera();
          setPhotoStatus("error", "The camera didn't start. Try again.");
        }
        return;
      }
      if (id !== pick) return;
      picker.dataset.state = "camera";
      cameraButton.textContent = "Stop the camera";
      setPhotoStatus("busy", CAMERA_HINT["no-face"]);
      void takeShots(id, []);
    } finally {
      if (id === pick) setBusy(false);
    }
  }

  /** Checks the camera a few times a second and keeps each clear shot from a new angle. */
  async function takeShots(id: number, shots: Photo[]): Promise<void> {
    if (id !== pick || !stream) return;
    if (video.videoWidth > 0) {
      const canvas = grabFrame(video);
      let faces: DetectedFace[];
      try {
        faces = await detectFaces(canvas);
      } catch (error) {
        console.error(error);
        if (id === pick) {
          stopCamera();
          clearPhoto();
          setPhotoStatus("error", "Face detection failed — reload the page and try again.");
        }
        return;
      }
      if (id !== pick || !stream) return;
      const check = checkPhoto(
        faces.map((f) => ({ score: f.score, width: f.box.width, height: f.box.height })),
      );
      const [face] = faces;
      const progress = `Got ${shots.length} of ${CAMERA_SHOTS}. Turn your head a little.`;
      if (!check.ok) {
        setPhotoStatus(
          "busy",
          shots.length > 0 && check.error === "no-face" ? progress : CAMERA_HINT[check.error],
        );
      } else if (face) {
        const shot = checkShot(
          face.descriptor,
          shots.map((s) => s.descriptor),
        );
        if (shot === "someone-else") {
          setPhotoStatus("error", "That's someone else. Only the person being added, please.");
        } else if (shot === "same-angle") {
          setPhotoStatus("busy", progress);
        } else {
          shots.push({ canvas, descriptor: face.descriptor });
          if (shots.length === CAMERA_SHOTS) {
            stopCamera();
            photos = shots;
            drawShots(shots);
            setPhotoStatus("ok", `${CAMERA_SHOTS} photos taken. Looks good.`);
            return;
          }
          setPhotoStatus(
            "busy",
            `Got ${shots.length} of ${CAMERA_SHOTS}. Turn your head a little.`,
          );
        }
      }
    }
    timer = window.setTimeout(() => void takeShots(id, shots), CAMERA_CHECK_MS);
  }

  /** Stops the camera and drops unfinished shots (leaving the tab, or the page going away). */
  function cancelCamera(): void {
    if (!stream) return;
    pick++;
    stopCamera();
    clearPhoto();
    setBusy(false);
  }

  cameraButton.addEventListener("click", () => {
    if (stream) cancelCamera();
    else void startCamera();
  });
  // The photo box is a file picker; while the camera shows in it, a tap must not open the picker.
  picker.addEventListener("click", (event) => {
    if (stream) event.preventDefault();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) cancelCamera();
  });

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
    if (photos.length === 0) {
      showMessage(
        "error",
        stream
          ? `Wait until the camera has taken all ${CAMERA_SHOTS} photos.`
          : "Choose a photo with one clear face, or use the camera, first.",
      );
      return;
    }
    // Check every photo before saving any, each against the gallery plus the ones before it.
    const known = getGallery().some((e) => nameKey(e.name) === nameKey(name));
    const pending: Enrollment[] = [...getGallery()];
    let saveAs = name;
    for (const photo of photos) {
      const check = checkEnrollment(name, photo.descriptor, pending);
      if (!check.ok) {
        if (check.error === "invalid-name") showNameError(check.message);
        else showMessage("error", check.message);
        return;
      }
      saveAs = check.name;
      pending.push({
        id: `pending-${pending.length}`,
        name: check.name,
        descriptor: photo.descriptor,
      });
    }
    try {
      for (const photo of photos) {
        addEntry(saveAs, photo.canvas.toDataURL("image/jpeg", 0.85), photo.descriptor);
      }
    } catch (error) {
      showMessage("error", error instanceof Error ? error.message : "Couldn't save this face.");
      return;
    }
    const count = photos.length;
    nameInput.value = "";
    clearPhoto();
    showMessage(
      "ok",
      count > 1
        ? known
          ? `Added ${count} more photos of ${saveAs}.`
          : `Added ${saveAs} with ${count} photos.`
        : known
          ? `Added another photo of ${saveAs}.`
          : `Added ${saveAs}.`,
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
    /** Called when another tab opens. */
    hide(): void {
      cancelCamera();
    },
    setModelState(next: ModelState): void {
      models = next;
    },
  };
}

function cameraError(error: unknown): string {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Camera access is blocked. Allow the camera for this site in your browser's settings.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return "No camera found. Choose a photo instead.";
  }
  if (name === "NotReadableError" || name === "AbortError") {
    return "Another app is using the camera. Close it, then try again.";
  }
  console.error(error);
  return "The camera didn't start. Try again, or choose a photo.";
}
