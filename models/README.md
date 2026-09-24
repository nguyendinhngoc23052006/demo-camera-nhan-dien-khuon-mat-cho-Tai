# Face models

Committed here because they are not published on npm. `scripts/copy-models.mjs` checks each file's
SHA-256 at dev/build time and copies it to `public/models/`; a changed or corrupt file fails the build.

| File | What | Source | Licence |
|---|---|---|---|
| `face_detection_yunet_2023mar.onnx` | YuNet — finds faces and 5 landmarks | [opencv_zoo/models/face_detection_yunet](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet) | MIT (`LICENSE-yunet`) |
| `face_recognition_sface_2021dec_int8bq.onnx` | SFace — 128-number face print | [opencv_zoo/models/face_recognition_sface](https://github.com/opencv/opencv_zoo/tree/main/models/face_recognition_sface) | Apache-2.0 (`LICENSE-sface`) |

Both run in the browser through opencv.js (`@techstark/opencv-js`, Apache-2.0).

SFace's weights are Apache-2.0, but upstream says it was trained on CASIA-WebFace, VGGFace2 and
MS-Celeb-1M, which are licensed for research only (MS-Celeb-1M was withdrawn). Fine for this demo;
get legal advice before using it in a product you sell.
