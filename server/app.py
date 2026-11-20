"""Run from project root: python -m server.app. Put HTTPS in front for phones."""
import argparse
import hmac
import ipaddress
import os
import subprocess
from http.server import ThreadingHTTPServer
from urllib.parse import urlsplit

from . import core, ocr, gpu_ocr


class Handler(core.Handler):
    def end_headers(self):
        origin = self.headers.get('Origin', '')
        if origin in self.server.allowed_origins:
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')
            self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
            self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        super().end_headers()

    def origin_allowed(self):
        origin = self.headers.get('Origin')
        return not origin or origin in self.server.allowed_origins or (
            urlsplit(origin).scheme in ('http', 'https') and urlsplit(origin).netloc == self.headers.get('Host'))

    def do_OPTIONS(self):
        if not self.host_allowed() or not self.origin_allowed():
            return self.send_json(403, {'error': '허용되지 않은 출처입니다.'})
        self.send_json(200, {})

    def do_GET(self):
        if urlsplit(self.path).path == '/api/health' and self.host_allowed():
            return self.send_json(200, {'configured': bool(os.environ.get('GADIA_API_KEY', '').strip()),
                'model': os.environ.get('GADIA_MODEL', core.DEFAULT_MODEL), 'photoInspection': True,
                'ocrReady': self.server.ocr_ready, **gpu_ocr.state(),
                'authenticationRequired': bool(self.server.access_token)})
        return super().do_GET()

    def do_POST(self):
        # Authenticate both the photo API and the legacy text endpoint.
        if not self.host_allowed() or not self.origin_allowed():
            return self.send_json(403, {'error': '허용되지 않은 출처입니다.'})
        token = self.server.access_token
        host = urlsplit('//' + self.headers.get('Host', '')).hostname
        if not token and host not in ('localhost', '127.0.0.1', '::1'):
            return self.send_json(503, {'error': '외부 접속용 서버 접속 코드 설정이 필요합니다.'})
        if token and not hmac.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + token):
            return self.send_json(401, {'error': '서버 접속 코드를 확인해주세요.'})
        if urlsplit(self.path).path != '/api/inspect':
            return super().do_POST()
        if self.headers.get('Content-Type', '').split(';')[0] != 'image/jpeg' or self.headers.get('Transfer-Encoding'):
            return self.send_json(415, {'error': 'JPEG 사진으로 전송해주세요.'})
        try:
            length = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            return self.send_json(400, {'error': '사진 크기가 올바르지 않습니다.'})
        if not 0 < length <= ocr.MAX_BYTES:
            return self.send_json(413, {'error': '사진은 12MB 이하여야 합니다.'})
        key = os.environ.get('GADIA_API_KEY', '').strip()
        if not self.server.ocr_ready or not key:
            return self.send_json(503, {'error': '서버 OCR 또는 AI 설정이 준비되지 않았습니다.'})
        if not core.INFERENCE_LOCK.acquire(blocking=False):
            return self.send_json(409, {'error': '다른 사진을 검사 중입니다. 잠시 후 다시 시도하세요.'})
        try:
            raw = self.rfile.read(length)
            if len(raw) != length:
                raise ValueError('사진 전송이 완료되지 않았습니다.')
            photo = ocr.decode_photo(raw)
            width, height = photo.size
            try:
                observations = ocr.recognize(photo)
            finally:
                photo.close()
            if len(observations) < 2:
                result = {'summary': '비교할 라벨이 부족합니다. 더 가까이 촬영해주세요.', 'items': [
                    {'index': o['index'], 'status': 'uncertain', 'confidence': 0, 'reason': '비교할 라벨이 부족합니다.'} for o in observations]}
            else:
                payload = core.validate_payload({'observations': observations})
                result = core.generate_analysis(payload, key, os.environ.get('GADIA_MODEL', core.DEFAULT_MODEL))
            result.update(observations=observations, image={'width': width, 'height': height},
                          model=os.environ.get('GADIA_MODEL', core.DEFAULT_MODEL), ocrEngine=gpu_ocr.ENGINE, ocrDevice='cuda:0')
            self.send_json(200, result)
        except gpu_ocr.GPUUnavailable:
            self.send_json(503, {'error': 'CUDA OCR 실행에 실패했습니다. GPU 메모리와 JetPack/PyTorch 구성을 확인하세요.'})
        except ValueError:
            self.send_json(422, {'error': '사진 또는 분석 결과를 읽지 못했습니다. 선명한 JPEG 사진으로 다시 시도하세요.'})
        except (TimeoutError, subprocess.TimeoutExpired):
            self.send_json(504, {'error': '분석 시간이 초과되었습니다. 촬영 범위를 줄여 다시 시도하세요.'})
        except (OSError, subprocess.CalledProcessError, KeyError, TypeError):
            self.send_json(502, {'error': 'OCR 또는 AI 처리에 실패했습니다. 서버 설치 상태와 연결을 확인하세요.'})
        finally:
            core.INFERENCE_LOCK.release()


def create_server(host='127.0.0.1', port=8000):
    core.load_env_files()
    token = os.environ.get('DETECTOR_ACCESS_TOKEN', '').strip()
    if host != 'localhost' and not ipaddress.ip_address(host).is_loopback and len(token) < 24:
        raise ValueError('외부 접속에는 24자 이상의 DETECTOR_ACCESS_TOKEN이 필요합니다.')
    server = ThreadingHTTPServer((host, port), Handler)
    server.allowed_hosts = set(filter(None, (v.strip() for v in os.environ.get('DETECTOR_ALLOWED_HOSTS', '').split(','))))
    server.allowed_origins = set(filter(None, (v.strip() for v in os.environ.get('DETECTOR_ALLOWED_ORIGINS', '').split(','))))
    server.access_token = token
    server.ocr_ready = ocr.readiness()
    server.daemon_threads = True
    return server


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=8000)
    args = parser.parse_args()
    server = create_server(args.host, args.port)
    print(f'LibraryDetector: http://{args.host}:{args.port}/LibraryDetector/; OCR ready: {server.ocr_ready}')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
