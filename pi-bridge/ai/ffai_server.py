#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""
FlashForge Pi Bridge - local AI print-failure detection service.

Runs Obico's open-source failure-detection model (https://github.com/TheSpaghettiDetective/obico-server,
ml_api, AGPL-3.0) with ONNX Runtime on the board's CPU. The pre/post-processing below is ported
from obico-server/ml_api/lib/onnx.py; this file is therefore AGPL-3.0 as well and runs as a
separate process from the (MIT) bridge.

HTTP API (localhost only):
  GET  /health   -> {"ready": bool, "model": str, "backend": str, "avg_ms": float, "error": str}
  POST /detect   body = JPEG bytes
                 -> {"detections": [[label, confidence, [xc, yc, w, h]], ...],
                     "width": W, "height": H, "ms": inference_ms}

Environment:
  FFAI_MODEL     path to model-weights.onnx   (default /opt/ffbridge/ai/model/model-weights.onnx)
  FFAI_PORT      default 3333
  FFAI_HOST      default 127.0.0.1
  FFAI_THREADS   ONNX Runtime intra-op threads (default: number of CPUs, max 4)
  FFAI_THRESH    minimum detection confidence (default 0.08, same as Obico)

Usage on the board:  python3 ffai_server.py
Benchmark:           python3 ffai_server.py --benchmark some.jpg
"""
import io
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
from PIL import Image

MODEL_PATH = os.environ.get("FFAI_MODEL", "/opt/ffbridge/ai/model/model-weights.onnx")
PORT = int(os.environ.get("FFAI_PORT", "3333"))
HOST = os.environ.get("FFAI_HOST", "127.0.0.1")
THRESH = float(os.environ.get("FFAI_THRESH", "0.08"))
NMS_THRESH = 0.45
NAMES = ["failure"]
MAX_UPLOAD = 16 * 1024 * 1024


class Detector:
    def __init__(self, model_path):
        self.model_path = model_path
        self.session = None
        self.error = ""
        self.backend = ""
        self.lock = threading.Lock()  # one inference at a time keeps RAM/CPU predictable
        self.times = []

    def load(self):
        try:
            import onnxruntime as ort

            opts = ort.SessionOptions()
            threads = int(os.environ.get("FFAI_THREADS", "0")) or min(4, os.cpu_count() or 1)
            opts.intra_op_num_threads = threads
            opts.inter_op_num_threads = 1
            opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
            self.session = ort.InferenceSession(self.model_path, sess_options=opts, providers=["CPUExecutionProvider"])
            inp = self.session.get_inputs()[0]
            self.input_name = inp.name
            self.input_h = int(inp.shape[2]) if isinstance(inp.shape[2], int) else 416
            self.input_w = int(inp.shape[3]) if isinstance(inp.shape[3], int) else 416
            self.backend = f"ONNX Runtime CPU, {threads} threads"
            self.error = ""
            # warm-up so the first real check is not slow
            self.detect_array(np.zeros((self.input_h, self.input_w, 3), dtype=np.uint8))
            self.times.clear()
            log(f"model loaded: {self.model_path} ({self.input_w}x{self.input_h}), {self.backend}")
        except Exception as e:  # noqa: BLE001 - report any failure on /health
            self.session = None
            self.error = f"Could not load the AI model: {e}"
            log(self.error)

    @property
    def ready(self):
        return self.session is not None

    def detect_jpeg(self, data):
        img = Image.open(io.BytesIO(data))
        img = img.convert("RGB")
        return self.detect_array(np.asarray(img), size=img.size)

    def detect_array(self, rgb, size=None):
        width, height = size if size else (rgb.shape[1], rgb.shape[0])
        # Obico: cv2.resize(INTER_LINEAR) -> RGB -> CHW float32 / 255
        if rgb.shape[0] != self.input_h or rgb.shape[1] != self.input_w:
            rgb = np.asarray(Image.fromarray(rgb).resize((self.input_w, self.input_h), Image.BILINEAR))
        x = np.transpose(rgb, (2, 0, 1)).astype(np.float32)[None] / 255.0
        with self.lock:
            t0 = time.perf_counter()
            outputs = self.session.run(None, {self.input_name: x})
            ms = (time.perf_counter() - t0) * 1000
        self.times = (self.times + [ms])[-30:]
        dets = post_processing(outputs, width, height, THRESH, NMS_THRESH, NAMES)
        return {"detections": dets, "width": width, "height": height, "ms": round(ms)}

    def health(self):
        return {
            "ready": self.ready,
            "model": os.path.basename(self.model_path),
            "backend": self.backend,
            "avg_ms": round(sum(self.times) / len(self.times), 1) if self.times else 0,
            "error": self.error,
        }


# ---- post-processing ported from obico-server/ml_api/lib/onnx.py (AGPL-3.0) ----
def nms_cpu(boxes, confs, nms_thresh=0.5):
    x1, y1, x2, y2 = boxes[:, 0], boxes[:, 1], boxes[:, 2], boxes[:, 3]
    areas = (x2 - x1) * (y2 - y1)
    order = confs.argsort()[::-1]
    keep = []
    while order.size > 0:
        i = order[0]
        keep.append(i)
        xx1 = np.maximum(x1[i], x1[order[1:]])
        yy1 = np.maximum(y1[i], y1[order[1:]])
        xx2 = np.minimum(x2[i], x2[order[1:]])
        yy2 = np.minimum(y2[i], y2[order[1:]])
        inter = np.maximum(0.0, xx2 - xx1) * np.maximum(0.0, yy2 - yy1)
        over = inter / (areas[i] + areas[order[1:]] - inter + 1e-12)
        order = order[np.where(over <= nms_thresh)[0] + 1]
    return np.array(keep)


def post_processing(output, width, height, conf_thresh, nms_thresh, names):
    box_array = np.asarray(output[0])[:, :, 0]  # [batch, num, 4] (x1, y1, x2, y2 normalised)
    confs = np.asarray(output[1])  # [batch, num, classes]
    num_classes = confs.shape[2]
    max_conf = np.max(confs, axis=2)
    max_id = np.argmax(confs, axis=2)
    out = []
    i = 0  # batch of one
    keep_mask = max_conf[i] > conf_thresh
    l_box, l_conf, l_id = box_array[i, keep_mask, :], max_conf[i, keep_mask], max_id[i, keep_mask]
    for j in range(num_classes):
        cls = l_id == j
        bb, cc = l_box[cls, :], l_conf[cls]
        if bb.shape[0] == 0:
            continue
        keep = nms_cpu(bb, cc, nms_thresh)
        for k in keep:
            b = bb[k]
            # Obico uses the image *width* for the box height too; kept identical for parity.
            out.append([
                names[j] if j < len(names) else str(j),
                float(cc[k]),
                [float(0.5 * width * (b[0] + b[2])), float(0.5 * height * (b[1] + b[3])),
                 float(width * (b[2] - b[0])), float(width * (b[3] - b[1]))],
            ])
    return out


# ---- HTTP ----
detector = Detector(MODEL_PATH)


def log(msg):
    print(time.strftime("%Y-%m-%d %H:%M:%S"), msg, flush=True)


class Handler(BaseHTTPRequestHandler):
    server_version = "ffai/1.0"

    def log_message(self, fmt, *args):  # keep journal quiet
        pass

    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/health"):
            return self._send(200, detector.health())
        self._send(404, {"error": "not found"})

    def do_POST(self):
        if not self.path.startswith("/detect"):
            return self._send(404, {"error": "not found"})
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0 or n > MAX_UPLOAD:
            return self._send(400, {"error": "send a JPEG image as the request body"})
        data = self.rfile.read(n)
        if not detector.ready:
            return self._send(503, {"error": detector.error or "model is still loading"})
        try:
            return self._send(200, detector.detect_jpeg(data))
        except Exception as e:  # noqa: BLE001
            return self._send(400, {"error": f"could not analyse image: {e}"})


def main():
    if len(sys.argv) > 2 and sys.argv[1] == "--benchmark":
        detector.load()
        if not detector.ready:
            sys.exit(1)
        data = open(sys.argv[2], "rb").read()
        for _ in range(int(sys.argv[3]) if len(sys.argv) > 3 else 10):
            r = detector.detect_jpeg(data)
            print(f"{r['ms']} ms, {len(r['detections'])} detection(s): " +
                  ", ".join(f"{d[1]:.2f}" for d in r["detections"]))
        print("average", detector.health()["avg_ms"], "ms")
        return
    threading.Thread(target=detector.load, daemon=True).start()
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    srv.daemon_threads = True
    log(f"AI service listening on http://{HOST}:{PORT} (model {MODEL_PATH})")
    srv.serve_forever()


if __name__ == "__main__":
    main()
