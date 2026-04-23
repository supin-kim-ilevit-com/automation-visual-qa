import express from 'express'
import cors from 'cors'
import sharp from 'sharp'

const app  = express()
const PORT = process.env.PORT || 3000

// chrome-extension:// 오리진만 허용 (ID 무관)
app.use(cors({ origin: /^chrome-extension:\/\// }))
app.use(express.json({ limit: '20mb' }))

// ─── 타임아웃 fetch ───────────────────────────────────────────
function fetchWithTimeout(url, options = {}, timeoutMs = 30_000) {
  const controller = new AbortController()
  const id = setTimeout(() => controller.abort(), timeoutMs)
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(id))
}

// ─── Figma ID 형식 검증 ───────────────────────────────────────
const FIGMA_ID_RE = /^[a-zA-Z0-9_:/-]+$/
function isValidFigmaId(id) { return FIGMA_ID_RE.test(id) }

// ─── POST /compare ────────────────────────────────────────────
app.post('/compare', async (req, res) => {
  const { figmaToken, figmaFileKey, figmaFrameId, figmaBaseFrameId, screenshotDataUrl, cropRegion } = req.body

  const anthropicKey = process.env.ANTHROPIC_API_KEY
  if (!anthropicKey) return res.status(500).json({ message: 'ANTHROPIC_API_KEY 환경변수가 없습니다.' })

  const missing = ['figmaToken', 'figmaFileKey', 'figmaFrameId', 'screenshotDataUrl']
    .filter(k => !req.body[k])

  if (missing.length > 0) {
    return res.status(400).json({ message: `필수 파라미터 누락: ${missing.join(', ')}` })
  }

  if (!isValidFigmaId(figmaFileKey) || !isValidFigmaId(figmaFrameId)) {
    return res.status(400).json({ message: '유효하지 않은 Figma ID 형식입니다.' })
  }

  if (figmaBaseFrameId && !isValidFigmaId(figmaBaseFrameId)) {
    return res.status(400).json({ message: '유효하지 않은 베이스 프레임 ID 형식입니다.' })
  }

  // screenshotDataUrl 형식 검증
  const dataUrlMatch = screenshotDataUrl.match(/^data:image\/(png|jpeg|webp);base64,(.+)$/)
  if (!dataUrlMatch) {
    return res.status(400).json({ message: '유효하지 않은 이미지 형식입니다.' })
  }
  
  const rawImplBase64  = dataUrlMatch[2]
  const capturedViewport = req.body.capturedViewport ?? null

  try {
    const figmaExports = await Promise.all([
      exportFigmaFrame(figmaToken, figmaFileKey, figmaFrameId, 2),
      figmaBaseFrameId ? exportFigmaFrame(figmaToken, figmaFileKey, figmaBaseFrameId, 1) : null,
    ])

    const [figmaImageBase64, figmaBaseBase64] = await Promise.all([
      urlToBase64(figmaExports[0]),
      figmaExports[1] ? urlToBase64(figmaExports[1]) : null,
    ])

    // Figma 프레임 실제 크기 추출 (scale=2로 export했으므로 ÷2)
    const figmaMeta    = await sharp(Buffer.from(figmaImageBase64, 'base64')).metadata()
    const figmaFrame   = { width: Math.round(figmaMeta.width / 2), height: Math.round(figmaMeta.height / 2) }

    let figmaBase64ForAnalysis = figmaImageBase64
    let implBase64ForAnalysis
    let cropResult = null

    if (cropRegion) {
      cropResult = await cropAndMatch(anthropicKey, figmaImageBase64, rawImplBase64, cropRegion)
      implBase64ForAnalysis = await normalizeScreenshot(cropResult.croppedFigmaBase64, cropResult.croppedImplBase64)
      figmaBase64ForAnalysis = cropResult.croppedFigmaBase64
    } else {
      implBase64ForAnalysis = await normalizeScreenshot(figmaImageBase64, rawImplBase64)
    }

    const report = await analyzeWithClaude(
      anthropicKey, figmaBase64ForAnalysis, implBase64ForAnalysis,
      cropRegion ? null : figmaBaseBase64,
      { figmaFrame, capturedViewport }, !!cropRegion
    )

    const meta = { figmaFrame, capturedViewport }
    const responseData = { ...report, meta }
    if (cropRegion) {
      responseData.figmaImageUrl = `data:image/png;base64,${figmaBase64ForAnalysis}`
      responseData.implImageDataUrl = `data:image/png;base64,${cropResult.croppedImplBase64}`
    } else {
      responseData.figmaImageUrl = figmaExports[0]
    }
    res.json(responseData)

  } catch (err) {
    console.error('[compare error]', err)
    const isKnown = ['Figma', 'Claude', 'FIGMA', 'ANTHROPIC', '이미지'].some(k => err.message?.includes(k))
    res.status(500).json({ message: isKnown ? err.message : '분석 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.' })
  }
})

// ─── Figma: 프레임 PNG export ─────────────────────────────────
async function exportFigmaFrame(token, fileKey, frameId, scale = 2) {
  const url = `https://api.figma.com/v1/images/${fileKey}?ids=${frameId}&format=png&scale=${scale}`
  const res = await fetchWithTimeout(url, { headers: { 'X-Figma-Token': token } })

  if (!res.ok) throw new Error(`Figma export 실패: ${res.status}`)

  const data = await res.json()
  if (data.err) throw new Error(`Figma error: ${data.err}`)

  const imageUrl = data.images?.[frameId]
  if (!imageUrl) throw new Error('Figma에서 이미지 URL을 받지 못했습니다.')

  return imageUrl
}

// ─── URL → base64 변환 ───────────────────────────────────────
async function urlToBase64(url) {
  const res = await fetchWithTimeout(url)
  if (!res.ok) throw new Error(`이미지 다운로드 실패: ${res.status}`)
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

// ─── 크롭: 구현 영역 추출 + Figma 매칭 ───────────────────────
async function cropAndMatch(apiKey, figmaBase64, rawImplBase64, cropRegion) {
  const implBuffer  = Buffer.from(rawImplBase64, 'base64')
  const figmaBuffer = Buffer.from(figmaBase64,   'base64')

  const { width: iW, height: iH } = await sharp(implBuffer).metadata()

  // Clamp crop to valid bounds
  const x = Math.max(0, Math.min(0.95, cropRegion.x))
  const y = Math.max(0, Math.min(0.95, cropRegion.y))
  const w = Math.max(0.05, Math.min(1 - x, cropRegion.width))
  const h = Math.max(0.05, Math.min(1 - y, cropRegion.height))

  const croppedImplBuffer = await sharp(implBuffer)
    .extract({ left: Math.round(x * iW), top: Math.round(y * iH), width: Math.round(w * iW), height: Math.round(h * iH) })
    .png().toBuffer()
  const croppedImplBase64 = croppedImplBuffer.toString('base64')

  // Find matching region in Figma using Claude Vision
  const figmaSmall     = await sharp(figmaBuffer).resize({ width: 800 }).png().toBuffer()
  const figmaSmallB64  = figmaSmall.toString('base64')
  let figmaMatch = { x, y, width: w, height: h } // fallback: same ratios

  try {
    const matchRes = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 200,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: '첫 번째 이미지는 구현 화면의 특정 UI 영역입니다. 두 번째 이미지는 피그마 전체 디자인입니다. 텍스트/이미지 콘텐츠는 다를 수 있으니 무시하고, 레이아웃 구조와 위치만으로 대응하는 피그마 영역을 찾아 JSON으로만 응답하세요: {"x":0~1사이 숫자,"y":0~1사이 숫자,"width":0~1사이 숫자,"height":0~1사이 숫자}' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: croppedImplBase64 } },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: figmaSmallB64 } },
          ],
        }],
      }),
    }, 30_000)

    if (matchRes.ok) {
      const data = await matchRes.json()
      const text = data.content?.[0]?.text ?? ''
      const jsonMatch = text.match(/\{[\s\S]*?\}/)
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0])
        if (['x', 'y', 'width', 'height'].every(k => typeof parsed[k] === 'number' && parsed[k] >= 0 && parsed[k] <= 1)) {
          figmaMatch = parsed
        }
      }
    }
  } catch (err) {
    console.warn('[figma match fallback]', err.message)
  }

  // Crop Figma using matched region
  const { width: fW, height: fH } = await sharp(figmaBuffer).metadata()
  const fX  = Math.max(0, Math.min(0.95, figmaMatch.x))
  const fY  = Math.max(0, Math.min(0.95, figmaMatch.y))
  const fW2 = Math.max(0.05, Math.min(1 - fX, figmaMatch.width))
  const fH2 = Math.max(0.05, Math.min(1 - fY, figmaMatch.height))

  const croppedFigmaBuffer = await sharp(figmaBuffer)
    .extract({ left: Math.round(fX * fW), top: Math.round(fY * fH), width: Math.round(fW2 * fW), height: Math.round(fH2 * fH) })
    .png().toBuffer()

  return { croppedImplBase64, croppedFigmaBase64: croppedFigmaBuffer.toString('base64') }
}

