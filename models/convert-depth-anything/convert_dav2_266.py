# Steps for convert_dav2_266.sh. Each step is the exact code used to build the shipped model.
# usage: python convert_dav2_266.py <step> ; runs in the current working directory.
import sys
step = sys.argv[1]

if step == 'clean':  # upstream ONNX -> plain opset-18 graph: inline functions, ORT basic folding, onnxsim
    import onnx, onnxruntime as ort, onnxsim
    from onnx import inliner, helper
    m = inliner.inline_local_functions(onnx.load('depth_anything_v2_vits.onnx'))
    del m.opset_import[:]; m.opset_import.extend([helper.make_opsetid('', 18)]); onnx.save(m, '_a.onnx')
    so = ort.SessionOptions(); so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_BASIC; so.optimized_model_filepath = '_b.onnx'
    ort.InferenceSession('_a.onnx', so, providers=['CPUExecutionProvider'])
    m = onnx.load('_b.onnx'); del m.opset_import[:]; m.opset_import.extend([helper.make_opsetid('', 18)])
    m, ok = onnxsim.simplify(m); assert ok
    onnx.save(m, 'dav2_clean.onnx'); print('clean: nodes', len(m.graph.node))

elif step == 'fix':  # three onnx2tf blockers, applied in this order
    import onnx, numpy as np
    from onnx import helper, numpy_helper, shape_inference
    # 1. LayerNormalization: drop unused mean/inv-std outputs (onnx2tf KeyError 'native_layer_norm_1__7')
    m = onnx.load('dav2_clean.onnx'); used = {i for n in m.graph.node for i in n.input} | {o.name for o in m.graph.output}; k = 0
    for n in m.graph.node:
        if n.op_type == 'LayerNormalization' and len(n.output) > 1:
            assert not any(o in used for o in n.output[1:]); del n.output[1:]; k += 1
    onnx.checker.check_model(m); onnx.save(m, 'dav2_clean.onnx'); print('fix: LayerNorm outputs stripped', k)
    # 2. Conv/ConvTranspose: explicit kernel_shape (onnx2tf ConvTranspose 'axes don't match array')
    m = onnx.load('dav2_clean.onnx'); inits = {i.name: i for i in m.graph.initializer}; k = 0
    for n in m.graph.node:
        if n.op_type in ('Conv', 'ConvTranspose') and not any(a.name == 'kernel_shape' for a in n.attribute):
            n.attribute.append(helper.make_attribute('kernel_shape', list(inits[n.input[1]].dims[2:]))); k += 1
    onnx.save(m, 'dav2_clean.onnx'); print('fix: kernel_shape added', k)
    # 3. Resize given by scales with an empty trailing 'sizes' input -> static sizes (onnx2tf Resize KeyError '')
    m = onnx.load('dav2_clean.onnx'); mi = shape_inference.infer_shapes(m)
    shp = {v.name: [d.dim_value for d in v.type.tensor_type.shape.dim] for v in list(mi.graph.value_info) + list(mi.graph.input)}
    inits = {i.name: i for i in m.graph.initializer}
    for n in m.graph.node:
        if n.op_type == 'Resize':
            ins = list(n.input)
            if len(ins) == 4 and ins[3] == '' and ins[2]:
                sc = numpy_helper.to_array(inits[ins[2]]); s = shp[ins[0]]; sizes = np.array([int(round(a * b)) for a, b in zip(s, sc)], dtype=np.int64)
                name = n.name + '_sizes'; m.graph.initializer.append(numpy_helper.from_array(sizes, name))
                del n.input[:]; n.input.extend([ins[0], '', '', name]); print('fix: Resize', n.name, s, sc, sizes)
    onnx.checker.check_model(m); onnx.save(m, 'dav2_clean.onnx')

elif step == 'resize266':  # 518 (37x37 patches) -> 266 (19x19): bicubic pos-embed resize + every grid-dependent shape constant
    import onnx, numpy as np, tensorflow as tf
    from onnx import numpy_helper
    g = 19
    m = onnx.load('dav2_clean.onnx')
    mp = {1369: g * g, 1370: g * g + 1, 37: g, 74: 2 * g, 148: 4 * g, 296: 8 * g, 518: 14 * g}
    for idx, i in enumerate(m.graph.initializer):
        a = numpy_helper.to_array(i)
        if i.name == 'pretrained.pos_embed':
            cls = a[:, :1]; grid = a[0, 1:].reshape(37, 37, 384)
            r = tf.image.resize(grid[None], (g, g), method='bicubic', antialias=False).numpy()[0].reshape(1, g * g, 384)
            new = np.concatenate([cls, r], 1).astype(np.float32)
            m.graph.initializer[idx].CopyFrom(numpy_helper.from_array(new, i.name))
        elif a.dtype == np.int64 and a.size <= 8 and any(v in mp for v in a.ravel().tolist()) and i.name != '':
            b = np.array([mp.get(v, v) if v not in (1, 3, 6, 64, 384, 1536, 32) else v for v in a.ravel().tolist()], dtype=np.int64).reshape(a.shape)
            m.graph.initializer[idx].CopyFrom(numpy_helper.from_array(b, i.name))
    for x in (m.graph.input[0], m.graph.output[0]):
        for d in x.type.tensor_type.shape.dim:
            if d.dim_value == 518: d.dim_value = 14 * g
    del m.graph.value_info[:]
    onnx.checker.check_model(m); onnx.save(m, 'dav2_266.onnx'); print('resize266: saved dav2_266.onnx')

elif step == 'calib':  # onnx2tf downloads this file from a release that now 404s; build it from the 3 pinned photos
    import tensorflow as tf, numpy as np
    ims = [tf.image.resize(tf.io.decode_jpeg(open(f'{n}.jpg', 'rb').read()), (128, 128)).numpy() / 255. for n in ('demo10', 'demo15', 'demo13')]
    a = np.stack([ims[i % 3] for i in range(20)]).astype(np.float32)
    np.save('calibration_image_sample_data_20x128x128x3_float32.npy', a); print('calib', a.shape)

else:
    sys.exit(f'unknown step {step}')
