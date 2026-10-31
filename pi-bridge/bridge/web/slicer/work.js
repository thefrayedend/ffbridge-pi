// Background worker for the slicer page: reading a 3MF and simplifying a model take seconds to
// tens of seconds for big files; here they run off the page's main thread, so the page stays
// responsive and the progress message keeps moving. slicer.js falls back to doing the same work
// on the main thread when workers are not available.
import { import3mf } from './project3mf.js';
import { simplifyModel } from './simplify.js';

self.onmessage = async (e) => {
  const { id, op, data } = e.data;
  try {
    if (op === 'import') {
      const r = import3mf(data.buffer);
      // the big arrays move to the page instead of being copied
      const transfer = r.objects.map((o) => o.positions.buffer);
      self.postMessage({ id, ok: true, result: r }, transfer);
    } else if (op === 'simplify') {
      const r = await simplifyModel(data.positions, data.paint, data.target, data.maxErr);
      self.postMessage({ id, ok: true, result: r }, [r.positions.buffer]);
    } else throw new Error('Unknown job ' + op);
  } catch (err) {
    self.postMessage({ id, ok: false, error: (err && err.message) || String(err) });
  }
};
