"""Builds a tiny stand-in ONNX model with the same input/output layout as Obico's
model-weights.onnx (input [1,3,416,416]; outputs boxes [1,N,1,4] and confs [1,N,1]).
Used only to test the service plumbing where the real 200 MB model is not available.
Confidence = sigmoid(30 * (mean(red) - mean(green))): reddish pictures look like "failures"."""
import sys
import numpy as np
import onnx
from onnx import helper, TensorProto, numpy_helper

out = sys.argv[1] if len(sys.argv) > 1 else "dummy.onnx"
N = 2
inp = helper.make_tensor_value_info("input", TensorProto.FLOAT, [1, 3, 416, 416])
boxes_o = helper.make_tensor_value_info("boxes", TensorProto.FLOAT, [1, N, 1, 4])
confs_o = helper.make_tensor_value_info("confs", TensorProto.FLOAT, [1, N, 1])
inits = [
    numpy_helper.from_array(np.array([[[[0.30, 0.30, 0.60, 0.60]], [[0.32, 0.31, 0.61, 0.62]]]], dtype=np.float32), "boxes_c"),
    numpy_helper.from_array(np.array([[[30.0]], [[-30.0]], [[0.0]]], dtype=np.float32).reshape(1, 3, 1, 1), "w"),
    numpy_helper.from_array(np.array([1, 1, 1], dtype=np.int64), "shape3"),
    numpy_helper.from_array(np.array([1, N, 1], dtype=np.int64), "tile"),
]
nodes = [
    helper.make_node("Identity", ["boxes_c"], ["boxes"]),
    helper.make_node("GlobalAveragePool", ["input"], ["gap"]),          # [1,3,1,1]
    helper.make_node("Mul", ["gap", "w"], ["weighted"]),
    helper.make_node("ReduceSum", ["weighted"], ["logit"], keepdims=1, axes=[1]) if False else
    helper.make_node("ReduceSum", ["weighted", "axes"], ["logit"], keepdims=1),
    helper.make_node("Sigmoid", ["logit"], ["sig"]),                    # [1,1,1,1]
    helper.make_node("Reshape", ["sig", "shape3"], ["sig3"]),           # [1,1,1]
    helper.make_node("Tile", ["sig3", "tile"], ["confs"]),              # [1,N,1]
]
inits.append(numpy_helper.from_array(np.array([1], dtype=np.int64), "axes"))
g = helper.make_graph(nodes, "dummy_failure", [inp], [boxes_o, confs_o], inits)
m = helper.make_model(g, opset_imports=[helper.make_opsetid("", 13)])
m.ir_version = 8
onnx.checker.check_model(m)
onnx.save(m, out)
print("wrote", out)
