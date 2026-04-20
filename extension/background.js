// background.js - Service Worker

chrome.runtime.onInstalled.addListener(() => {
  // 아이콘 클릭 시 사이드 패널 열도록 설정
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
  console.log('[Visual QA] Extension installed')
})

// 탭 변경 시에도 사이드 패널 유지
chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.sidePanel.setOptions({
    tabId,
    path: 'popup/index.html',
    enabled: true,
  })
})

// 메시지 핸들러 (추후 단축키 등 확장용)
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'CAPTURE_REQUEST') {
    chrome.tabs.captureVisibleTab(null, { format: 'png', quality: 100 }, (dataUrl) => {
      sendResponse({ dataUrl })
    })
    return true
  }
})
