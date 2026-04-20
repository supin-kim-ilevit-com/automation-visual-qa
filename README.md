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

### 2. Extension 설치

1. Chrome에서 `chrome://extensions` 열기
2. 우측 상단 **개발자 모드** 활성화
3. **압축 해제된 확장 프로그램 로드** 클릭
4. `extension/` 폴더 선택

### 3. 사용

1. 비교하고 싶은 화면을 브라우저에 띄우고 (모달이면 직접 열어두기)
2. Extension 아이콘 클릭
3. Figma Personal Access Token 입력
   - Figma → Settings → Personal Access Tokens
4. Figma File URL 붙여넣기
5. **불러오기** 버튼으로 프레임 목록 가져오기
6. 비교할 프레임 선택
7. **지금 화면 캡처 후 비교** 클릭

## 결과

- **점수**: 0~100 (Figma 대비 구현 일치도)
- **오버레이 슬라이더**: Figma ↔ 구현 화면 겹쳐보기
- **이슈 목록**: severity별 (critical / major / minor) diff 리포트
- **JSON 복사**: 리포트를 Claude Code 등에 붙여넣어 자동 수정 가능

## 피드백 루프

JSON 복사 → Claude Code에 붙여넣기 예시:

```
아래 Visual QA 리포트를 바탕으로 코드를 수정해줘:
[JSON 붙여넣기]
```

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
