"""CUDA OCR pipeline. Photos remain in memory; no CPU inference fallback."""
import io
import json
import math
from pathlib import Path
import shutil
import subprocess
import time

from PIL import Image, ImageOps, UnidentifiedImageError
from . import gpu_ocr

MAX_PIXELS = 18_000_000
MAX_BYTES = 12 * 1024 * 1024


def readiness():
    if not shutil.which('node'):
        return False
    try:
        gpu_ocr.get_reader()
        return True
    except gpu_ocr.GPUUnavailable:
        return False


def decode_photo(raw):
    if not 0 < len(raw) <= MAX_BYTES:
        raise ValueError('사진은 12MB 이하여야 합니다.')
    try:
        with Image.open(io.BytesIO(raw), formats=['JPEG']) as source:
            if source.width * source.height > MAX_PIXELS or max(source.size) > 6000:
                raise ValueError('사진은 1800만 화소, 한 변 6000px 이하여야 합니다.')
            source.load()
            return ImageOps.exif_transpose(source).convert('RGB')
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
        raise ValueError('올바른 JPEG 사진이 필요합니다.') from exc


def tiles(width, height):
    # Overlap avoids cutting labels at an artificial tile boundary.
    for row in range(2):
        for col in range(3):
            yield (max(0, int(width * (col / 3 - .06))),
                   max(0, int(height * (row / 2 - .08))),
                   min(width, math.ceil(width * ((col + 1) / 3 + .06))),
                   min(height, math.ceil(height * ((row + 1) / 2 + .08))))


def gpu_words(results, x, y, sx, sy):
    words = []
    for polygon, text, score in results:
        if not str(text).strip():
            continue
        confidence = float(score) * 100
        if not math.isfinite(confidence) or not 0 <= confidence <= 100:
            continue
        xs, ys = [float(p[0]) for p in polygon], [float(p[1]) for p in polygon]
        if not xs or not all(math.isfinite(v) for v in xs+ys):
            continue
        left, top, right, bottom = min(xs), min(ys), max(xs), max(ys)
        if right <= left or bottom <= top:
            continue
        # EasyOCR emits line fragments; remove OCR spacing within each fragment.
        words.append({'text': ''.join(str(text).split()), 'confidence': confidence, 'bbox': {
            'x0': x + left / sx, 'y0': y + top / sy,
            'x1': x + right / sx, 'y1': y + bottom / sy}})
    return words


def deduplicate(words):
    output = []
    for word in sorted(words, key=lambda w: -w['confidence']):
        a = word['bbox']
        duplicate = False
        for old in output:
            b = old['bbox']
            intersection = max(0, min(a['x1'], b['x1']) - max(a['x0'], b['x0'])) * max(0, min(a['y1'], b['y1']) - max(a['y0'], b['y0']))
            area = min((a['x1']-a['x0'])*(a['y1']-a['y0']), (b['x1']-b['x0'])*(b['y1']-b['y0']))
            if area > 0 and intersection / area > .65:
                if old['text'] != word['text']:
                    old['confidence'] = min(old['confidence'], 40)
                duplicate = True
                break
        if not duplicate:
            output.append(word)
    return output


def recognize(image):
    deadline = time.monotonic() + 170
    words = []
    for left, top, right, bottom in tiles(*image.size):
        crop = ImageOps.autocontrast(ImageOps.grayscale(image.crop((left, top, right, bottom))), cutoff=1)
        scale = min(3, 2200 / max(crop.size))
        width, height = crop.size
        crop = crop.resize((max(1, round(width*scale)), max(1, round(height*scale))), Image.Resampling.LANCZOS)
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('OCR timeout')
        result = gpu_ocr.read_crop(crop)
        if time.monotonic() > deadline:
            raise TimeoutError('OCR timeout')
        words.extend(gpu_words(result, left, top, crop.width/width, crop.height/height))
        if len(words) > 12000:
            raise ValueError('글자가 너무 많습니다. 책장 한 칸만 촬영해주세요.')
    words = deduplicate(words)
    result = subprocess.run(['node', str(Path(__file__).with_name('labels.mjs'))],
                            input=json.dumps(words, ensure_ascii=False).encode('utf-8'), capture_output=True, timeout=15, check=True)
    observations = json.loads(result.stdout)
    for item in observations:
        b = item['bbox']
        b['width'] = min(b['width'], image.width-b['x'])
        b['height'] = min(b['height'], image.height-b['y'])
        if not item.get('callNumber'):
            item['confidence'] = 0
    return observations
