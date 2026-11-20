"""CUDA-only EasyOCR runtime. Install matching Jetson torch/torchvision first."""
import argparse
import importlib
import json
import threading

ENGINE = 'easyocr-cuda'
_reader = None
_lock = threading.Lock()
_error = None


class GPUUnavailable(RuntimeError):
    pass


def get_reader(download=False):
    global _reader, _error
    with _lock:
        if _reader is not None:
            return _reader
        try:
            torch = importlib.import_module('torch')
            if not torch.cuda.is_available():
                raise GPUUnavailable('CUDA_UNAVAILABLE')
            # Real allocation/kernel/synchronization catches incompatible wheels.
            (torch.ones(1, device='cuda:0') + 1).cpu()
            torch.cuda.synchronize()
            easyocr = importlib.import_module('easyocr')
            reader = easyocr.Reader(['ko', 'en'], gpu='cuda:0',
                download_enabled=download, verbose=False, quantize=False)
            for network in (reader.detector, reader.recognizer):
                if any(p.device.type != 'cuda' for p in network.parameters()):
                    raise GPUUnavailable('MODEL_NOT_ON_CUDA')
            # Warm both detector and recognizer, not merely CUDA allocation.
            np = importlib.import_module('numpy')
            sample = np.full((64, 256, 3), 255, dtype=np.uint8)
            with torch.inference_mode():
                reader.readtext(sample, batch_size=1, workers=0, paragraph=False)
                reader.recognize(sample, detail=1, batch_size=1, workers=0)
            torch.cuda.synchronize()
            _reader, _error = reader, None
            return _reader
        except Exception as exc:
            # No dependency error text or paths are exposed through the API.
            _error = str(exc) if isinstance(exc, GPUUnavailable) else 'CUDA_OCR_INIT_FAILED'
            raise GPUUnavailable(_error) from exc


def state():
    return {'ocrEngine': ENGINE, 'ocrDevice': 'cuda:0' if _reader is not None else None,
            'ocrError': _error}


def read_crop(image):
    reader = get_reader()
    torch = importlib.import_module('torch')
    np = importlib.import_module('numpy')
    try:
        with torch.inference_mode():
            return reader.readtext(np.asarray(image), detail=1, paragraph=False,
                batch_size=1, workers=0, canvas_size=2200, mag_ratio=1,
                width_ths=.1, ycenter_ths=.3, height_ths=.3,
                contrast_ths=.2, adjust_contrast=.5)
    except RuntimeError as exc:
        # Includes CUDA out-of-memory. Never retry on the CPU.
        raise GPUUnavailable('CUDA_OCR_INFERENCE_FAILED') from exc


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--download-models', action='store_true')
    parser.add_argument('--debug', action='store_true', help='Print local dependency traceback on failure')
    args = parser.parse_args()
    try:
        get_reader(download=args.download_models)
    except GPUUnavailable:
        if args.debug:
            import traceback
            traceback.print_exc()
        print(json.dumps(state()))
        raise SystemExit(1)
    print(json.dumps(state()))


if __name__ == '__main__':
    main()
