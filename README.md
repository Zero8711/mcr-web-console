# 웹 시리얼 콘솔

Chrome / Edge 에서 COM 포트에 직접 연결하는 Tera Term 스타일 콘솔입니다.
파이썬·Node 설치 없이 HTML 만으로 동작합니다.

페이지는 서버에서 받아도, 시리얼 연결은 **그 브라우저가 열린 PC의 COM 포트**로 붙습니다.

## 지원 브라우저

- Chrome
- Edge

Firefox, Safari, `file://` 로 연 페이지는 Web Serial API 가 동작하지 않습니다.
COM 을 열려면 `https://` 또는 `http://127.0.0.1` 이어야 합니다.

## 두 가지 쓰는 법

### 1) 이 PC USB 콘솔만 (GitHub Pages)

공식 주소는 이것만 씁니다.

```
https://zero8711.github.io/mcr-web-console/index.html
```

출장·사내 어디서나 [연결] 로 **그 PC에 꽂힌 COM** 을 씁니다. VPN 이 없어도 됩니다.

Pages 에 Custom domain / CNAME 을 넣지 마세요. 다른 도메인으로 넘어가면 현장이 열리지 않습니다.

Pages 설정: Settings → Pages → Deploy from a branch → `main` / `/ (root)`.
저장소 루트에 `index.html` 이 있어야 합니다. `.nojekyll` 이 있으면 Jekyll 처리를 건너뜁니다.

비공개 저장소의 Pages 는 GitHub Pro/Team/Enterprise 가 필요합니다.
공개 Pages 는 누구나 UI 를 열 수 있지만, COM 은 그 사람이 자기 PC 에서 [연결] 해야 열립니다.

### 2) 시험팀 COM 을 다른 사람이 같이 보기

**GitHub Pages (주소만)**

1. 시험팀: Pages 주소에서 COM 연결 → [공유 시작]
2. 나온 `join.html?room=...` 링크를 보냄
3. 개발팀: 그 링크만 연다. `연결.bat` 불필요
4. 시험팀 탭을 닫으면 끊긴다. 회사망이 WebRTC/P2P 를 막으면 실패할 수 있다.

**연결.bat (로컬 중계, 사내 LAN/UPnP/VPN)**

1. 시험팀: `연결.bat` → `http://127.0.0.1:8765/` 에서 COM 연결 → [공유 시작]
2. 개발팀: 시험팀이 준 시험팀 IP:8765 링크

사외에서 bat 공유를 쓰려면 양쪽 사내 VPN 이 필요합니다.

## 로컬 중계

`연결.bat` 을 실행하면 `http://127.0.0.1:8765/` 로 열립니다.

## 사내 HTTPS 로 쓰기

이 폴더를 IIS / nginx 에 올려 `https://serial.회사도메인/` 으로 열면 GitHub Pages 와 같습니다. COM 만 됩니다. 공유는 역시 `연결.bat` 입니다.

올리는 파일:

```
index.html
join.html
src/
vendor/
```

같은 COM 을 Tera Term 이 잡고 있으면 실패하므로, 기존 터미널은 종료한 뒤 연결하세요.

## 설정

| 항목 | 기본값 | 설명 |
|------|--------|------|
| Baud | 115200 | 9600 / 19200 / 38400 / 57600 / 115200 / 230400 |
| Data / Parity / Stop | 8 N 1 | 연결 중에 바꾸면 같은 포트로 다시 엽니다 |
| 개행 | CR | 스위치 콘솔은 보통 CR. 장비가 반응하지 않으면 LF 또는 CR+LF 로 바꿔 보세요 |
| Local Echo | 끔 | 장비가 입력을 에코하지 않을 때만 켜세요 |

## 제약

- 페이지가 COM 을 몰래 열 수는 없습니다. 사용자가 **연결** 을 눌러 포트를 선택해야 합니다.
- 이미 다른 프로그램이 연 COM 의 로그를 가로채는 것은 Windows 에서 불가능합니다.
- GitHub Pages 공유는 시험팀 브라우저가 방입니다. 탭을 닫으면 끊깁니다.
- `file://` 이나 파이썬 HTTP 서버는 사용하지 않습니다.