// ─── Claude Vision: 두 이미지 diff 분석 ─────────────────────
async function analyzeWithClaude(apiKey, figmaBase64, implBase64, figmaBaseBase64 = null, sizeContext = null, isCropMode = false) {
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
      "fix": "수정 제안. 구체적 속성명과 값 포함 (예: padding을 12px 24px로 변경, font-size를 16px로 변경)",
      "viewportDiff": true 또는 false (spacing/size/alignment 이슈가 뷰포트 크기 차이로 인한 것일 가능성이 높으면 true)
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
  + (isCropMode ? '\n\n[크롭 모드] 이 이미지들은 특정 UI 영역만 크롭된 것입니다. 텍스트, 이미지 등 콘텐츠 차이는 무시하고 레이아웃, 간격, 색상, 폰트 스타일에만 집중하세요.' : '')

  const viewportNote = sizeContext?.figmaFrame && sizeContext?.capturedViewport
    ? `\n\n[화면 크기 정보]\n- Figma 프레임: ${sizeContext.figmaFrame.width}×${sizeContext.figmaFrame.height}px\n- 실제 캡처 뷰포트: ${sizeContext.capturedViewport.width}×${sizeContext.capturedViewport.height}px\nspacing/size/alignment 이슈를 분석할 때, 이 뷰포트 차이로 인해 절대 px값이 비율적으로 다르게 보일 수 있습니다. 절대값 차이가 뷰포트 비율 차이(${Math.round(sizeContext.capturedViewport.width / sizeContext.figmaFrame.width * 100)}%) 범위 내라면 viewportDiff: true로 표시해주세요.`
    : ''

  const userContent = figmaBaseBase64
    ? [
        {
          type: 'text',
          text: `세 개의 이미지를 분석해주세요.\n- 1번: Figma 베이스 화면 (기존 메인 화면)\n- 2번: Figma 신규 디자인 (메인 화면 + 새로 추가된 레이어)\n- 3번: 실제 구현 화면\n\n1번과 2번을 비교해 새로 추가된 요소(오버레이, 텍스트, 이미지 에셋 등)를 먼저 파악하고, 해당 요소들이 3번 구현에서 2번 Figma와 얼마나 일치하는지만 분석해주세요. 베이스 화면(1번과 동일한 부분)은 분석에서 제외하세요.${viewportNote}`,
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
          text: isCropMode
            ? `첫 번째 이미지는 피그마 디자인의 특정 영역이고, 두 번째 이미지는 그에 대응하는 실제 구현 화면입니다. 레이아웃/스타일 차이만 분석해주세요 (텍스트·이미지 콘텐츠 차이는 무시).${viewportNote}`
            : `첫 번째 이미지는 Figma 디자인 원본이고, 두 번째 이미지는 실제 구현 화면입니다. 차이점을 분석해주세요.${viewportNote}`,
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

  const res = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model:      'claude-sonnet-4-6',
      max_tokens: 4096,
      system:     systemPrompt,
      messages: [{ role: 'user', content: userContent }],
    }),
  }, 60_000) // Claude는 60초 타임아웃

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(`Claude API 오류: ${err.error?.message ?? res.status}`)
  }

  const data = await res.json()
  const text = data.content?.[0]?.text ?? ''

  return parseJson(text)
}

// ─── JSON 파싱: 코드블록 제거 → 직접 파싱 → 제어문자 제거 후 재시도
function parseJson(text) {
  const clean = text.replace(/```json\n?|\n?```/g, '').trim()

  try { return JSON.parse(clean) } catch {}

  // 문자열 값 내 리터럴 제어문자(줄바꿈·탭 등)만 제거 후 재시도
  const sanitized = clean.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ')
    .replace(/(?<=[^\\])\n/g, ' ')
    .replace(/(?<=[^\\])\r/g, ' ')
    .replace(/(?<=[^\\])\t/g, ' ')

  try { return JSON.parse(sanitized) } catch {}

  console.error('[Claude 응답 파싱 실패]', text)
  throw new Error('AI 분석 결과 파싱에 실패했습니다.')
}

// ─── Health check ─────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ ok: true }))

app.listen(PORT, () => {
  console.log(`\n✅ Visual QA 서버 실행 중: http://localhost:${PORT}`)
  console.log(`   ANTHROPIC_API_KEY: ${process.env.ANTHROPIC_API_KEY ? '✓ 설정됨' : '✗ 없음 (필수!)'}`)
})
