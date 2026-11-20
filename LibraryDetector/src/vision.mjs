// Model versions are pinned; the photographed image stays in this browser during OCR.
const VISION = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.32';
const TESSERACT = 'https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/dist/tesseract.min.js';
const MODEL = 'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float32/1/efficientdet_lite0.tflite';
let ocrPromise, detectorPromise;

function loadScript(url) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = url; script.crossOrigin = 'anonymous';
    script.onload = resolve;
    script.onerror = () => { script.remove(); reject(Error('OCR 라이브러리를 내려받지 못했습니다. 인터넷 연결을 확인하세요.')); };
    document.head.append(script);
  });
}
export async function getOCR(report = () => {}) {
  if (!ocrPromise) {
    ocrPromise = (async () => {
      report('한글·영문 OCR 모델 준비 중… 첫 실행에는 다운로드 시간이 필요합니다.');
      if (!globalThis.Tesseract) await loadScript(TESSERACT);
      const worker = await globalThis.Tesseract.createWorker(['kor','eng'], 1, {
        workerPath: 'https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/dist/worker.min.js',
        corePath: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@6.0.0',
      });
      await worker.setParameters({tessedit_pageseg_mode: '11', preserve_interword_spaces: '1'});
      return worker;
    })().catch(error => { ocrPromise = null; throw error; });
  }
  return ocrPromise;
}
export async function detectBooks(canvas, report = () => {}) {
  if (!detectorPromise) {
    detectorPromise = (async () => {
      report('MediaPipe 책 영역 탐지 모델 준비 중…');
      const {FilesetResolver, ObjectDetector} = await import(`${VISION}/vision_bundle.mjs`);
      const files = await FilesetResolver.forVisionTasks(`${VISION}/wasm`);
      return ObjectDetector.createFromOptions(files, {
        baseOptions: {modelAssetPath: MODEL, delegate: 'CPU'},
        runningMode: 'IMAGE', scoreThreshold: 0.3, maxResults: 40, categoryAllowlist: ['book'],
      });
    })().catch(error => { detectorPromise = null; throw error; });
  }
  const detector = await detectorPromise;
  return detector.detect(canvas).detections.map(d => ({
    x: d.boundingBox.originX, y: d.boundingBox.originY,
    width: d.boundingBox.width, height: d.boundingBox.height,
    score: d.categories[0]?.score ?? 0,
  }));
}

// Never let a detector box spanning two cells merge their OCR or position indexes.
export function refineBox(cell, candidates) {
  let best = null, bestScore = 0;
  for (const candidate of candidates) {
    const x = Math.max(cell.x, candidate.x), y = Math.max(cell.y, candidate.y);
    const w = Math.min(cell.x + cell.width, candidate.x + candidate.width) - x;
    const h = Math.min(cell.y + cell.height, candidate.y + candidate.height) - y;
    if (w <= 0 || h <= 0) continue;
    const area = w * h, coverage = area / (cell.width * cell.height);
    const contained = area / (candidate.width * candidate.height);
    if (coverage >= .4 && contained >= .85 && coverage > bestScore) {
      bestScore = coverage; best = {x, y, width: w, height: h};
    }
  }
  return best ?? cell;
}
export function cropCanvas(source, box, scale = 1) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(box.width * scale));
  canvas.height = Math.max(1, Math.round(box.height * scale));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, box.x, box.y, box.width, box.height, 0, 0, canvas.width, canvas.height);
  return canvas;
}
export async function releaseModels() {
  const worker = ocrPromise; ocrPromise = null;
  if (worker) worker.then(w => w.terminate()).catch(() => {});
  const detector = detectorPromise; detectorPromise = null;
  if (detector) detector.then(d => d.close()).catch(() => {});
}
