import contextlib
import json
import types
import unittest
from unittest.mock import Mock, patch
from server import gpu_ocr, ocr
from PIL import Image


class GPUContractTests(unittest.TestCase):
    def setUp(self):
        self.reader=Mock()
        self.reader.detector.parameters.return_value=[types.SimpleNamespace(device=types.SimpleNamespace(type='cuda'))]
        self.reader.recognizer.parameters.return_value=[types.SimpleNamespace(device=types.SimpleNamespace(type='cuda'))]
        self.torch=Mock()
        self.torch.cuda.is_available.return_value=True
        self.torch.ones.return_value=Mock()
        # Mock addition while retaining the real CUDA-selection control flow.
        tensor=types.SimpleNamespace()
        class Tensor:
            def __add__(self,value): return self
            def cpu(self): return tensor
        self.torch.ones.return_value=Tensor()
        self.torch.inference_mode.side_effect=contextlib.nullcontext
        self.easy=Mock();self.easy.Reader.return_value=self.reader
        self.np=Mock()
        self.modules={'torch':self.torch,'easyocr':self.easy,'numpy':self.np}
        self.patches=[patch.object(gpu_ocr,'_reader',None),patch.object(gpu_ocr,'_error',None),
                      patch.object(gpu_ocr.importlib,'import_module',side_effect=self.modules.__getitem__)]
        for p in self.patches:p.start();self.addCleanup(p.stop)

    def test_missing_cuda_never_creates_cpu_reader(self):
        self.torch.cuda.is_available.return_value=False
        with self.assertRaisesRegex(gpu_ocr.GPUUnavailable,'CUDA_UNAVAILABLE'):gpu_ocr.get_reader()
        self.easy.Reader.assert_not_called()
        self.assertEqual(gpu_ocr.state()['ocrError'],'CUDA_UNAVAILABLE')

    def test_both_models_cuda_warmup_and_reuse(self):
        self.assertIs(gpu_ocr.get_reader(),self.reader)
        self.assertIs(gpu_ocr.get_reader(),self.reader)
        self.easy.Reader.assert_called_once_with(['ko','en'],gpu='cuda:0',download_enabled=False,verbose=False,quantize=False)
        self.reader.readtext.assert_called_once()
        self.reader.recognize.assert_called_once()
        self.assertEqual(gpu_ocr.state()['ocrDevice'],'cuda:0')

    def test_cpu_model_is_rejected(self):
        self.reader.recognizer.parameters.return_value=[types.SimpleNamespace(device=types.SimpleNamespace(type='cpu'))]
        with self.assertRaisesRegex(gpu_ocr.GPUUnavailable,'MODEL_NOT_ON_CUDA'):gpu_ocr.get_reader()
        self.assertIsNone(gpu_ocr._reader)

    def test_oom_propagates_without_cpu_retry(self):
        gpu_ocr.get_reader()
        self.reader.readtext.side_effect=RuntimeError('CUDA out of memory')
        with self.assertRaisesRegex(gpu_ocr.GPUUnavailable,'CUDA_OCR_INFERENCE_FAILED'):gpu_ocr.read_crop(object())
        self.easy.Reader.assert_called_once()

    def test_model_download_requires_explicit_setup(self):
        gpu_ocr.get_reader(download=True)
        self.assertTrue(self.easy.Reader.call_args.kwargs['download_enabled'])

    def test_polygon_scaling_and_bad_confidence(self):
        polygon=[[0,0],[40,5],[38,20],[1,19]]
        out=ocr.gpu_words([(polygon,'한 001',.92),(polygon,'bad',float('nan'))],10,20,2,2)
        self.assertEqual(len(out),1);self.assertEqual(out[0]['confidence'],92)
        self.assertEqual(out[0]['text'],'한001')
        self.assertEqual(out[0]['bbox'],{'x0':10,'y0':20,'x1':30,'y1':30})

    def test_pipeline_runs_gpu_tiles_then_maps_to_source(self):
        self.reader.readtext.return_value=[]
        gpu_ocr.get_reader()
        detected=[([[30,30],[150,30],[150,60],[30,60]],'813.7',.95),
                  ([[30,75],[150,75],[150,105],[30,105]],'A17',.95)]
        # One tile contains one label; the remaining tiles have no text.
        self.reader.readtext.side_effect=[detected,[],[],[],[],[]]
        with Image.new('RGB',(600,400),'white') as photo:
            labels=ocr.recognize(photo)
        self.assertEqual(len(labels),1)
        self.assertEqual(labels[0]['callNumber']['classification'],'813.7')
        self.assertEqual(labels[0]['bbox']['x'],6)
        self.assertEqual(labels[0]['confidence'],95)


if __name__=='__main__':unittest.main()
