#!/usr/bin/env bash
# Reproduce dav2_266_f16.tflite (+ .part0/.part1) from the public Depth Anything V2 Small ONNX export.
# usage: convert_dav2_266.sh [workdir]   (default: a fresh mktemp dir). Needs python3.11, network to github + pypi.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
W="${1:-$(mktemp -d)}"; mkdir -p "$W"; cd "$W"; echo "workdir: $W"

# Upstream: fabio-sim/Depth-Anything-ONNX release v2.0.0 (tag commit 40ed31643bea3f537201aeb7752d8a16b6d6d178),
# a TorchDynamo export of DepthAnything/Depth-Anything-V2 ViT-S (Apache-2.0), input 1x3x518x518.
SRC_URL=https://github.com/fabio-sim/Depth-Anything-ONNX/releases/download/v2.0.0/depth_anything_v2_vits.onnx
SRC_SHA=d2b11a11c1d4a12b47608fa65a17ee9a4c605b55ee1730c8e3b526304f2562be
# Calibration photos for onnx2tf's own output check (they do not change weights): DAv2 repo @ a561b849.
IMG_BASE=https://raw.githubusercontent.com/DepthAnything/Depth-Anything-V2/a561b849ebae10a6f5ef49e26c83cbbcd36c71bf/assets/examples
declare -A IMG_SHA=([demo10]=bc77f215081f58de8d079e821e2808f6ee2727dfa729c10a5921c186a32c7638
                    [demo15]=bf60ce3879f627e8886280cc61442174c91908894a5b059681341fed600f7db3
                    [demo13]=9168fc752a002d50138a56621e8de5fab7fed125a978dd293319d28d30993564)
EXPECT_TFLITE=9dc0a35776a8a296eb723b514eb3cd083af0b11b1bbe9c5163c8bb66c75b4e44

curl -fsSL -o depth_anything_v2_vits.onnx "$SRC_URL"
echo "$SRC_SHA  depth_anything_v2_vits.onnx" | sha256sum -c -
for n in demo10 demo15 demo13; do curl -fsSL -o $n.jpg "$IMG_BASE/$n.jpg"; echo "${IMG_SHA[$n]}  $n.jpg" | sha256sum -c -; done

# Pinned toolchain (pip freeze of the venv that built the shipped file); --no-deps installs exactly these versions.
python3.11 -m venv venv
./venv/bin/pip install -q pip==24.0
./venv/bin/pip install -q --no-deps -r "$HERE/requirements-convert.lock"
PY=./venv/bin/python

$PY "$HERE/convert_dav2_266.py" clean
$PY "$HERE/convert_dav2_266.py" fix
$PY "$HERE/convert_dav2_266.py" resize266
$PY "$HERE/convert_dav2_266.py" calib
# -n: skip onnxsim inside onnx2tf; -rtpo Erf: replace Erf with builtin ops (tfjs/LiteRT cannot run FlexErf).
./venv/bin/onnx2tf -i dav2_266.onnx -o tf_dav2_266 -n -rtpo Erf > onnx2tf.log 2>&1 || { tail -30 onnx2tf.log; exit 1; }
cp tf_dav2_266/dav2_266_float16.tflite dav2_266_f16.tflite
split -b 24M -d -a 1 dav2_266_f16.tflite dav2_266_f16.part

sha256sum dav2_266_f16.tflite dav2_266_f16.part0 dav2_266_f16.part1
if [ "$(sha256sum dav2_266_f16.tflite | cut -d' ' -f1)" = "$EXPECT_TFLITE" ]; then echo "MATCH: byte-identical to the shipped model"; else echo "DIFFERENT BYTES from $EXPECT_TFLITE (compare outputs instead)"; fi
