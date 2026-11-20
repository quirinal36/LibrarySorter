import io
import json
import threading
import subprocess
from pathlib import Path
import unittest
from unittest.mock import patch
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from PIL import Image
from server import app, core, ocr


def jpeg():
    out=io.BytesIO(); Image.new('RGB',(640,480),'white').save(out,format='JPEG'); return out.getvalue()


class PhotoTests(unittest.TestCase):
    def test_node_parser_preserves_spatial_order_and_boxes(self):
        words=[]
        for x,number in [(20,'813.7'),(200,'800.1')]:
            for y,text in [(100,number),(125,'A17')]:
                words.append({'text':text,'confidence':95,'bbox':{'x0':x,'y0':y,'x1':x+60,'y1':y+20}})
        result=subprocess.run(['node',str(Path(ocr.__file__).with_name('labels.mjs'))],input=json.dumps(words).encode(),capture_output=True,check=True,timeout=10)
        observations=json.loads(result.stdout)
        self.assertEqual([o['callNumber']['classification'] for o in observations],['813.7','800.1'])
        self.assertLess(observations[0]['bbox']['x'],observations[1]['bbox']['x'])

    def test_image_limits_and_format(self):
        with ocr.decode_photo(jpeg()) as image:
            self.assertEqual(image.size,(640,480))
        for raw in (b'bad', b'\xff\xd8not-jpeg', b'x'*(ocr.MAX_BYTES+1)):
            with self.assertRaises(ValueError): ocr.decode_photo(raw)
        with patch.object(ocr,'MAX_PIXELS',100):
            with self.assertRaises(ValueError): ocr.decode_photo(jpeg())

    def test_tile_coverage_and_coordinates(self):
        boxes=list(ocr.tiles(1800,900))
        for x in range(0,1800,20):
            for y in range(0,900,20):
                self.assertTrue(any(l<=x<r and t<=y<b for l,t,r,b in boxes))
        results=[([[20,40],[100,40],[100,70],[20,70]],'813.7',.9)]
        word=ocr.gpu_words(results,100,200,2,2)[0]
        self.assertEqual(word['bbox'],{'x0':110,'y0':220,'x1':150,'y1':235})
        other={**word,'text':'813.1'}
        merged=ocr.deduplicate([word,other]); self.assertEqual(len(merged),1)
        self.assertLess(merged[0]['confidence'],55)

    def test_external_bind_requires_code(self):
        with patch.object(core,'load_env_files'), patch.dict(core.os.environ,{'DETECTOR_ACCESS_TOKEN':''}):
            with self.assertRaises(ValueError): app.create_server('0.0.0.0',0)

    def test_http_photo_auth_cors_ai_and_busy(self):
        env={'GADIA_API_KEY':'test-only','DETECTOR_ACCESS_TOKEN':'a'*32,'DETECTOR_ALLOWED_ORIGINS':'https://front.example'}
        with patch.object(core,'load_env_files'), patch.dict(core.os.environ,env), patch.object(ocr,'readiness',return_value=True):
            server=app.create_server('127.0.0.1',0)
            thread=threading.Thread(target=server.serve_forever,daemon=True); thread.start()
            url=f'http://127.0.0.1:{server.server_port}'
            def request(path='/api/inspect',body=None,**headers):
                data=jpeg() if body is None else body
                req=Request(url+path,data=data,headers={'Content-Type':'image/jpeg','Authorization':'Bearer '+'a'*32,**headers})
                try:
                    with urlopen(req,timeout=5) as response: return response.status,json.load(response),response.headers
                except HTTPError as error: return error.code,json.load(error),error.headers
            observations=[{'index':i,'text':f'80{i}\nA1','confidence':95,'bbox':{'x':i*100,'y':100,'width':50,'height':50},'callNumber':{'classification':str(800+i),'bookMark':'A1','volume':None}} for i in range(2)]
            try:
                self.assertEqual(request(Authorization='wrong')[0],401)
                self.assertEqual(request(Origin='https://evil.example')[0],403)
                self.assertEqual(request(body=b'bad')[0],422)
                self.assertEqual(request(**{'Content-Type':'application/json'})[0],415)
                core.INFERENCE_LOCK.acquire()
                try: self.assertEqual(request()[0],409)
                finally: core.INFERENCE_LOCK.release()
                result={'summary':'ok','items':[{'index':i,'status':'ordered','confidence':.9,'reason':'ok'} for i in range(2)]}
                with patch.object(ocr,'recognize',return_value=observations), patch.object(core,'generate_analysis',return_value=result) as ai:
                    status,data,headers=request(Origin='https://front.example')
                    self.assertEqual(status,200); self.assertEqual(data['image'],{'width':640,'height':480})
                    self.assertEqual(data['observations'],observations)
                    self.assertEqual(headers['Access-Control-Allow-Origin'],'https://front.example')
                    self.assertNotIn('image',ai.call_args.args[0])
                with patch.object(ocr,'recognize',return_value=[]), patch.object(core,'generate_analysis') as ai:
                    self.assertEqual(request()[1]['items'],[]); ai.assert_not_called()
                with patch.object(ocr,'recognize',side_effect=TimeoutError):
                    self.assertEqual(request()[0],504)
                with patch.object(ocr,'recognize',side_effect=app.gpu_ocr.GPUUnavailable('private detail')):
                    status,data,_=request()
                    self.assertEqual(status,503); self.assertNotIn('private detail',str(data))
                self.assertFalse(core.INFERENCE_LOCK.locked())
                with urlopen(url+'/api/health') as response:
                    health=json.load(response); self.assertTrue(health['photoInspection']); self.assertNotIn('test-only',str(health))
            finally:
                server.shutdown(); server.server_close(); thread.join()


if __name__=='__main__': unittest.main()
