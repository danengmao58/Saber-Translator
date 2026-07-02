const pendingMarkers = new Map()
let toastTimer = null

function findImageBySrc(srcUrl) {
  const images = Array.from(document.images)
  const directMatch = images.find(image => image.currentSrc === srcUrl || image.src === srcUrl)
  if (directMatch) return directMatch

  const sourceMatch = Array.from(document.querySelectorAll('picture img')).find(
    image => image.currentSrc === srcUrl || image.src === srcUrl,
  )
  if (sourceMatch) return sourceMatch

  // 按不带查询参数的 URL 匹配
  const srcPath = srcUrl.split('?')[0].split('#')[0]
  const pathMatch = images.find(image => {
    const candidate = (image.currentSrc || image.src || '').split('?')[0].split('#')[0]
    return candidate === srcPath
  })
  if (pathMatch) return pathMatch

  // 最后按文件名匹配（对 CDN 图片有效，它们的文件名可能一样但域名不同）
  const srcName = srcPath.split('/').pop()
  if (srcName) {
    return images.find(image => {
      const c = (image.currentSrc || image.src || '').split('?')[0].split('#')[0]
      return c.endsWith('/' + srcName) || c === srcName
    })
  }

  return null
}

function preloadImage(src) {
  return new Promise((resolve, reject) => {
    const preloader = new Image()
    preloader.onload = () => resolve(preloader)
    preloader.onerror = () => reject(new Error('译图加载失败'))
    preloader.src = src
  })
}

async function applyTranslatedImage(srcUrl, translatedImage) {
  const image = findImageBySrc(srcUrl)
  if (!image) return false
  if (!image.dataset.saberOriginalSrc) {
    image.dataset.saberOriginalSrc = image.src
  }
  await preloadImage(translatedImage)
  image.srcset = ''
  image.sizes = ''
  image.src = translatedImage
  image.style.outline = '2px solid rgba(60, 180, 75, 0.35)'
  image.style.outlineOffset = '2px'
  return true
}

function showToast(message, kind = 'info') {
  let toast = document.getElementById('saber-translator-toast')
  if (!toast) {
    toast = document.createElement('div')
    toast.id = 'saber-translator-toast'
    toast.style.position = 'fixed'
    toast.style.right = '16px'
    toast.style.bottom = '16px'
    toast.style.zIndex = '2147483647'
    toast.style.maxWidth = '360px'
    toast.style.padding = '10px 14px'
    toast.style.borderRadius = '10px'
    toast.style.fontSize = '13px'
    toast.style.lineHeight = '1.5'
    toast.style.boxShadow = '0 8px 28px rgba(0, 0, 0, 0.18)'
    toast.style.color = '#fff'
    toast.style.whiteSpace = 'pre-wrap'
    toast.style.pointerEvents = 'none'
    document.documentElement.appendChild(toast)
  }

  const palette = {
    info: '#2563eb',
    success: '#16a34a',
    warning: '#d97706',
    error: '#dc2626',
  }

  toast.style.background = palette[kind] || palette.info
  toast.textContent = message
  toast.style.opacity = '1'
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    toast.style.opacity = '0'
  }, 3500)
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'saber:image:working') {
    pendingMarkers.set(message.srcUrl, true)
    return
  }
  if (message.type === 'saber:image:translated') {
    pendingMarkers.delete(message.srcUrl)
    applyTranslatedImage(message.srcUrl, message.translatedImage)
      .then(applied => {
        const prefix = message.warning === 'rendered_blank_fallback_original' ? '已翻译，但渲染为空，已回退原图' : '图片翻译完成'
        showToast(applied ? prefix : '图片翻译完成，但未找到对应图片', message.warning ? 'warning' : 'success')
      })
      .catch(error => {
        console.warn('[Saber Translator]', error)
        showToast(`图片翻译成功，但回填失败：${error.message}`, 'error')
      })
    return
  }
  if (message.type === 'saber:image:error') {
    pendingMarkers.delete(message.srcUrl)
    console.warn('[Saber Translator]', message.error)
    showToast(`图片翻译失败：${message.error}`, 'error')
  }
})
