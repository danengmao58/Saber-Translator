const defaults = {
  backendUrl: 'http://127.0.0.1:5000',
  ocrEngine: '',
  modelProvider: '',
  sourceLanguage: '',
}

async function loadSettings() {
  const settings = await chrome.storage.sync.get(defaults)
  for (const [key, value] of Object.entries(settings)) {
    const el = document.getElementById(key)
    if (el) {
      if (el.tagName === 'SELECT') el.value = value
      else el.value = value
    }
  }
}

async function saveSettings() {
  const next = {}
  for (const key of Object.keys(defaults)) {
    const el = document.getElementById(key)
    next[key] = el ? el.value.trim() : defaults[key]
  }
  await chrome.storage.sync.set(next)
}

document.getElementById('save').addEventListener('click', async () => {
  await saveSettings()
  window.close()
})

loadSettings()
