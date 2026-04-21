import express from 'express'
import cors from 'cors'
import sharp from 'sharp'

const app  = express()
const PORT = 3000

app.use(cors())
app.use(express.json({ limit: '20mb' })) // 스크린샷 base64 크기 고려

// ─── POST /compare ────────────────────────────────────────────
app.post('/compare', async (req, res) => {
  const { figmaToken, figmaFileKey, figmaFrameId, figmaBaseFrameId, screenshotDataUrl } = req.body

  // 유효성 검사
  if (!figmaToken || !figmaFileKey || !figmaFrameId || !screenshotDataUrl) {
    return res.status(400).json({ message: '필수 파라미터가 누락됐습니다.' })
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY
  if (!anthropicKey) {
    return res.status(500).json({ message: 'ANTHROPIC_API_KEY 환경변수가 없습니다.' })
  }

  try {
    // 1. Figma API → 프레임 PNG export (신규 디자인 scale=2, 베이스 scale=1)
    const figmaExports = await Promise.all([
      exportFigmaFrame(figmaToken, figmaFileKey, figmaFrameId, 2),
      figmaBaseFrameId ? exportFigmaFrame(figmaToken, figmaFileKey, figmaBaseFrameId, 1) : null,
    ])

    // 2. Figma 이미지 → base64 (Claude API 전달용)
    const [figmaImageBase64, figmaBaseBase64] = await Promise.all([
      urlToBase64(figmaExports[0]),
      figmaExports[1] ? urlToBase64(figmaExports[1]) : null,
    ])

    // 3. 구현 스크린샷 base64 추출 후 Figma 크기에 맞게 정규화
    const rawImplBase64 = screenshotDataUrl.replace(/^data:image\/\w+;base64,/, '')
    const implBase64    = await normalizeScreenshot(figmaImageBase64, rawImplBase64)

    // 4. Claude Vision으로 diff 분석
    const report = await analyzeWithClaude(anthropicKey, figmaImageBase64, implBase64, figmaBaseBase64)

    // 5. 응답 (figmaImageUrl도 포함해서 팝업 오버레이에 쓸 수 있게)
    res.json({ ...report, figmaImageUrl: figmaExports[0] })

  } catch (err) {
    console.error('[compare error]', err)
    res.status(500).json({ message: err.message })
  }
})

// ─── Figma: 프레임 PNG export ─────────────────────────────────
async function exportFigmaFrame(token, fileKey, frameId, scale = 2) {
  const url = `https://api.figma.com/v1/images/${fileKey}?ids=${frameId}&format=png&scale=${scale}`
  const res  = await fetch(url, { headers: { 'X-Figma-Token': token } })

  if (!res.ok) throw new Error(`Figma export 실패: ${res.status}`)

  const data = await res.json()
  if (data.err) throw new Error(`Figma error: ${data.err}`)

  const imageUrl = data.images?.[frameId]
  if (!imageUrl) throw new Error('Figma에서 이미지 URL을 받지 못했습니다.')

  return imageUrl
}

// ─── URL → base64 변환 ───────────────────────────────────────
async function urlToBase64(url) {
  const res    = await fetch(url)
  const buffer = await res.arrayBuffer()
  return Buffer.from(buffer).toString('base64')
}

// ─── 스크린샷 → Figma 크기로 정규화 ─────────────────────────
async function normalizeScreenshot(figmaBase64, implBase64) {
  const figmaBuffer = Buffer.from(figmaBase64, 'base64')
  const implBuffer  = Buffer.from(implBase64,  'base64')

  const { width, height } = await sharp(figmaBuffer).metadata()

  const normalized = await sharp(implBuffer)
    .resize(width, height, { fit: 'cover', position: 'centre' })
    .png()
    .toBuffer()

  return normalized.toString('base64')
}

// ─── Claude Vision: 두 이미지 diff 분석 ─────────────────────
async function analyzeWithClaude(apiKey, figmaBase64, implBase64, figmaBaseBase64 = null) {
  const systemPrompt = `당신은 UI/UX 품질 검수 전문가입니다.
이미지를 비교하여 디자인과 구현의 차이를 정밀하게 분석합니다.

반드시 아래 JSON 형식으로만 응답하세요. 다른 텍스트는 포함하지 마세요.

{
  "score": 0~100 사이 정수 (100이 완벽한 일치),
  "issues": [
    {
      "id": "고유 문자열 (issue_1, issue_2 등)",
      "severity": "critical | major | minor",
      "category": "spacing | color | typography | size | border-radius | shadow | alignment | missing",
      "element": "어떤 UI 요소인지 (예: 상단 타이틀 텍스트, 확인 버튼, 카드 컨테이너)",
      "description": "한국어로 간결하게. 반드시 구체적 수치를 포함. 상대적 표현('더 큰', '좁아 보임' 등) 절대 금지.",
      "expected": "Figma 기준값. 반드시 구체적 단위 포함 (예: padding: 12px 24px, font-size: 16px, color: #FF5733, gap: 8px)",
      "actual": "구현된 값. 반드시 구체적 단위 포함 (예: padding: 8px 16px, font-size: 14px, color: #FF0000, gap: 4px)",
      "fix": "수정 제안. 구체적 속성명과 값 포함 (예: padding을 12px 24px로 변경, font-size를 16px로 변경)"
    }
  ]
}

중요 규칙:
- expected와 actual에는 반드시 px, %, hex, rem 등 구체적인 단위가 있어야 합니다
- "더 크다", "좁아 보인다", "약간 다르다" 같은 상대적 표현은 절대 사용하지 마세요
- 수치를 정확히 알 수 없는 경우 "약 Npx" 형식으로 추정값을 명시하세요
- 색상은 반드시 hex 코드로 표기하세요

severity 기준:
- critical: 레이아웃 깨짐, 색상 완전 불일치, 컴포넌트 누락
- major: 패딩/마진 8px 이상 차이, 폰트 크기 차이, 정렬 불일치
- minor: 4px 미만 간격 차이, 미세한 색상 차이, 그림자 세기 차이`

  const userContent = figmaBaseBase64
    ? [
        {
          type: 'text',
          text: '세 개의 이미지를 분석해주세요.\n- 1번: Figma 베이스 화면 (기존 메인 화면)\n- 2번: Figma 신규 디자인 (메인 화면 + 새로 추가된 레이어)\n- 3번: 실제 구현 화면\n\n1번과 2번을 비교해 새로 추가된 요소(오버레이, 텍스트, 이미지 에셋 등)를 먼저 파악하고, 해당 요소들이 3번 구현에서 2번 Figma와 얼마나 일치하는지만 분석해주세요. 베이스 화면(1번과 동일한 부분)은 분석에서 제외하세요.',
        },
        {
          type:          'image',
          source:        { type: 'base64', media_type: 'image/png', data: figmaBaseBase64 },
          cache_control: { type: 'ephemeral' },
        },
        {
          type:   'image',
          source: { type: 'base64', media_type: 'image/png', data: figmaBase64 },
        },
        {
          type:   'image',
          source: { type: 'base64', media_type: 'image/png', data: implBase64 },
        },
      ]
    : [
        {
          type: 'text',
          text: '첫 번째 이미지는 Figma 디자인 원본이고, 두 번째 이미지는 실제 구현 화면입니다. 차이점을 분석해주세요.',
        },
        {
          type:   'image',
          source: { type: 'base64', media_type: 'image/png', data: figmaBase64 },
        },
        {
          type:   'image',
          source: { type: 'base64', media_type: 'image/png', data: implBase64 },
        },
      ]

  const headers = {
    'Content-Type':      'application/json',
    'x-api-key':         apiKey,
    'anthropic-version': '2023-06-01',
    ...(figmaBaseBase64 && { 'anthropic-beta': 'prompt-caching-2024-07-31' }),
  }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model:      'claude-sonnet-4-6',
      max_tokens: 2048,
      system:     systemPrompt,
      messages: [{ role: 'user', content: userContent }],
    }),
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(`Claude API 오류: ${err.error?.message ?? res.status}`)
  }

  const data = await res.json()
  const text = data.content?.[0]?.text ?? ''

  // JSON 파싱 (마크다운 코드블록 제거)
  const clean = text.replace(/```json\n?|\n?```/g, '').trim()

  try {
    return JSON.parse(clean)
  } catch {
    console.error('[Claude 응답 파싱 실패]', text)
    throw new Error('AI 분석 결과 파싱에 실패했습니다.')
  }
}

// ─── Health check ─────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ ok: true }))

app.listen(PORT, () => {
  console.log(`\n✅ Visual QA 서버 실행 중: http://localhost:${PORT}`)
  console.log(`   ANTHROPIC_API_KEY: ${process.env.ANTHROPIC_API_KEY ? '✓ 설정됨' : '✗ 없음 (필수!)'}`)
})
