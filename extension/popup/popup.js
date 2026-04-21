const SERVER_URL = 'http://localhost:3000'
const STORAGE_KEYS = { TOKEN: 'figma_token', FILE_URL: 'figma_url' }

// ─── DOM refs ───────────────────────────────────────────────
const $ = (id) => document.getElementById(id)
const tokenInput      = $('figma-token')
const urlInput        = $('figma-url')
const pageSelect      = $('page-select')
const frameSelect     = $('frame-select')
const baseFrameSelect = $('base-frame-select')
const btnLoadFrames   = $('btn-load-frames')
const btnCapture      = $('btn-capture')
const statusEl        = $('status')
const resultEl        = $('result')
const issuesList      = $('issues-list')
const overlaySlider   = $('overlay-slider')
const overlayContainer = $('overlay-container')
const imgFigma        = $('img-figma')
const imgImpl         = $('img-impl')
const scoreCircle     = $('score-circle')
const scoreTitle      = $('score-title')
const scoreSubtitle   = $('score-subtitle')

// ─── Init: 저장된 값 복원 ────────────────────────────────────
chrome.storage.local.get([STORAGE_KEYS.TOKEN, STORAGE_KEYS.FILE_URL], (data) => {
  if (data[STORAGE_KEYS.TOKEN])    tokenInput.value = data[STORAGE_KEYS.TOKEN]
  if (data[STORAGE_KEYS.FILE_URL]) urlInput.value   = data[STORAGE_KEYS.FILE_URL]
  updateCaptureBtn()
})

// ─── 입력 변경 시 저장 & 버튼 상태 갱신 ─────────────────────
tokenInput.addEventListener('input', () => {
  chrome.storage.local.set({ [STORAGE_KEYS.TOKEN]: tokenInput.value })
  updateCaptureBtn()
})

urlInput.addEventListener('input', () => {
  chrome.storage.local.set({ [STORAGE_KEYS.FILE_URL]: urlInput.value })
  resetFrameSelects()
  updateCaptureBtn()
})

function resetFrameSelects() {
  pageSelect.innerHTML      = '<option value="">— 불러오기를 눌러주세요 —</option>'
  frameSelect.innerHTML     = '<option value="">— 페이지를 선택해주세요 —</option>'
  baseFrameSelect.innerHTML = '<option value="">— 선택 안 함 (전체 화면 비교) —</option>'
  pageSelect.disabled      = true
  frameSelect.disabled     = true
  baseFrameSelect.disabled = true
}

function updateCaptureBtn() {
  btnCapture.disabled = !(tokenInput.value.trim() && urlInput.value.trim() && frameSelect.value)
}

// ─── Figma 파일 key 추출 ─────────────────────────────────────
function extractFigmaFileKey(url) {
  const match = url.match(/figma\.com\/(?:file|design)\/([a-zA-Z0-9]+)/)
  return match ? match[1] : null
}

// ─── 1단계: 페이지 목록 불러오기 ────────────────────────────
btnLoadFrames.addEventListener('click', async () => {
  const token   = tokenInput.value.trim()
  const fileKey = extractFigmaFileKey(urlInput.value.trim())

  if (!token)   return showStatus('Figma 토큰을 입력해주세요', 'error')
  if (!fileKey) return showStatus('올바른 Figma URL을 입력해주세요', 'error')

  showStatus('페이지 목록을 불러오는 중...', 'loading')
  btnLoadFrames.disabled = true

  try {
    const res = await fetch(`https://api.figma.com/v1/files/${fileKey}?depth=1`, {
      headers: { 'X-Figma-Token': token },
    })

    if (!res.ok) throw new Error(`Figma API 오류: ${res.status}`)

    const data  = await res.json()
    const pages = data.document?.children ?? []

    if (pages.length === 0) throw new Error('페이지를 찾을 수 없습니다')

    pageSelect.innerHTML = '<option value="">— 페이지를 선택해주세요 —</option>' +
      pages.map(p => `<option value="${p.id}">${p.name}</option>`).join('')
    pageSelect.disabled = false

    hideStatus()
  } catch (err) {
    showStatus(err.message, 'error')
  } finally {
    btnLoadFrames.disabled = false
  }
})

