# Face recognition demo — for Tài

Add a few people (a photo and a name), then point the webcam at them: the page boxes each face
and writes who it is. Everything runs inside one browser tab — no server, no database, no uploads.

## How it works

1. **Add a face** tab: pick a photo and type a name.
2. The browser finds the face and checks the photo is usable (*Photo checks* below).
3. It turns the face into 128 numbers — a face print — and checks it against everyone already added (*Margin rules*).
4. Name, photo and face print are saved in this tab's **sessionStorage**. Reloading keeps them; closing the tab erases them.
5. **Camera** tab → **Start camera**: every face in view is compared with everyone saved and labelled
   green **Name**, amber **Not sure: A or B?**, or grey **Unknown**.

## The margin rules — how it avoids mixing people up

Faces are found by **YuNet** and turned into face prints by **SFace** — both OpenCV models, run
in the browser by opencv.js. Two face prints are compared by their *distance* (cosine distance):
0 is identical, and smaller means more alike. The limits were tuned on 123 people across six ethnic
groups and chosen by the group the model handles *worst*, so no group gets mixed up more than the others.
Every `CONSTANT` below lives in `src/core/faces.ts`, the only file that decides who someone is —
read its current value there (this page names them so it never goes stale).

- **Photo checks** (adding): exactly one face; that face at least `MIN_FACE_SIZE` px on its shorter
  side (measured after the photo is shrunk to 640 px on its long side); the detector at least
  `MIN_FACE_SCORE` sure. Otherwise you see "No face found", "This photo has N faces", "too small"
  or "isn't clear enough". A close-up where the face fills the whole photo is retried with a border
  around it, because the detector misses faces with no background.
- **"Looks like someone else"** (adding): a face within `DUPLICATE_THRESHOLD` of a person under a
  *different* name is refused — almost certainly the same person under a second name. This limit is
  stricter than `MATCH_THRESHOLD` on purpose, so two colleagues who merely look alike can both be
  added; if the camera then hesitates between them it says **Not sure** instead of guessing.
- **"Not the same person"** (adding): if the name already exists but the new face is farther than
  `MATCH_THRESHOLD` from *every* photo of that person, it is refused — someone else using
  their name. A matching photo is accepted as an extra photo (more angles = better recognition).
- **Names**: capitals and extra spaces don't matter ("  tài " is "Tài"), accents do ("Tài" and "Tai"
  are two people). Up to `MAX_NAME_LENGTH` characters.
- **The unsure margin** (camera): the nearest person must be within `MATCH_THRESHOLD`, or the
  face is **Unknown**. If the runner-up is less than `MATCH_MARGIN` farther away than the
  nearest, the label is **Not sure: A or B?** instead of a guess. Several photos of one person count
  as one person (their closest photo), so you are never "unsure" against yourself.

## Deploy on Cloudflare Pages

1. GitHub → this repository → **Pull requests** → the open pull request → **Merge pull request**.
   Do this first: until it is merged, `main` has no app to build.
2. Cloudflare dashboard → **Workers & Pages** → **Create application**.
3. **Pages** tab → **Import an existing Git repository**.
4. Pick this repository → **Begin setup**. (First time only: **+ Add account** → **Install & Authorize** the Cloudflare GitHub app.)
5. **Project name** becomes the address `<name>.pages.dev`. **Production branch**: `main`.
6. **Build settings**: **Framework preset** None · **Build command** `npm run build` · **Build output directory** `dist`.
   No environment variables — Node comes from `.node-version` (22), the same file CI reads.
7. **Save and Deploy**. When the build finishes, open `https://<name>.pages.dev`.
   A "(!) Some chunks are larger than 500 kB" warning in the build log is expected (the face
   model code is one large file). It is not an error; the build still succeeds.

Every merge to `main` redeploys; every pull request gets its own preview address.
*Verified: 2026-09-23 against Cloudflare's Pages docs.*
Cloudflare now recommends Workers for new projects; this is a plain static `dist/` folder, so it
deploys there too (a Worker with only static assets) — ask Claude if you want to switch.

