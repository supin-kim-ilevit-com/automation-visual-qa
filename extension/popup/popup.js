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
const cropCanvas      = $('crop-canvas')
const btnCropMode     = $('btn-crop-mode')
const btnCropConfirm  = $('btn-crop-confirm')
const btnCropCancel   = $('btn-crop-cancel')

// ─── Crop & comparison state ─────────────────────────────────
let lastScreenshotDataUrl = null
let lastViewport          = null
let cropActive            = false
let cropDragStart         = null
let pendingCropRegion     = null

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

// ─── 비교 실행 (최초 + 크롭 재비교 공통) ─────────────────────
async function runComparison(screenshotDataUrl, viewport, cropRegion = null) {
  const token       = tokenInput.value.trim()
  const fileKey     = extractFigmaFileKey(urlInput.value.trim())
  const frameId     = frameSelect.value
  const baseFrameId = baseFrameSelect.value || undefined

  showStatus(
    cropRegion ? '선택 영역 분석 중...' :
    (baseFrameId ? 'Figma 베이스·신규 프레임 비교 분석 중...' : 'Figma와 비교 분석 중...'),
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
      capturedViewport: viewport,
      cropRegion,
    }),
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.message || `서버 오류: ${res.status}`)
  }

  const report = await res.json()
  hideStatus()
  renderResult(report, screenshotDataUrl)
}

