# Visual QA Tool

Figma 디자인과 실제 구현 화면을 AI로 비교하는 Chrome Extension + 서버.

## 구조

```
visual-qa/
├── extension/          # Chrome Extension
│   ├── manifest.json
│   ├── background.js
│   └── popup/
│       ├── index.html
│       └── popup.js
└── server/             # 비교 서버 (Node.js)
    ├── package.json
    └── server.js
```

## 빠른 시작

### 1. 서버 실행

```bash
cd server
npm install
ANTHROPIC_API_KEY=sk-ant-... npm run dev
```

서버가 `http://localhost:3000` 에서 실행됩니다.

> **왜 별도 서버가 필요한가요?**
> Chrome Extension 코드는 누구나 압축 해제해서 볼 수 있기 때문에 `ANTHROPIC_API_KEY`를 Extension 안에 넣으면 노출됩니다.
> Claude API 호출은 서버에서만 처리하고, Figma Personal Access Token은 사용자 본인 토큰이므로 Extension에서 직접 사용합니다.

### 2. Extension 설치

1. Chrome에서 `chrome://extensions` 열기
2. 우측 상단 **개발자 모드** 활성화
3. **압축 해제된 확장 프로그램 로드** 클릭
4. `extension/` 폴더 선택

### 3. 사용

1. 비교하고 싶은 화면을 브라우저에 띄우기 (모달이면 직접 열어둔 상태로)
2. Extension 아이콘 클릭
3. **Figma Personal Access Token** 입력
   - Figma → Settings → Personal Access Tokens에서 발급
4. **Figma File URL** 붙여넣기
5. **불러오기** 버튼 클릭 → 페이지 목록 로드
6. **페이지** 선택 → 해당 페이지의 프레임만 로드됨
7. **신규 디자인 프레임** 선택
8. (선택사항) **베이스 화면 프레임** 선택
   - 기존 화면 위에 새 요소가 추가된 경우, 베이스를 지정하면 추가된 부분만 집중 분석
9. **지금 화면 캡처 후 비교** 클릭

## 결과 화면

- **점수**: 0~100 (Figma 대비 구현 일치도)
- **오버레이 슬라이더**: Figma ↔ 구현 화면 좌우 비교. 헤더의 **숨기기/보이기** 버튼으로 토글 가능
- **이슈 목록**: severity 순(critical → major → minor)으로 정렬. 각 이슈에 Figma 기준값과 현재 구현값을 px/hex 단위로 표시

## 에이전트에게 바로 전달하기

이슈 목록 하단의 **에이전트 전달** 버튼을 누르면 아래 형식의 텍스트가 클립보드에 복사됩니다.
Claude Code 등에 그대로 붙여넣으면 됩니다.

```
다음 Visual QA 이슈들을 수정해줘:

1. [critical] spacing — 확인 버튼
   확인 버튼 좌우 패딩이 24px입니다
   Figma 기준: padding: 12px 24px
   현재 구현: padding: 12px 32px
   수정 방법: padding을 12px 24px로 변경
```

## 베이스 프레임 활용

새 기능이 기존 화면 위에 오버레이로 추가되는 경우 (예: 토스트, 바텀싯, 모달):

- **신규 디자인 프레임**: 새 요소가 포함된 전체 화면
- **베이스 화면 프레임**: 기존 메인 화면 (변경 없는 배경)

베이스를 지정하면 AI가 변경된 부분만 집중 분석해 노이즈를 줄여줍니다.

## 환경변수

| 변수 | 설명 |
|------|------|
| `ANTHROPIC_API_KEY` | Claude API 키 (필수) |

## 이슈 카테고리

| category | 설명 |
|----------|------|
| `spacing` | 패딩, 마진, 간격 |
| `color` | 색상, 투명도 |
| `typography` | 폰트 크기, 굵기, 행간 |
| `size` | 너비, 높이 |
| `border-radius` | 모서리 둥글기 |
| `shadow` | 그림자 |
| `alignment` | 정렬 |
| `missing` | 누락된 요소 |

## severity 기준

| severity | 기준 |
|----------|------|
| `critical` | 레이아웃 깨짐, 색상 완전 불일치, 컴포넌트 누락 |
| `major` | 패딩/마진 8px 이상 차이, 폰트 크기 차이, 정렬 불일치 |
| `minor` | 4px 미만 간격 차이, 미세한 색상 차이, 그림자 세기 차이 |
