# Jetson 사진 검사 서버

로컬 Jetson을 스마트폰에 HTTPS로 연결하려면 [Tailscale 설정 안내](../docs/TAILSCALE_SETUP.md)를 따라가세요.

스마트폰은 JPEG 사진을 전송하고 결과를 같은 촬영 사진 위에 표시합니다.
서버는 분할 확대·명암 보정 → 한·영 OCR → 라벨 좌표/청구기호 추출 → Gadia AI
규칙 판정을 수행합니다. books.json이나 원래 책 위치를 읽지 않습니다.

서버 OCR은 **EasyOCR 1.7.2 + PyTorch CUDA**로 실행합니다. CRAFT 문자 영역 탐지와
한·영 문자 인식을 모두 `cuda:0`에서 수행하고 모델은 요청 간 재사용합니다.
CUDA가 없거나 모델이 CPU에 있으면 준비 실패로 처리하며 CPU로 자동 전환하지 않습니다.
사진 디코딩·확대·명암 보정·좌표 정리와 규칙 데이터 처리는 CPU에서 수행합니다.
TensorRT 변환 및 서버 MediaPipe/원근 보정은 포함하지 않습니다. 기존 기기 OCR 모드에는
MediaPipe가 유지됩니다. GPU 사용 자체가 인식률 향상을 보증하지 않으므로 실제 사진 평가가 필요합니다.

## Jetson 설치

JetPack이 설치된 Ubuntu에서 프로젝트 전체를 복사한 뒤 루트에서 실행합니다.
Python 3.10 이상, Node.js 18 이상을 사용하세요. 사용자 기기에서 확인한
L4T는 **R39.2.1 / aarch64**, NVIDIA 공식 대응 버전은 **JetPack 7.2.1**입니다.
이 릴리스의 공식 구성은 CUDA 13.2.2 / Ubuntu 24.04입니다. 이 값은 OS 식별이며
해당 기기의 CUDA/PyTorch 설치 완료를 뜻하지 않습니다.

먼저 해당 JetPack/Python에 호환되는 CUDA PyTorch와 torchvision을 준비해야 합니다.
설치된 CUDA 빌드가 있으면 그대로 사용합니다. 현재 확인한 NVIDIA PyTorch 호환 표만으로
7.2.1용 특정 wheel을 확정하지 못했으므로, 예전 JetPack 6.x용 wheel이나 임의의
`pip install torch torchvision` 명령을 사용하지 않습니다. 설치 환경의 버전을 확인하고
공식 호환 빌드를 선택한 후 아래 OCR 패키지를 설치하세요.

```bash
cat /etc/nv_tegra_release
python3 --version
python3 -c "import torch, torchvision; print(torch.__version__, torchvision.__version__); print(torch.version.cuda, torch.cuda.is_available())"
```

```bash
sudo apt update
sudo apt install python3-venv nodejs
# 이미 CUDA torch/torchvision이 설치된 Python 환경을 재사용하는 경우:
python3 -m venv --system-site-packages .venv
. .venv/bin/activate
python -m pip install -r server/requirements-ocr.txt
python -m pip install --no-deps easyocr==1.7.2
python -m pip check
node --version
# 최초 한 번 인터넷에서 OCR 가중치를 다운로드하고 두 GPU 모델을 실행합니다.
python -m server.gpu_ocr --download-models
# 이후에는 다운로드 없이 설치된 가중치로 검사합니다.
python -m server.gpu_ocr
python -m server.app --host 127.0.0.1 --port 8000
```

Node.js 버전이 18 미만이면 지원 버전으로 설치한 뒤 실행하세요.
CUDA 진단 결과 `ocrDevice: "cuda:0"`, `ocrError: null`이어야 합니다.
모델은 실행 계정의 EasyOCR 캐시에 저장되므로 설치와 서비스 실행 계정을 맞추세요.
가중치 파일은 저장하지만 촬영 사진은 저장하지 않습니다. 서버 시작 시에는 자동 다운로드를
허용하지 않습니다. `CUDA_UNAVAILABLE`는 GPU 미인식,
`MODEL_NOT_ON_CUDA`는 모델 배치 오류, `CUDA_OCR_INIT_FAILED`는 의존성·가중치·커널
실행 실패입니다. 상세 원인은 Jetson에서 `python -m server.gpu_ocr --debug`로 확인합니다.
서버는 기존 루트 `.env`의 Gadia 설정을 읽습니다. 모델 기본값은
`plexus/gpt-6-astra`입니다. 설정은 배포 ZIP에 포함하지 않습니다.
`server/.env` → 기존 `LibraryDetector/.env` → 루트 `.env` 순으로 읽고,
프로세스 환경 설정이 가장 우선합니다.

서버 전용 환경 설정:

- `GADIA_API_KEY`: Gadia 비밀키 (스마트폰에 입력하지 않음)
- `GADIA_MODEL`: 선택 모델
- `DETECTOR_ACCESS_TOKEN`: 관리자가 생성한 24자 이상의 임의 접속 코드
- `DETECTOR_ALLOWED_HOSTS`: HTTPS 서버 도메인, 쉼표로 구분
- `DETECTOR_ALLOWED_ORIGINS`: 별도 프론트엔드의 정확한 origin, 쉼표로 구분