// ─── 캡처 & 비교 ─────────────────────────────────────────────
btnCapture.addEventListener('click', async () => {
  btnCapture.disabled = true
  hideResult()
  showStatus('화면 캡처 중...', 'loading')

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })

    const [{ result: viewport }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => ({ width: window.innerWidth, height: window.innerHeight }),
    })

    const screenshotDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: 'png',
      quality: 100,
    })

    lastScreenshotDataUrl = screenshotDataUrl
    lastViewport = viewport

    await runComparison(screenshotDataUrl, viewport)

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
    imgImpl.src  = report.implImageDataUrl || screenshotDataUrl
    setClip(50)
    overlaySlider.value = 50
  }

  issuesList.innerHTML = ''
  if (report.issues?.length > 0) {
    const severityOrder = { critical: 0, major: 1, minor: 2 }
    const sorted = [...report.issues].sort((a, b) =>
      (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3)
    )
    const meta = report.meta
    sorted.forEach(issue => {
      const showViewportWarn = issue.viewportDiff &&
        ['spacing', 'size', 'alignment'].includes(issue.category) &&
        meta?.figmaFrame && meta?.capturedViewport

      const viewportWarnHtml = showViewportWarn ? `
        <div class="issue-viewport-warn">
          ⚠️ 뷰포트 차이 영향 가능
          (Figma ${meta.figmaFrame.width}px → 실제 ${meta.capturedViewport.width}px)
        </div>` : ''

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
          ${viewportWarnHtml}
          ${issue.fix ? `<div class="issue-fix">${issue.fix}</div>` : ''}
        </div>
      `
      issuesList.appendChild(el)
    })
  } else {
    issuesList.innerHTML = '<div class="issue-item"><div class="issue-content"><div class="issue-desc" style="color:#4ade80">발견된 이슈가 없습니다 🎉</div></div></div>'
  }

  chrome.storage.local.set({ last_report: report })
  exitCropMode()
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
  exitCropMode()
  pendingCropRegion = null
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

// ─── 크롭 헬퍼: object-fit:contain 레터박스 보정 ─────────────
function getImageRenderedBounds(imgEl, containerEl) {
  const cW = containerEl.offsetWidth
  const cH = containerEl.offsetHeight
  const imgAspect = imgEl.naturalWidth / imgEl.naturalHeight
  const cAspect   = cW / cH
  let rW, rH, oX, oY
  if (imgAspect > cAspect) {
    rW = cW; rH = cW / imgAspect; oX = 0;              oY = (cH - rH) / 2
  } else {
    rH = cH; rW = cH * imgAspect; oX = (cW - rW) / 2; oY = 0
  }
  return { rW, rH, oX, oY }
}

function clampToImageBounds(x, y, b) {
  return {
    x: Math.max(b.oX, Math.min(b.oX + b.rW, x)),
    y: Math.max(b.oY, Math.min(b.oY + b.rH, y)),
  }
}

function drawCropOverlay(canvas, start, end, b) {
  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  const x = Math.min(start.x, end.x), y = Math.min(start.y, end.y)
  const w = Math.abs(end.x - start.x), h = Math.abs(end.y - start.y)
  ctx.fillStyle = 'rgba(0,0,0,0.5)'
  ctx.fillRect(b.oX, b.oY, b.rW, b.rH)
  ctx.clearRect(x, y, w, h)
  ctx.strokeStyle = '#60a5fa'
  ctx.lineWidth = 2
  ctx.strokeRect(x, y, w, h)
}

function exitCropMode() {
  cropActive    = false
  cropDragStart = null
  cropCanvas.style.display = 'none'
  cropCanvas.getContext('2d').clearRect(0, 0, cropCanvas.width, cropCanvas.height)
  btnCropMode.style.display    = ''
  btnCropConfirm.style.display = 'none'
  btnCropCancel.style.display  = 'none'
}

// ─── 크롭 모드 이벤트 ─────────────────────────────────────────
btnCropMode.addEventListener('click', () => {
  cropActive    = true
  cropDragStart = null
  pendingCropRegion = null

  cropCanvas.width  = overlayContainer.offsetWidth
  cropCanvas.height = overlayContainer.offsetHeight
  cropCanvas.style.display = 'block'

  setClip(100)
  overlaySlider.value = 100

  btnCropMode.style.display    = 'none'
  btnCropConfirm.style.display = 'none'
  btnCropCancel.style.display  = ''

  // 레터박스 영역 어둡게 표시
  const b   = getImageRenderedBounds(imgImpl, overlayContainer)
  const ctx = cropCanvas.getContext('2d')
  ctx.clearRect(0, 0, cropCanvas.width, cropCanvas.height)
  ctx.fillStyle = 'rgba(0,0,0,0.4)'
  if (b.oY > 0)                      ctx.fillRect(0,         0,         cropCanvas.width, b.oY)
  if (b.oY + b.rH < cropCanvas.height) ctx.fillRect(0,       b.oY + b.rH, cropCanvas.width, cropCanvas.height - b.oY - b.rH)
  if (b.oX > 0)                      ctx.fillRect(0,         0,         b.oX,             cropCanvas.height)
  if (b.oX + b.rW < cropCanvas.width)  ctx.fillRect(b.oX + b.rW, 0,    cropCanvas.width - b.oX - b.rW, cropCanvas.height)
})

cropCanvas.addEventListener('mousedown', e => {
  const b   = getImageRenderedBounds(imgImpl, overlayContainer)
  cropDragStart     = clampToImageBounds(e.offsetX, e.offsetY, b)
  pendingCropRegion = null
  btnCropConfirm.style.display = 'none'
})

cropCanvas.addEventListener('mousemove', e => {
  if (!cropDragStart) return
  const b   = getImageRenderedBounds(imgImpl, overlayContainer)
  const cur = clampToImageBounds(e.offsetX, e.offsetY, b)
  drawCropOverlay(cropCanvas, cropDragStart, cur, b)
})

cropCanvas.addEventListener('mouseup', e => {
  if (!cropDragStart) return
  const b   = getImageRenderedBounds(imgImpl, overlayContainer)
  const end = clampToImageBounds(e.offsetX, e.offsetY, b)

  const selW = Math.abs(end.x - cropDragStart.x)
  const selH = Math.abs(end.y - cropDragStart.y)

  if (selW / b.rW < 0.05 || selH / b.rH < 0.05) {
    showStatus('더 넓은 영역을 선택해주세요', 'error')
    setTimeout(hideStatus, 2000)
    cropDragStart = null
    return
  }

  pendingCropRegion = {
    x:      Math.max(0, (Math.min(cropDragStart.x, end.x) - b.oX) / b.rW),
    y:      Math.max(0, (Math.min(cropDragStart.y, end.y) - b.oY) / b.rH),
    width:  Math.min(1, selW / b.rW),
    height: Math.min(1, selH / b.rH),
  }
  pendingCropRegion.width  = Math.min(pendingCropRegion.width,  1 - pendingCropRegion.x)
  pendingCropRegion.height = Math.min(pendingCropRegion.height, 1 - pendingCropRegion.y)

  cropDragStart = null
  btnCropConfirm.style.display = ''
})

btnCropConfirm.addEventListener('click', async () => {
  if (!pendingCropRegion || !lastScreenshotDataUrl) return
  exitCropMode()
  btnCapture.disabled = true
  try {
    await runComparison(lastScreenshotDataUrl, lastViewport, pendingCropRegion)
  } catch (err) {
    showStatus(err.message, 'error')
  } finally {
    btnCapture.disabled = false
  }
})

btnCropCancel.addEventListener('click', () => {
  exitCropMode()
  setClip(50)
  overlaySlider.value = 50
})