// ─── 2단계: 선택한 페이지의 프레임 불러오기 ─────────────────
pageSelect.addEventListener('change', async () => {
  const token   = tokenInput.value.trim()
  const fileKey = extractFigmaFileKey(urlInput.value.trim())
  if (pageSelect.value) await loadFramesForPage(token, fileKey, pageSelect.value)
})

async function loadFramesForPage(token, fileKey, pageId) {
  showStatus('프레임 목록을 불러오는 중...', 'loading')
  pageSelect.disabled      = true
  frameSelect.innerHTML    = '<option value="">⏳ 불러오는 중...</option>'
  frameSelect.disabled     = true
  baseFrameSelect.innerHTML = '<option value="">⏳ 불러오는 중...</option>'
  baseFrameSelect.disabled = true
  updateCaptureBtn()

  try {
    const res = await fetch(
      `https://api.figma.com/v1/files/${fileKey}/nodes?ids=${encodeURIComponent(pageId)}&depth=1`,
      { headers: { 'X-Figma-Token': token } }
    )

    if (!res.ok) throw new Error(`Figma API 오류: ${res.status}`)

    const data     = await res.json()
    const pageNode = data.nodes?.[pageId]?.document
    const frames   = (pageNode?.children ?? [])
      .filter(n => n.type === 'FRAME' || n.type === 'COMPONENT' || n.type === 'SECTION')
      .map(n => ({ id: n.id, name: n.name }))

    if (frames.length === 0) throw new Error('이 페이지에 프레임이 없습니다')

    const options = frames.map(f => `<option value="${f.id}">${f.name}</option>`).join('')
    frameSelect.innerHTML     = options
    baseFrameSelect.innerHTML = '<option value="">— 선택 안 함 (전체 화면 비교) —</option>' + options
    pageSelect.disabled      = false
    frameSelect.disabled     = false
    baseFrameSelect.disabled = false

    hideStatus()
    updateCaptureBtn()
  } catch (err) {
    frameSelect.innerHTML     = '<option value="">— 불러오기 실패 —</option>'
    baseFrameSelect.innerHTML = '<option value="">— 불러오기 실패 —</option>'
    pageSelect.disabled      = false
    showStatus(err.message, 'error')
    updateCaptureBtn()
  }
}

frameSelect.addEventListener('change', updateCaptureBtn)

