const DEFAULT_SETTINGS = {
  backendUrl: 'http://127.0.0.1:5000',
  targetLanguage: 'zh',
  sourceLanguage: 'japanese',
  ocrEngine: '',
  modelProvider: '',
}

const backendSettingsCache = new Map()
const MENU_ID = 'translate-image-zh'
let ensureContextMenuPromise = null
// 防止 service worker 在长请求期间被回收
let keepAliveInterval = null

function startKeepAlive() {
  if (keepAliveInterval) return
  keepAliveInterval = setInterval(async () => {
    // 简单 storage 写操作保持 SW 活跃
    await chrome.storage.local.get('_ping')
  }, 20000)
}

function stopKeepAlive() {
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval)
    keepAliveInterval = null
  }
}

// 清理 session 中过期的旧图片 key（保留最近的 3 条）
async function cleanSessionStorage() {
  try {
    const all = await chrome.storage.session.get(null)
    const keys = Object.keys(all).filter(k => k.startsWith('img_')).sort()
    if (keys.length > 3) {
      await chrome.storage.session.remove(keys.slice(0, keys.length - 3))
    }
  } catch (_) {}
}

async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS)
  return { ...DEFAULT_SETTINGS, ...stored }
}

function readTranslationConfigFromBackendSettings(payload) {
  const settings = payload?.settings && typeof payload.settings === 'object' ? payload.settings : payload
  if (!settings || typeof settings !== 'object') return {}

  const translation =
    (settings.translation && typeof settings.translation === 'object' ? settings.translation : null) ||
    (settings.providerSettings?.translation && typeof settings.providerSettings.translation === 'object'
      ? settings.providerSettings.translation
      : null) ||
    (settings.providerConfigs?.translation && typeof settings.providerConfigs.translation === 'object'
      ? settings.providerConfigs.translation
      : null) ||
    {}

  const provider = translation.provider || translation.modelProvider || ''
  const providerConfigs = settings.providerConfigs?.translation || settings.providerSettings?.translation || {}
  const providerConfig = providerConfigs[provider] || {}

  return {
    modelProvider: provider,
    apiKey: providerConfig.apiKey || translation.apiKey || '',
    modelName: providerConfig.modelName || translation.modelName || '',
    customBaseUrl: providerConfig.customBaseUrl || providerConfig.baseUrl || translation.customBaseUrl || translation.baseUrl || '',
    targetLanguage: settings.targetLanguage || translation.targetLanguage || 'zh',
    sourceLanguage: settings.sourceLanguage || translation.sourceLanguage || 'japanese',
    ocrEngine: settings.ocrEngine || '',
  }
}

async function loadBackendTranslationDefaults(backendUrl) {
  if (!backendSettingsCache.has(backendUrl)) {
    const promise = fetch(`${backendUrl}/api/get_settings`)
      .then(async response => {
        if (!response.ok) {
          throw new Error(`读取后端设置失败: ${response.status}`)
        }
        return response.json()
      })
      .then(payload => readTranslationConfigFromBackendSettings(payload))
      .catch(() => ({}))
    backendSettingsCache.set(backendUrl, promise)
  }
  return backendSettingsCache.get(backendUrl)
}

async function fetchImageAsDataUrl(imageUrl) {
  const response = await fetch(imageUrl, { credentials: 'include' })
  if (!response.ok) {
    throw new Error(`图片下载失败: ${response.status}`)
  }
  const blob = await response.blob()
  const buffer = await blob.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunkSize = 0x8000
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize))
  }
  const base64 = btoa(binary)
  const mimeType = blob.type || 'image/png'
  return `data:${mimeType};base64,${base64}`
}

async function deliverPageMessage(tabId, message) {
  if (message.type === 'saber:image:translated') {
    // 优先 sendMessage，content script 的 message listener 会处理
    try {
      await chrome.tabs.sendMessage(tabId, {
        type: 'saber:image:translated',
        srcUrl: message.srcUrl,
        translatedImage: message.translatedImage,
      })
      return true
    } catch (_) {}
    // fallback: executeScript 直接注入图片
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        args: [message.srcUrl, message.translatedImage],
        func: (srcUrl, imgData) => {
          const images = Array.from(document.images)
          const found = images.find(i => i.currentSrc === srcUrl || i.src === srcUrl)
            || images.find(i => (i.currentSrc || i.src || '').split('?')[0] === srcUrl.split('?')[0])
            || images.find(i => { const c = (i.currentSrc || i.src || '').split('?')[0]; return c.endsWith('/' + srcUrl.split('/').pop()); })
          if (!found) return
          if (!found.dataset.saberOriginalSrc) found.dataset.saberOriginalSrc = found.src
          found.src = imgData
          found.style.outline = '2px solid rgba(60, 180, 75, 0.35)'
          found.style.outlineOffset = '2px'
        },
      })
      return true
    } catch (_) {}
    return false
  }

  if (message.type === 'saber:image:error') {
    try {
      await chrome.tabs.sendMessage(tabId, message)
      return true
    } catch (_) {}
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        args: [message.error || '未知错误'],
        func: (errorText) => {
          let toast = document.getElementById('saber-translator-toast')
          if (!toast) {
            toast = document.createElement('div')
            toast.id = 'saber-translator-toast'
            toast.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;max-width:360px;padding:10px 14px;border-radius:10px;font-size:13px;line-height:1.5;box-shadow:0 8px 28px rgba(0,0,0,0.18);color:#fff;white-space:pre-wrap;pointer-events:none;background:#dc2626'
            document.documentElement.appendChild(toast)
          }
          toast.style.background = '#dc2626'
          toast.textContent = `图片翻译失败：${errorText}`
          toast.style.opacity = '1'
          setTimeout(() => { toast.style.opacity = '0' }, 3500)
        },
      })
      return true
    } catch (_) {}
  }

  return false
}

