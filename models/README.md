# Face models

Committed here because they are not published on npm. `scripts/copy-models.mjs` checks each file's
SHA-256 at dev/build time and copies it to `public/models/`; a changed or corrupt file fails the build.

| File | What | Source | Licence |
|---|---|---|---|
| `face_detection_yunet_2023mar.onnx` | YuNet — finds faces and 5 landmarks | [opencv_zoo/models/face_detection_yunet](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet) | MIT (`LICENSE-yunet`) |
| `face_recognition_sface_2021dec_int8bq.onnx` | SFace — 128-number face print | [opencv_zoo/models/face_recognition_sface](https://github.com/opencv/opencv_zoo/tree/main/models/face_recognition_sface) | Apache-2.0 (`LICENSE-sface`) |
| `dav2_266_f16.part0` + `.part1` | Depth Anything V2 Small at 266 px, fp16 TFLite — relative depth from one camera image (3D room, phones without depth sensing) | Converted from [Depth-Anything-ONNX v2.0.0](https://github.com/fabio-sim/Depth-Anything-ONNX/releases/tag/v2.0.0) `depth_anything_v2_vits.onnx` by `convert-depth-anything/convert_dav2_266.sh` | Apache-2.0 (`LICENSE-depth-anything`; only the Small model is Apache — Base/Large are non-commercial) |

YuNet and SFace run in the browser through opencv.js (`@techstark/opencv-js`, Apache-2.0); the depth
model through LiteRT.js (`@litertjs/core`, Apache-2.0 — TensorFlow Lite for the web).

The depth model is split in two because Cloudflare Pages serves files up to 25 MiB. To rebuild it
from the public source (needs python3.11 and network), run
`models/convert-depth-anything/convert_dav2_266.sh`: it pins every tool version and prints MATCH when
the result is byte-identical to the committed parts (checked 2026-09-24).

SFace's weights are Apache-2.0, but upstream says it was trained on CASIA-WebFace, VGGFace2 and
MS-Celeb-1M, which are licensed for research only (MS-Celeb-1M was withdrawn). Fine for this demo;
get legal advice before using it in a product you sell.
