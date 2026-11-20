"""Offline request, model boundary and route tests; no Gemini calls or API key needed."""
import base64
import copy
from email.message import Message
import importlib.util
import io
import json
from pathlib import Path
import types
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

SPEC = importlib.util.spec_from_file_location('detector_server', Path(__file__).resolve().parents[2] / 'server' / 'core.py')
server = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(server)


def payload():
    return {
        'columns': 10,
        'observations': [{'index': i, 'text': f'813.7 한{i:03d}', 'confidence': 90} for i in range(20)],
        'image': {'mimeType': 'image/jpeg', 'data': base64.b64encode(b'\xff\xd8\xff\xe0test\xff\xd9').decode()},
    }


def model_result():
    return {'summary': '촬영 범위의 배열을 확인했습니다.', 'items': [
        {'index': i, 'status': 'ordered', 'confidence': .9, 'reason': '주변 기호와 비교한 상대 배열입니다.'}
        for i in range(20)
    ]}


def handler(body=None, path='/api/analyze', extra_headers=None):
    h = object.__new__(server.Handler)
    h.path = path
    h.headers = Message()
    raw = json.dumps(payload() if body is None else body).encode()
    for key, value in {'Host': 'localhost:8000', 'Origin': 'http://localhost:8000', 'Content-Type': 'application/json', 'Content-Length': str(len(raw)), **(extra_headers or {})}.items():
        h.headers[key] = value
    h.rfile, h.wfile = io.BytesIO(raw), io.BytesIO()
    h.server = types.SimpleNamespace(allowed_hosts=set())
    h.captured = []
    h.send_json = lambda status, data: h.captured.append((status, data))
    h.send_response = lambda status: h.captured.append((status, None))
    h.send_header = lambda *args: None
    h.end_headers = lambda: None
    return h