// ─── 캡처 & 비교 ─────────────────────────────────────────────
btnCapture.addEventListener('click', async () => {
  const token         = tokenInput.value.trim()
  const fileKey       = extractFigmaFileKey(urlInput.value.trim())
  const frameId       = frameSelect.value
  const baseFrameId   = baseFrameSelect.value || undefined

  btnCapture.disabled = true
  hideResult()
  showStatus('화면 캡처 중...', 'loading')

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    const screenshotDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: 'png',
      quality: 100,
    })

    showStatus(
      baseFrameId ? 'Figma 베이스·신규 프레임 비교 분석 중...' : 'Figma와 비교 분석 중...',
      'loading'
    )

    const res = await fetch(`${SERVER_URL}/compare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        figmaToken:       token,
        figmaFileKey:     fileKey,
        figmaFrameId:     frameId,
        figmaBaseFrameId: baseFrameId,
        screenshotDataUrl,
      }),
    })

    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.message || `서버 오류: ${res.status}`)
    }

    const report = await res.json()
    hideStatus()
    renderResult(report, screenshotDataUrl)

  } catch (err) {
    showStatus(err.message, 'error')
    btnCapture.disabled = false
  }
})

// ─── 결과 렌더링 ─────────────────────────────────────────────
function renderResult(report, screenshotDataUrl) {
  const score = report.score ?? 0
  scoreCircle.textContent = score
  scoreCircle.className   = 'score-circle ' + (score >= 80 ? 'high' : score >= 50 ? 'medium' : 'low')
  scoreTitle.textContent  = score >= 80 ? '잘 구현됐어요!' : score >= 50 ? '일부 수정 필요' : '수정이 필요해요'
  scoreSubtitle.textContent = `이슈 ${report.issues?.length ?? 0}건 발견`

  if (report.figmaImageUrl) {
    imgFigma.src = report.figmaImageUrl
    imgImpl.src  = screenshotDataUrl
    setClip(50)
    overlaySlider.value = 50
  }

  issuesList.innerHTML = ''
  if (report.issues?.length > 0) {
    const severityOrder = { critical: 0, major: 1, minor: 2 }
    const sorted = [...report.issues].sort((a, b) =>
      (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3)
    )
    sorted.forEach(issue => {
      const el = document.createElement('div')
      el.className = 'issue-item'
      el.innerHTML = `
        <div class="issue-dot ${issue.severity}"></div>
        <div class="issue-content">
          <div class="issue-meta">
            <span class="issue-category">${issue.category}</span>
            ${issue.element ? `<span class="issue-element">${issue.element}</span>` : ''}
          </div>
          <div class="issue-desc">${issue.description}</div>
          ${issue.expected || issue.actual ? `
            <div class="issue-diff">
              ${issue.expected ? `<span class="diff-label">Figma</span><span class="diff-value expected">${issue.expected}</span>` : ''}
              ${issue.actual   ? `<span class="diff-label">현재</span><span class="diff-value actual">${issue.actual}</span>` : ''}
            </div>` : ''}
          ${issue.fix ? `<div class="issue-fix">${issue.fix}</div>` : ''}
        </div>
      `
      issuesList.appendChild(el)
    })
  } else {
    issuesList.innerHTML = '<div class="issue-item"><div class="issue-content"><div class="issue-desc" style="color:#4ade80">발견된 이슈가 없습니다 🎉</div></div></div>'
  }

  chrome.storage.local.set({ last_report: report })
  resultEl.classList.add('visible')
  btnCapture.disabled = false
}

// ─── 클립 리빌 슬라이더 ──────────────────────────────────────
function setClip(val) {
  const pct = val + '%'
  overlayContainer.style.setProperty('--clip', pct)
  overlaySlider.style.setProperty('--pct', pct)
}

overlaySlider.addEventListener('input', (e) => setClip(e.target.value))

// ─── 하단 버튼 ───────────────────────────────────────────────
$('btn-copy').addEventListener('click', async () => {
  const data = await chrome.storage.local.get('last_report')
  if (!data.last_report) return
  const report = data.last_report
  const severityOrder = { critical: 0, major: 1, minor: 2 }
  const sorted = [...(report.issues ?? [])].sort((a, b) =>
    (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3)
  )
  const lines = ['다음 Visual QA 이슈들을 수정해줘:', '']
  sorted.forEach((issue, i) => {
    lines.push(`${i + 1}. [${issue.severity}] ${issue.category}${issue.element ? ` — ${issue.element}` : ''}`)
    lines.push(`   ${issue.description}`)
    if (issue.expected) lines.push(`   Figma 기준: ${issue.expected}`)
    if (issue.actual)   lines.push(`   현재 구현: ${issue.actual}`)
    if (issue.fix)      lines.push(`   수정 방법: ${issue.fix}`)
    lines.push('')
  })
  await navigator.clipboard.writeText(lines.join('\n'))
  showStatus('에이전트 전달용 텍스트 복사됨!', 'loading')
  setTimeout(hideStatus, 1500)
})

$('btn-reset').addEventListener('click', () => {
  hideResult()
  btnCapture.disabled = false
})


// ─── 유틸 ────────────────────────────────────────────────────
function showStatus(msg, type = '') {
  statusEl.innerHTML = type === 'loading'
    ? `<span class="spinner"></span>${msg}`
    : msg
  statusEl.className = `status visible ${type}`
}

function hideStatus()  { statusEl.className = 'status' }
function hideResult()  { resultEl.classList.remove('visible') }
