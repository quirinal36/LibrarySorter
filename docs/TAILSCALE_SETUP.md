# Jetson과 스마트폰을 Tailscale HTTPS로 연결하기

작성 기준: 2026-11-21 · LibrarySorter / LibraryDetector

## 1. 이 프로젝트에서 사용할 구성

Jetson은 기존처럼 `127.0.0.1:8000`에서 HTTP 서버를 실행합니다. Tailscale Serve가
스마트폰에 HTTPS 주소를 제공하고 Jetson 내부 서버로 전달합니다. 인증서 파일을
직접 설치하는 과정은 필요하지 않습니다. Serve는 tailnet 안에서 서비스를 제공하는
기능입니다. 이 안내에서는 인터넷 전체에 공개하는 Funnel을 사용하지 않습니다.
[Tailscale Serve 공식 안내](https://tailscale.com/docs/features/tailscale-serve)

```text
스마트폰: Tailscale 연결 + 웹 브라우저
    ↓ HTTPS: https://jetson.<내-tailnet>.ts.net/LibraryDetector/
Jetson: Tailscale Serve
    ↓ HTTP: http://127.0.0.1:8000
LibrarySorter 서버
    ├─ 카메라 화면 제공
    ├─ 사진 수신 → EasyOCR CUDA → 라벨 좌표 추출
    └─ OCR 문자열 → Gadia GPT-6-astra → 배열 판정
```

처음에는 **GitHub Pages 대신 Jetson이 제공하는 카메라 화면**을 사용합니다.
화면과 사진 업로드 API가 같은 HTTPS 주소에 있으므로 설정이 단순합니다.
GitHub는 코드 보관·업데이트용으로 계속 사용합니다.

## 2. 준비 상태 확인

필요한 것은 다음과 같습니다.

- 전원이 켜져 있고 인터넷에 연결된 Jetson
- Android 또는 iPhone과 Tailscale 계정
- Jetson에 복사한 이 프로젝트와 서버용 Python 가상환경
- Gadia API 키 및 별도로 생성할 서버 접속 코드

CUDA 설치가 끝나기 전에도 화면과 네트워크 연결을 확인할 수 있습니다. 실제 사진
검사는 CUDA OCR과 Gadia 설정이 모두 준비되어야 합니다. Tailscale 설치는 PyTorch의
호환성 문제를 해결하지 않습니다. GPU 설치는 [서버 안내서](../server/README.md)를 따릅니다.

이 문서의 프로젝트 경로는 `~/LibrarySorter`로 가정합니다. 다른 곳에 복사했다면
`cd` 경로를 바꾸세요. 이미 복사한 프로젝트가 있다면 다시 clone할 필요는 없습니다.

```bash
# 처음 내려받는 경우에만 실행
git clone https://github.com/quirinal36/LibrarySorter.git
cd ~/LibrarySorter
```

## 3. Jetson에 Tailscale 설치와 로그인

Jetson 터미널에서 공식 설치 스크립트를 실행합니다.

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
tailscale status
```

`tailscale up`이 표시하는 로그인 주소를 브라우저로 열어 로그인합니다. 관리 콘솔의
Machines 목록에 Jetson이 나타나는지 확인하세요. 기존 설치가 있다면 설치 명령은 생략합니다.
[Linux 설치 공식 문서](https://tailscale.com/docs/install/linux)

## 4. 스마트폰을 같은 네트워크에 등록

1. 스마트폰의 앱 스토어에서 Tailscale을 설치합니다.
2. Jetson과 같은 계정으로 로그인합니다. 조직 계정이라면 같은 tailnet을 선택합니다.
3. 운영체제가 요청하는 VPN 구성을 허용하고 Tailscale 연결을 켭니다.
4. 두 기기가 관리 콘솔에 등록되어 있고 접근 정책상 서로 통신할 수 있는지 확인합니다.

다른 VPN이 켜져 있다면 충돌 여부를 확인하세요. 처음에는 같은 Wi-Fi에서 시험하고,
연결 성공 후 모바일 데이터에서도 확인하면 원인 파악이 쉽습니다.

## 5. HTTPS 주소 만들기

Jetson에서 먼저 기존 Serve 설정을 확인합니다. 이미 다른 서비스가 443 포트를
사용한다면 그대로 덮어쓰지 말고 별도 포트 또는 경로 구성을 검토하세요.

```bash
sudo tailscale serve status
```

처음 사용하는 기기에서는 다음 명령으로 로컬 8000 포트를 연결합니다.

```bash
sudo tailscale serve --bg --https=443 http://127.0.0.1:8000
sudo tailscale serve status
```

기능 활성화 링크가 나오면 열어서 안내를 따릅니다. 필요하면 Tailscale 관리 콘솔의
DNS 화면에서 MagicDNS와 HTTPS Certificates를 활성화합니다. HTTPS 인증서 발급 시
기기 도메인 이름은 공개 인증서 기록에 남으므로 기기 이름에 민감한 정보를 넣지 마세요.
[HTTPS 설정 안내](https://tailscale.com/docs/how-to/set-up-https-certificates)

출력 예시는 다음과 같습니다. **아래 주소는 예시이며 실제 출력된 주소를 사용해야 합니다.**

```text
Available within your tailnet:
https://jetson.example-tailnet.ts.net
|-- / proxy http://127.0.0.1:8000
```

`--bg` 설정은 재부팅 후에도 유지됩니다. 단, Python 서버까지 자동 실행해주지는 않습니다.
현재 단계에서 Python 서버가 아직 실행되지 않았다면 HTTPS 접속 시 프록시 오류가
발생할 수 있습니다. 다음 단계에서 서버를 실행하면 됩니다.
[Serve 명령과 재부팅 동작](https://tailscale.com/docs/reference/tailscale-cli/serve)

## 6. 프로젝트 서버 설정

프로젝트 루트에서 `server/.env`를 편집합니다. 이미 설정이 있다면 덮어쓰지 말고
필요한 항목만 수정하세요.

```bash
cd ~/LibrarySorter
nano server/.env
```

다음은 형식 예시입니다. 도메인·키·접속 코드의 설명 문구를 실제 값으로 교체합니다.

```dotenv
GADIA_API_KEY=본인의_Gadia_API_키
GADIA_MODEL=plexus/gpt-6-astra
DETECTOR_ACCESS_TOKEN=아래_명령으로_생성한_임의_접속_코드
DETECTOR_ALLOWED_HOSTS=jetson.example-tailnet.ts.net
DETECTOR_ALLOWED_ORIGINS=https://jetson.example-tailnet.ts.net
```

서버 접속 코드는 다음 명령으로 생성합니다. 출력된 코드는 본인 스마트폰에서 사용할
값이며 GitHub나 공개 문서에 넣지 않습니다.

```bash
python3 -c "import secrets; print(secrets.token_urlsafe(32))"
chmod 600 server/.env
```

| 설정 | 입력 방식 |
| --- | --- |
| `DETECTOR_ALLOWED_HOSTS` | 실제 `*.ts.net` 도메인만 입력. `https://`와 경로는 제외 |
| `DETECTOR_ALLOWED_ORIGINS` | 실제 `https://도메인` 입력. 경로와 마지막 `/`는 제외 |
| `DETECTOR_ACCESS_TOKEN` | 최소 24자 이상의 임의 문자열. 스마트폰의 **서버 접속 코드**에 입력 |
| `GADIA_API_KEY` | 서버 전용 비밀키. 스마트폰에는 입력하지 않음 |

이 앱은 Tailscale 로그인과 별도로 접속 코드를 검사합니다. Tailscale 사용자 정보를
자동으로 앱 로그인으로 사용하지 않습니다.

환경 설정은 프로세스 환경 → `server/.env` → `LibraryDetector/.env` → 루트 `.env`
순으로 우선합니다. 같은 이름의 환경 변수가 터미널에 설정되어 있다면 파일 수정이
적용되지 않을 수 있습니다. 설정을 변경한 뒤에는 Python 서버를 재시작하세요.

## 7. Python 서버 실행과 로컬 확인

**CUDA와 EasyOCR 설치를 완료한 가상환경**을 활성화합니다. 아래 `.venv-cuda-test`는
이전 설치 안내의 이름입니다. 실제 설치 환경이 `.venv`라면 그 경로를 사용하세요.

```bash
cd ~/LibrarySorter
source .venv-cuda-test/bin/activate
python -m server.check_cuda
python -m server.gpu_ocr
python -m server.app --host 127.0.0.1 --port 8000
```

GPU 진단이 실패하면 [GPU 설치 및 진단 안내](../server/README.md)를 먼저 확인합니다.
모델이 아직 없다면 설치된 동일 가상환경에서 `python -m server.gpu_ocr --download-models`를
한 번 실행합니다. 모델 설치 계정과 서버 실행 계정을 같게 유지하고 Python 서버를
`sudo`로 실행하지 마세요.

서버 터미널은 켜 둡니다. 별도 Jetson 터미널에서 확인합니다.

```bash
curl http://127.0.0.1:8000/api/health
```

사진 검사 준비가 끝났다면 응답의 주요 값은 다음과 같아야 합니다.

```json
{
  "configured": true,
  "photoInspection": true,
  "ocrReady": true,
  "ocrEngine": "easyocr-cuda",
  "ocrDevice": "cuda:0",
  "ocrError": null,
  "authenticationRequired": true
}
```

이는 확인할 필드만 보여주는 예시입니다. 실제 응답에는 모델 이름 등도 포함됩니다.
`configured`는 키가 설정되었다는 뜻이며, 키의 유효성·할당량은 실제 AI 요청으로 확인합니다.

## 8. 스마트폰으로 접속하고 촬영

1. 스마트폰에서 Tailscale 연결을 켭니다.
2. Safari 또는 Chrome에서 **실제 Serve 주소** 뒤에 `/api/health`를 붙여 엽니다.
3. JSON 응답이 보이면 `/LibraryDetector/` 경로를 엽니다.
4. 검사 방식은 **Jetson 서버 사진 검사**를 선택합니다.
5. **Jetson 서버 주소는 비워둡니다.** 화면과 API가 같은 주소를 사용합니다.
6. **서버 접속 코드**에 생성한 접속 코드를 입력합니다.
7. 카메라 권한을 허용하고, 선명한 청구기호를 촬영해 검사합니다.

예시 주소:

```text
https://jetson.example-tailnet.ts.net/LibraryDetector/
```

`https://100.x.x.x`나 `http://192.168.x.x`로 바꾸지 마세요. 인증서에 맞는 전체
`*.ts.net` 주소로 접속합니다. 접속 코드는 페이지에 영구 저장하지 않으므로 새로고침하면
다시 입력합니다. 사진은 Jetson으로 전송되고 Gadia에는 인식한 문자와 배열 순서만 전달됩니다.

## 9. GitHub Pages 화면을 계속 쓰고 싶은 경우

먼저 위의 Jetson 직접 접속 방식으로 사진 검사까지 성공한 뒤 시도하세요.

`server/.env`의 허용 출처에 GitHub Pages origin을 추가하고 서버를 재시작합니다.

```dotenv
DETECTOR_ALLOWED_ORIGINS=https://jetson.example-tailnet.ts.net,https://quirinal36.github.io
```

[GitHub Pages 카메라 화면](https://quirinal36.github.io/LibrarySorter/LibraryDetector/)에서
서버 주소를 `https://실제-jetson-도메인.ts.net`으로 입력하고 접속 코드를 입력합니다.
GitHub Pages를 열었더라도 **스마트폰의 Tailscale 연결은 계속 필요합니다.**
브라우저의 로컬 네트워크 접근 권한이나 교차 출처 제한이 발생하면 Jetson 직접 접속
방식으로 돌아가 확인하세요. 허용 출처는 `/LibrarySorter/` 경로 없이 입력합니다.

## 10. 문제 해결

| 증상 | 확인할 내용 |
| --- | --- |
| HTTPS 주소를 열 수 없음 | 스마트폰 Tailscale 연결, 동일 tailnet, Jetson 온라인 상태, 접근 정책, 전체 도메인 |
| 502 또는 프록시 연결 오류 | Jetson의 `curl http://127.0.0.1:8000/api/health`, Python 서버 실행 여부, Serve 대상 포트 |
| 403 허용되지 않은 호스트/출처 | `DETECTOR_ALLOWED_HOSTS`와 `DETECTOR_ALLOWED_ORIGINS`의 실제 도메인 및 서버 재시작 |
| 401 접속 코드 오류 | 화면의 접속 코드와 서버 설정 일치 여부. Gadia 키를 입력하지 않았는지 확인 |
| 503 접속 코드 설정 필요 | `DETECTOR_ACCESS_TOKEN` 설정 후 Python 서버 재시작 |
| `ocrReady: false` | Node.js 설치와 `python -m server.gpu_ocr --debug` 결과. Tailscale과 별개인 서버 준비 문제 |
| `configured: false` | 서버 Gadia 설정과 환경 변수 우선순위 |
| 503 CUDA OCR 실행 실패 | GPU 진단, 메모리 부족, PyTorch 호환성 확인 |
| 409 검사 중 | 진행 중인 처리가 끝날 때까지 기다린 뒤 다시 검사 |
| 413 사진 크기 초과 | 작은 촬영 범위 사용. 서버 제한은 12MiB·18MP·긴 변 6000px |
| 카메라 권한 오류 | 전체 HTTPS 주소, 브라우저 사이트 카메라 권한, 다른 앱의 카메라 사용 여부 |
| 화면은 열리지만 AI 검사 실패 | 로컬 health, CUDA 진단, Gadia 연결·키·할당량을 차례로 확인 |
| 재부팅 후 연결 실패 | Tailscale뿐 아니라 Python 서버도 다시 실행했는지 확인 |

현재 사진 검사 요청은 최대 300초 동안 응답을 기다립니다. 화면에서 취소해도 이미 시작된
서버 OCR·AI 요청은 즉시 중단되지 않을 수 있습니다. 서버는 동시에 한 건만 검사합니다.

## 11. 시작·종료 및 운영

평소에는 Jetson에서 서버를 실행하고 스마트폰 Tailscale을 켜면 됩니다. Serve의
`--bg`가 Python을 대신 실행해주지 않으므로, 자동 시작은 수동 연결 검증 이후 별도로
systemd 서비스를 구성하세요. 서버가 작동하는 사용자·가상환경·모델 캐시를 그대로 사용해야 합니다.

상태 확인:

```bash
tailscale status
sudo tailscale serve status
```

이 안내에서 만든 HTTPS 443 Serve를 중지하려면 다음을 실행합니다. 다른 서비스가 같은
443 설정을 함께 사용하고 있다면 그 서비스도 영향을 받으므로 먼저 status를 확인하세요.

```bash
sudo tailscale serve --https=443 off
```

Python 서버는 실행 중인 터미널에서 `Ctrl+C`로 종료합니다. 이 안내는 공유기 포트 포워딩,
공개 DNS 변경, Tailscale Funnel 활성화를 요구하지 않습니다.

## 완료 확인

- 스마트폰의 `https://실제도메인/api/health`에서 정상 JSON 응답을 확인했다.
- `ocrReady`와 `configured`가 모두 `true`다.
- 카메라 촬영 사진을 서버에 보내 라벨과 판정 결과를 받았다.
- 접속 코드와 Gadia 비밀키가 GitHub에 포함되지 않았다.

이 문서는 현재 코드와 공식 문서를 기준으로 작성했습니다. 사용자 Jetson과 스마트폰에서
Tailscale 연결·실제 OCR 검사가 완료되었다는 의미는 아닙니다.
