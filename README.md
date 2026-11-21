# 서가 탐정

스마트폰과 Jetson 연결: [Tailscale HTTPS 설정 안내](docs/TAILSCALE_SETUP.md)

실제 인기대출도서 200권을 사용하는 2인 교대 서가 정리 게임입니다. 도서 목록과 게임용 청구기호는 `books.json` 한 파일에서 관리합니다.

- 2열 × 5단, 칸마다 20권, 총 200권
- 칸 번호는 왼쪽 열 위에서 아래로 1~5, 오른쪽 열 6~10
- 칸을 선택하면 20권의 제목·저자·출판사·청구기호가 확대 표시됩니다. 화면 폭에 따라 여러 줄로 표시되며 위치 번호 순서대로 읽습니다.
- 섞는 사람: 두 책을 눌러 교환하거나 무작위로 여러 쌍 교환
- 찾는 사람: 잘못 꽂힌 책을 눌러 표시하고 채점
- 판정: 최초 정렬된 정확한 위치와 현재 위치가 다른 책이 정답
- 결과: 발견, 놓침, 오탐 및 정답 위치 확인

## 실행

`index.html`을 브라우저에서 열고, 화면에서 같은 폴더의 `books.json`을 선택하세요. 설치 없이 실행할 수 있습니다. 브라우저가 로컬 JSON 자동 읽기를 제한하므로 직접 파일을 선택합니다.

또는 프로젝트 폴더에서 아래 명령을 실행하고 `http://localhost:8000`에 접속하면 JSON이 자동으로 로드됩니다.

```sh
python -m http.server 8000 --bind 127.0.0.1
```

한 기기에서 화면을 넘겨주는 방식입니다. 새로고침하면 게임이 초기화됩니다. 글꼴을 불러오지 못해도 기본 글꼴로 동작합니다.

## books.json 구조

- `source`: 원본 파일·시트·범위·제공기관·대출기간·이용허락조건
- `layout`: 2열, 5단, 10칸, 칸마다 20권
- `callNumberPolicy`: 게임용 청구기호 부여 및 정렬 규칙
- `books`: 청구기호순으로 정렬된 200개 도서 객체

도서 객체에는 `bookId`, `title`, `authors`, `primaryAuthor`, `publisher`, `publicationYear`, `volume`, `isbn`, `isbnSupplement`, `loanRank`, `loanCount`, `sourceKdc`, `classification`, `bookMark`, `callNumber`, `sortOrder`, `home` 등이 있습니다. `sourceRow`와 `sourceValues`로 엑셀 원본을 추적할 수 있습니다. ISBN과 KDC는 문자열로 저장합니다. 없는 값은 `null`이며 권차 `"0"`과 구별합니다.

`sortOrder`, `home.shelf`, `home.position`은 모두 1부터 시작합니다. 게임은 이 정렬된 목록의 위치를 정답으로 사용하며, 섞어도 JSON 파일을 변경하지 않습니다.

### 청구기호 부여

`분류번호 + 도서기호 + 선택적 v.권차` 형식입니다. 예: `165.47 강001`.

- 분류번호: 194권의 원본 KDC 유지. 누락된 6권은 `classificationSource: "game_assigned"`와 사유를 기록한 임시 분류입니다. 원본 `sourceKdc`는 `null`로 보존합니다.
- 도서기호: 대표 저자 첫 글자 + 같은 첫 글자 내 저자/작품명순 3자리 일련번호. 같은 작품의 여러 권은 같은 도서기호를 사용합니다.
- 정렬: 분류번호 숫자순 → 한글 우선 → 도서기호 문자순 → 권차 숫자순. 권차가 없는 책은 같은 도서기호의 유권차 책보다 앞섭니다.

이 청구기호는 게임용으로 생성했으며 실제 소장 도서관의 청구기호나 표준 저자기호표를 재현하지 않습니다.

## 데이터 재생성과 검증

Python 표준 라이브러리만으로 원본 XLSX를 읽습니다. 원본 파일은 수정하지 않습니다.

```sh
python scripts/build_catalog.py
python tests/catalog_test.py
node tests/game.test.js
```

원본 200행 일치, ISBN 및 청구기호 고유성, 칸별 20권, 누락 KDC 구분, 0권 보존과 게임 동작을 확인합니다. 게임 테스트는 DOM 어댑터를 이용한 기능 검증이며 실제 브라우저의 시각적 배치를 검증하지는 않습니다.

## 출처

국립중앙도서관 인기대출도서 데이터, 2026-11-19 제공. 원본: `BestLoanList_20261119095853.xlsx`, `인기대출도서_전체!A17:J216`. 대출기간: 2026-01-01~2026-11-18. 원본 표시 이용조건: 저작자표시(BY). 게임용 청구기호 및 서가 배치를 추가했습니다.

자료 출처는 PRD.md를 참조하세요.
# GitHub 배포

- 책장 게임: https://quirinal36.github.io/LibrarySorter/
- 스마트폰 검사 화면: https://quirinal36.github.io/LibrarySorter/LibraryDetector/

`main`에 push하면 GitHub Actions가 브라우저 테스트를 실행하고 정적 화면을 Pages에
배포합니다. Python 서버·환경 설정·원본 문서는 웹 배포 산출물에 포함하지 않습니다.
Jetson CUDA OCR 서버는 별도로 설치해야 합니다([서버 안내](server/README.md)).
스마트폰 화면에 Jetson HTTPS 주소와 접속 코드를 입력하고 서버의 허용 출처에
`https://quirinal36.github.io`를 등록하세요. GPU 검증과 Jetson 연결 전에는 서버 사진
검사를 사용할 수 없습니다. 책장 게임과 기기 내 규칙 비교는 별도로 사용할 수 있습니다.