## Using it

- Open the site on the device with the camera. **Add faces in the same tab** you run the camera in —
  another tab, browser or device starts empty; nothing is shared.
- Closing the tab erases every face. Reloading keeps them.
- The camera needs HTTPS (or `localhost`). `*.pages.dev` is HTTPS. Allow the camera when asked.
- The first load downloads about 22 MB (OpenCV plus two face models); wait for the loading status to finish.
- Best results: good light, face the camera, 2–3 photos per person from slightly different angles.

## Tuning

All in `src/core/faces.ts`. "Safe" = trades convenience for fewer wrong names.

| Constant | Controls | Safe direction |
|---|---|---|
| `MATCH_THRESHOLD` | How close a face must be to count as someone | **Down**: fewer wrong names, more "Unknown". Its value is OpenCV's published SFace threshold. |
| `DUPLICATE_THRESHOLD` | How close a new face must be to someone else's to be refused | **Down**: fewer refusals of look-alikes, more reliance on "Not sure". Keep it below `MATCH_THRESHOLD`. |
| `MATCH_MARGIN` | How clearly the best person must beat the runner-up | **Up**: more "Not sure", fewer mix-ups. |
| `MIN_FACE_SCORE` | How sure the detector must be about an added photo | **Up**: sharper photos only. Below 0.6 does nothing — detection itself stops at 0.6 (`src/vision.ts`). |
| `MIN_FACE_SIZE` | Smallest face (px) accepted when adding | **Up**: close-ups only, better face prints. |
| `MAX_NAME_LENGTH` | Longest name | Either way; the name box follows it. |

To change one, ask Claude Code, e.g. *"Set MATCH_THRESHOLD to 0.45 in src/core/faces.ts"*, review
the pull request, merge. The tests are written relative to these constants, so they keep passing.

## Develop (for Claude or a developer)

```
npm ci             # install
npm run dev        # copy models, start Vite on localhost
npm test           # unit tests: src/core/faces.test.ts
npm run lint       # Biome
npm run typecheck  # tsc
npm run build      # copy models, build dist/
npm run preview    # serve dist/
```

`scripts/copy-models.mjs` checks the SHA-256 of the two model files in `models/` (committed — they
are not on npm; sources and licences in `models/README.md`) and of opencv.js from `node_modules`,
then copies them into `public/` (gitignored). A changed file fails the build. `.github/workflows/ci.yml` runs lint → typecheck → test → build
on every pull request and push to `main`. Code map: `src/core/faces.ts` rules · `src/vision.ts`
OpenCV · `src/gallery.ts` storage · `src/enroll.ts` Add a face · `src/camera.ts` Camera ·
`src/main.ts` tabs and status.

## Undo

- **Take the site down**: Cloudflare → **Workers & Pages** → this project → **Settings** → delete the project (bottom of the page).
- **Undo a change**: GitHub → the merged pull request → **Revert** → merge the new pull request; Pages redeploys the previous version.
- **Erase the faces**: close the tab.

## What would break it

- **Camera blocked or missing** — the page says so. Fix: the icon left of the address → site settings → Camera → Allow, then **Try again**.
- **Model files changed** — the thresholds were tuned on these exact files, so the build refuses
  any other version (checksum mismatch). Swapping a model means re-tuning `src/core/faces.ts`.
- **Storage blocked** (some private modes or strict settings) — an on-screen warning: "This browser
  blocks storage — faces will be forgotten on reload." Everything else still works.
- **Storage full** — sessionStorage holds about 5 MB per site. Each photo (≤ 640 px JPEG) plus its
  face print takes roughly 60–110 KB, so about **50–90 photos** fit. Past that: "Storage is full —
  remove someone first."
- It is a demo, not a lock: never use it to grant access to anything.

## Privacy

Photos and face prints never leave the browser — nothing is uploaded anywhere, and Cloudflare only
serves the site's files. Camera frames are analysed and thrown away; nothing is recorded, and no
audio is used. Add only people who agreed to it.
