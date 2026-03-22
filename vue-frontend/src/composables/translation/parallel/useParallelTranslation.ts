/**
 * 并行翻译 Composable
 *
 * 提供并行翻译的入口函数和状态管理
 */

import { ref, computed, shallowRef, reactive } from 'vue'
import { useImageStore } from '@/stores/imageStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { ParallelPipeline, createParallelPipeline } from './ParallelPipeline'
import type { ParallelTranslationMode, ParallelExecutionResult, ParallelProgress } from './types'

const globalProgress = reactive<ParallelProgress>({
  pools: [
    { name: '检测', icon: '📍', waiting: 0, processing: false, completed: 0, isWaitingLock: false },
    { name: 'OCR', icon: '📖', waiting: 0, processing: false, completed: 0, isWaitingLock: false },
    { name: '颜色', icon: '🎨', waiting: 0, processing: false, completed: 0, isWaitingLock: false },
    { name: '翻译', icon: '🌐', waiting: 0, processing: false, completed: 0, isWaitingLock: false },
    { name: '修复', icon: '🖌️', waiting: 0, processing: false, completed: 0, isWaitingLock: false },
    { name: '渲染', icon: '✨', waiting: 0, processing: false, completed: 0, isWaitingLock: false }
  ],
  totalCompleted: 0,
  totalFailed: 0,
  totalPages: 0,
  estimatedTimeRemaining: 0,
  preSave: undefined,
  save: undefined
})

const globalIsRunning = ref(false)

export function useParallelTranslation() {
  const imageStore = useImageStore()
  const settingsStore = useSettingsStore()

  const pipeline = shallowRef<ParallelPipeline | null>(null)
  const config = computed(() => settingsStore.settings.parallel)
  const isEnabled = computed(() => config.value?.enabled ?? false)
  const isRunning = globalIsRunning
  const progress = computed<ParallelProgress>(() => globalProgress)

  function determineMode(): ParallelTranslationMode {
    const settings = settingsStore.settings
    if (settings.proofreading?.enabled && settings.proofreading.rounds.length > 0) {
      return 'proofread'
    }

    const hqProviders = ['gemini', 'openai', 'claude', 'deepseek']
    if (hqProviders.includes(settings.hqTranslation?.provider || '') && settings.hqTranslation?.apiKey) {
      return 'hq'
    }

    return 'standard'
  }

  function syncProgress(): void {
    if (!pipeline.value) return
    const pipelineProgress = pipeline.value.progress
    if (!pipelineProgress) return

    globalProgress.pools = pipelineProgress.pools.map(p => ({ ...p }))
    globalProgress.totalCompleted = pipelineProgress.totalCompleted
    globalProgress.totalFailed = pipelineProgress.totalFailed
    globalProgress.totalPages = pipelineProgress.totalPages
    globalProgress.estimatedTimeRemaining = pipelineProgress.estimatedTimeRemaining
  }

  async function executeParallel(
    mode?: ParallelTranslationMode,
    imagesToProcess?: typeof imageStore.images,
    startIndex: number = 0
  ): Promise<ParallelExecutionResult> {
    if (isRunning.value) {
      return { success: 0, failed: 0, cancelled: 0, errors: ['翻译正在进行中'] }
    }

    const images = imagesToProcess ?? imageStore.images
    if (images.length === 0) {
      return { success: 0, failed: 0, cancelled: 0, errors: ['没有图片'] }
    }

    isRunning.value = true
    globalProgress.totalPages = images.length
    globalProgress.totalCompleted = 0
    globalProgress.totalFailed = 0

    const syncInterval = setInterval(syncProgress, 200)

    try {
      pipeline.value = createParallelPipeline({
        enabled: true,
        deepLearningLockSize: config.value?.deepLearningLockSize ?? 1
      })

      const translationMode = mode ?? determineMode()
      const result = await pipeline.value.execute(images, translationMode, startIndex)
      syncProgress()
      return result
    } catch (error) {
      console.error('并行翻译出错:', error)
      return {
        success: 0,
        failed: images.length,
        cancelled: 0,
        errors: [(error as Error).message]
      }
    } finally {
      clearInterval(syncInterval)
      isRunning.value = false
    }
  }

  function cancel(): void {
    pipeline.value?.cancel()
    isRunning.value = false
  }

  function reset(): void {
    pipeline.value = null
    isRunning.value = false
  }

  return {
    isEnabled,
    isRunning,
    progress,
    executeParallel,
    cancel,
    reset,
    determineMode
  }
}
