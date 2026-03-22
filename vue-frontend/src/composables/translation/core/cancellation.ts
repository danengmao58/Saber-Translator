import axios from 'axios'

export class TranslationCancelledError extends Error {
  constructor(message = '翻译已取消') {
    super(message)
    this.name = 'TranslationCancelledError'
  }
}

let currentAbortController: AbortController | null = null

export function beginTranslationCancellationScope(): AbortSignal {
  currentAbortController?.abort()
  currentAbortController = new AbortController()
  return currentAbortController.signal
}

export function getTranslationAbortSignal(): AbortSignal | undefined {
  return currentAbortController?.signal
}

export function cancelTranslationRequests(reason = '翻译已取消'): void {
  currentAbortController?.abort(reason)
}

export function resetTranslationCancellationScope(): void {
  currentAbortController = null
}

export function throwIfTranslationCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new TranslationCancelledError(typeof signal.reason === 'string' ? signal.reason : '翻译已取消')
  }
}

export function isTranslationCancellationError(error: unknown): boolean {
  return error instanceof TranslationCancelledError || axios.isCancel(error)
}