async function translateImage(imageDataUrl) {
  const settings = await getSettings()
  let backendDefaults = {}
  try {
    backendDefaults = await loadBackendTranslationDefaults(settings.backendUrl)
  } catch (error) {
    console.warn('[Saber Translator] backend defaults unavailable, using local defaults', error)
  }
  // 优先使用扩展自身设置，留空则从后端读取
  const modelProvider = settings.modelProvider || backendDefaults.modelProvider || 'deepl'
  const modelName = settings.modelName || backendDefaults.modelName || ''
  const apiKey = settings.apiKey || backendDefaults.apiKey || ''
  const customBaseUrl = settings.customBaseUrl || backendDefaults.customBaseUrl || ''
  const targetLanguage = settings.targetLanguage || backendDefaults.targetLanguage || 'zh'
  const sourceLanguage = settings.sourceLanguage || backendDefaults.sourceLanguage || 'japanese'
  const ocrEngine = settings.ocrEngine || backendDefaults.ocrEngine || 'manga_ocr'

  if (!modelProvider) {
    throw new Error('未找到翻译服务配置，请先在 Saber Translator 里保存翻译设置')
  }
  if (modelProvider !== 'sakura' && modelProvider !== 'ollama' && modelProvider !== 'deepl' && modelProvider !== 'caiyun' && !modelName) {
    throw new Error(`当前服务商 ${modelProvider} 需要模型名称，请先在 Saber Translator 里保存翻译设置`)
  }
  if (!apiKey && ['siliconflow', 'deepseek', 'volcano', 'gemini', 'custom', 'openai', 'qwen', 'caiyun', 'baidu_translate', 'youdao_translate', 'deepl'].includes(modelProvider)) {
    throw new Error(`当前服务商 ${modelProvider} 需要 API Key，请先在 Saber Translator 里保存翻译设置`)
  }

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 120000) // 120s 超时

  const response = await fetch(`${settings.backendUrl}/api/chrome/translate-image`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      image_data: imageDataUrl,
      target_language: targetLanguage,
      source_language: sourceLanguage,
      model_provider: modelProvider,
      api_key: apiKey,
      model_name: modelName,
      custom_base_url: customBaseUrl,
      ocr_engine: ocrEngine,
    }),
    signal: controller.signal,
  })
  clearTimeout(timeoutId)

  const payload = await response.json()
  if (!response.ok || !payload.success) {
    throw new Error(payload.error || `后端错误: ${response.status}`)
  }
  return payload
}

async function ensureContextMenu() {
  if (ensureContextMenuPromise) {
    return ensureContextMenuPromise
  }
  ensureContextMenuPromise = (async () => {
    try {
      await chrome.contextMenus.removeAll()
    } catch (_) {}
    try {
      chrome.contextMenus.create({
        id: MENU_ID,
        title: '翻译图片为中文',
        contexts: ['image'],
      })
      console.info('[Saber Translator] context menu ready')
    } catch (error) {
      console.error('[Saber Translator] create context menu failed', error)
    }
  })().finally(() => {
    ensureContextMenuPromise = null
  })
  return ensureContextMenuPromise
}

chrome.runtime.onInstalled.addListener(() => {
  ensureContextMenu()
})

chrome.runtime.onStartup.addListener(() => {
  ensureContextMenu()
})

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  console.info('[Saber Translator] context menu clicked', info.menuItemId, info.srcUrl)
  if (info.menuItemId !== MENU_ID || !info.srcUrl || !tab?.id) return
  try {
    await deliverPageMessage(tab.id, { type: 'saber:image:working', srcUrl: info.srcUrl })
    const imageDataUrl = await fetchImageAsDataUrl(info.srcUrl)
    const result = await translateImage(imageDataUrl)
    await deliverPageMessage(tab.id, {
      type: 'saber:image:translated',
      srcUrl: info.srcUrl,
      translatedImage: result.translated_image,
      originalTexts: result.original_texts,
      translatedTexts: result.translated_texts,
      bubbleCount: result.bubble_count,
      warning: result.warning,
    })
  } catch (error) {
    console.error('[Saber Translator] translate image failed', error)
    await deliverPageMessage(tab.id, {
      type: 'saber:image:error',
      srcUrl: info.srcUrl,
      error: error instanceof Error ? error.message : String(error),
    })
  }
})

void ensureContextMenu()