class ServerTests(unittest.TestCase):
    def test_request_accepts_exact_slots_only(self):
        out = server.validate_payload(payload())
        self.assertEqual(len(out['observations']), 20)
        broken = payload(); broken['observations'][1]['index'] = 0
        with self.assertRaises(ValueError): server.validate_payload(broken)
        for field, value in [('confidence', float('nan')), ('confidence', -1), ('index', True), ('text', 'x' * 2001)]:
            broken = payload(); broken['observations'][0][field] = value
            with self.assertRaises(ValueError): server.validate_payload(broken)

    def test_invalid_image_or_layout(self):
        for image in [{'mimeType': 'image/png', 'data': 'AA=='}, {'mimeType': 'image/jpeg', 'data': 'bad base64'}, {'mimeType': 'image/jpeg', 'data': 'YWJjZA=='}]:
            broken = payload(); broken['image'] = image
            with self.assertRaises(ValueError): server.validate_payload(broken)
        broken = payload(); broken['columns'] = 3
        with self.assertRaises(ValueError): server.validate_payload(broken)

    def test_response_downgrades_weak_evidence_and_missing_items(self):
        observations = payload()['observations']; observations[2]['confidence'] = 10
        result = model_result()
        result['items'][0].update(status='wrong', confidence=.6)
        result['items'][1].update(status='wrong', confidence=.99)
        result['items'][2].update(status='wrong', confidence=.99)
        result['items'].pop()
        out = server.sanitize_response(result, observations)
        self.assertEqual([out['items'][i]['status'] for i in (0, 1, 2, 19)], ['uncertain', 'wrong', 'uncertain', 'uncertain'])
        self.assertEqual(len(out['items']), 20)

    def test_response_rejects_duplicate_invalid_and_nonfinite(self):
        for field, value in [('index', 0), ('status', 'perfect'), ('confidence', float('inf')), ('reason', 1)]:
            response = model_result(); response['items'][1][field] = value
            with self.assertRaises(ValueError): server.sanitize_response(response, payload()['observations'])

    def test_provider_payload_uses_header_key_and_prompted_rules(self):
        response = io.BytesIO(json.dumps({'choices': [{'finish_reason': 'stop', 'message': {'content': json.dumps(model_result())}}]}).encode())
        with patch.object(server, 'urlopen', return_value=response) as call:
            result = server.generate_analysis(server.validate_payload(payload()), 'test-secret', server.DEFAULT_MODEL)
        request = call.call_args.args[0]
        self.assertNotIn('test-secret', request.full_url)
        self.assertEqual(request.get_header('Authorization'), 'Bearer test-secret')
        contents = json.loads(request.data)
        self.assertEqual(contents['model'], server.DEFAULT_MODEL)
        self.assertFalse(contents['stream'])
        self.assertIsInstance(contents['messages'][1]['content'], str)
        self.assertNotIn('image_url', json.dumps(contents))
        self.assertEqual(len(result['items']), 20)

    def test_missing_key_and_cross_origin(self):
        h = handler()
        with patch.dict(server.os.environ, {'GADIA_API_KEY': ''}): h.do_POST()
        self.assertEqual(h.captured[0][0], 503)
        h = handler(extra_headers={'Origin': 'https://unrelated.example'})
        h.do_POST(); self.assertEqual(h.captured[0][0], 403)
        h = handler(extra_headers={'Host': 'unrelated.example', 'Origin': 'http://unrelated.example'})
        h.do_POST(); self.assertEqual(h.captured[0][0], 403)

    def test_provider_error_does_not_expose_response_or_key(self):
        h = handler()
        with patch.dict(server.os.environ, {'GADIA_API_KEY': 'hidden-key'}), patch.object(server, 'generate_analysis', side_effect=HTTPError('https://provider/', 403, 'hidden-key', {}, None)):
            h.do_POST()
        self.assertEqual(h.captured[0][0], 502)
        self.assertNotIn('hidden-key', str(h.captured))
        self.assertFalse(server.INFERENCE_LOCK.locked())

    def test_concurrency_rejects_second_request(self):
        h = handler(); server.INFERENCE_LOCK.acquire()
        try:
            with patch.dict(server.os.environ, {'GADIA_API_KEY': 'test'}): h.do_POST()
        finally: server.INFERENCE_LOCK.release()
        self.assertEqual(h.captured[0][0], 409)

    def test_health_and_private_routes(self):
        h = handler(path='/api/health')
        with patch.dict(server.os.environ, {'GADIA_API_KEY': 'never-output-this'}): h.do_GET()
        self.assertTrue(h.captured[0][1]['configured'])
        self.assertNotIn('never-output-this', str(h.captured))
        for route in ['/LibraryDetector/.env', '/LibraryDetector/server.py', '/LibraryDetector/tests/test_server.py', '/LibraryDetector/src/../server.py', '/not-allowed.json']:
            h = handler(path=route); h.do_GET()
            self.assertEqual(h.captured[0][0], 404)

    def test_existing_simulator_assets_are_static_only(self):
        for route in ['/index.html', '/app.js', '/style.css', '/books.json']:
            h = handler(path=route); h.do_GET()
            self.assertEqual(h.captured[0][0], 200)
            self.assertTrue(h.wfile.getvalue())
        self.assertNotIn('books.json', server.RULES)

    def test_malformed_provider_result_is_rejected(self):
        for result in [[], {'candidates': [3]}, {'candidates': [{'content': {'parts': [4]}}]}]:
            with patch.object(server, 'urlopen', return_value=io.BytesIO(json.dumps(result).encode())):
                with self.assertRaises(ValueError): server.generate_analysis(server.validate_payload(payload()), 'key', server.DEFAULT_MODEL)

    def test_oversized_and_malformed_payload(self):
        h = handler(extra_headers={'Content-Length': str(server.MAX_BODY + 1)})
        h.do_POST(); self.assertEqual(h.captured[0][0], 413)
        h = handler(body={'columns': 10})
        h.do_POST(); self.assertEqual(h.captured[0][0], 400)


if __name__ == '__main__':
    unittest.main()