접속 코드는 `python -c "import secrets; print(secrets.token_urlsafe(32))"`로 생성해
서버에 설정하고 신뢰하는 사용자에게만 전달하세요. 프론트엔드 파일에 넣지 않습니다.
이는 개인/소규모 사용용 공유 인증입니다. 다수 사용자 공개 운영에는 사용자별 인증,
요청량 제한과 접근 관리를 별도로 구성해야 합니다.

## 스마트폰 연결

### PyTorch 미설치 기기의 후보 검증

공식 cu130 채널의 `torch==2.9.1` / `torchvision==0.24.1` 조합을 별도 환경에서
시험할 수 있습니다. 이는 Orin 지원을 확인한 배포 조합이 아닌 **검증 후보**입니다.
CUDA 버전이나 ARM64 wheel의 존재만으로 sm_87에서 실행된다고 판단하지 않습니다.
아키텍처 목록에 sm_87 문자열이 없다는 이유만으로 실패로 단정하지도 않습니다.

```bash
python3.12 -m venv .venv-cuda-test
. .venv-cuda-test/bin/activate
python -m pip install --upgrade pip
python -m pip install --only-binary=:all: torch==2.9.1 torchvision==0.24.1 --index-url https://download.pytorch.org/whl/cu130
python -m server.check_cuda
```

진단은 CUDA 인식뿐 아니라 원소 연산·행렬곱·cuDNN convolution·LSTM을 실행하고
동기화합니다. `passed: true`인 경우에만 위의 OCR 의존성 설치와
`python -m server.gpu_ocr --download-models`로 진행하세요. 최종 통과 기준은 실제
OCR 모델 실행입니다. no-kernel-image 등으로 실패하면 출력된 `failedStage`와 오류로
다음 호환 빌드를 선정합니다. 자동 소스 빌드나 시스템 환경 변경은 수행하지 않습니다.

## HTTPS 연결

1. Jetson 앞에 HTTPS 리버스 프록시를 구성합니다. 예: Caddy에서 본인 도메인에
   `reverse_proxy 127.0.0.1:8000`을 설정합니다. 도메인의 DNS와 네트워크 접근도 필요합니다.
2. 프록시 배포에서도 접속 코드를 반드시 설정하고 해당 도메인을 허용 호스트에 넣습니다.
   요청 본문은 12MiB, 처리 시간은 최소 300초로 허용합니다. 사진/인증 헤더를 로그에
   기록하지 않습니다. HTTP 8000 포트는 인터넷에 직접 노출하지 않습니다.
3. 스마트폰에서 `https://본인도메인/LibraryDetector/`를 열고 접속 코드를 입력합니다.
   서버 주소는 비워두고 사진을 촬영합니다.
4. 라운지에 화면을 따로 배포한다면 서버 주소를 입력하고 실제 플레이 origin을
   허용 출처에 등록합니다. 라운지의 카메라 권한/CSP 및 실제 폰 동작은 별도 검증합니다.

`--host 0.0.0.0` 바인딩은 24자 이상 접속 코드가 있어야 시작됩니다.
localhost 개발은 코드 없이 가능하지만 HTTPS 프록시 공개 시에도 코드는 필요합니다.
사진 취소는 프론트엔드 결과 반영을 중지합니다. 이미 시작된 서버 OCR/AI 요청은
처리가 이어질 수 있으며, 그동안 다음 요청은 409를 반환합니다. OCR의 170초 제한은
타일 추론 사이에서 검사합니다. 실행 중인 CUDA 커널을 강제 중단하지는 않습니다.

## API 및 검증

- `GET /api/health`: OCR 준비 상태, `ocrEngine`, `ocrDevice`, `ocrError`, 모델,
  접속 코드 필요 여부. 비밀값 미포함.
- `POST /api/inspect`: `Content-Type: image/jpeg`, JPEG 바이너리 본문,
  `Authorization: Bearer <접속 코드>`. 최대 12MiB/18MP/긴 변 6000px.
- 응답: `image: {width,height}`, `observations: [{index,text,confidence,callNumber,bbox,row}]`,
  `items: [{index,status,confidence,reason}]`, `summary`, `model`.
  bbox는 EXIF 방향을 적용한 사진의 픽셀 좌표입니다. 프론트엔드는 방향을 적용한
  canvas를 JPEG로 전송하므로 표시 사진과 좌표가 일치합니다.
- 401 접속 코드 오류, 409 검사 중, 413 크기 초과, 415 형식 오류,
  422 해석 불가, 503 준비 안 됨, 504 시간 초과.
- 사진은 파일 저장 없이 메모리와 subprocess pipe에서 처리합니다.

```bash
python -m unittest discover -s server/tests
python -m unittest discover -s LibraryDetector/tests -p 'test_*.py'
node --test LibraryDetector/tests/*.test.mjs
```

Jetson 실기기 OCR 인식률·처리 시간과 스마트폰 HTTPS 촬영은 실기기에서 검증해야 합니다.

참고: [JetPack 버전 대응](https://developer.nvidia.com/embedded/jetpack-archive),
[NVIDIA PyTorch 호환 표](https://docs.nvidia.com/deeplearning/frameworks/install-pytorch-jetson-platform-release-notes/pytorch-jetson-rel.html),
[EasyOCR API](https://www.jaided.ai/easyocr/documentation/).
