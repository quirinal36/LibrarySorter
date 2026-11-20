"""Run on the Jetson before installing OCR: python -m server.check_cuda."""
import json
import platform
import sys


def main():
    report = {'python': platform.python_version(), 'machine': platform.machine(), 'passed': False}
    stage = 'import_torch'
    try:
        import torch
        report.update(torch=torch.__version__, cudaBuild=torch.version.cuda,
                      cudaAvailable=torch.cuda.is_available())
        stage = 'cuda_availability'
        if not torch.cuda.is_available():
            raise RuntimeError('CUDA is not available')
        report.update(device=torch.cuda.get_device_name(0), capability=torch.cuda.get_device_capability(0),
                      compiledArchitectures=torch.cuda.get_arch_list())
        # Architecture strings alone are not a pass/fail criterion: run kernels.
        with torch.inference_mode():
            stage = 'elementwise_and_matmul'
            x = torch.randn(64, 64, device='cuda')
            y = (x + 1) @ x.T
            if not torch.isfinite(y).all().item():
                raise RuntimeError('Non-finite matmul output')
            torch.cuda.synchronize()
            stage = 'cudnn_convolution'
            layer = torch.nn.Conv2d(3, 16, 3).cuda().eval()
            y = layer(torch.randn(1, 3, 64, 64, device='cuda'))
            if not torch.isfinite(y).all().item():
                raise RuntimeError('Non-finite convolution output')
            torch.cuda.synchronize()
            stage = 'lstm'
            layer = torch.nn.LSTM(32, 16, bidirectional=True).cuda().eval()
            y, _ = layer(torch.randn(12, 1, 32, device='cuda'))
            if not torch.isfinite(y).all().item():
                raise RuntimeError('Non-finite LSTM output')
            torch.cuda.synchronize()
        stage = 'import_torchvision'
        import torchvision
        report['torchvision'] = torchvision.__version__
        report['passed'] = True
    except Exception as exc:
        report.update(failedStage=stage, errorType=type(exc).__name__, error=str(exc))
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    sys.exit(main())
