import { computed } from 'vue'
import { useImageStore } from '@/stores/imageStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useToast } from '@/utils/toast'
import { useSequentialPipeline } from './SequentialPipeline'
import { useParallelTranslation } from '../parallel'
import {
  shouldEnableAutoSave,
  preSaveOriginalImages,
  finalizeSave,
  resetSaveState
} from './saveStep'
import {
  beginTranslationCancellationScope,
  cancelTranslationRequests,
  resetTranslationCancellationScope
} from './cancellation'
import type { PipelineConfig, PipelineResult } from './types'
import type { ParallelTranslationMode } from '../parallel/types'

export function usePipeline() {
  const imageStore = useImageStore()
  const settingsStore = useSettingsStore()
  const toast = useToast()

  const sequentialPipeline = useSequentialPipeline()
  const parallelTranslation = useParallelTranslation()

  const isTranslating = computed(() =>
    sequentialPipeline.isTranslating.value || imageStore.isBatchTranslationInProgress
  )
  const progressPercent = computed(() => sequentialPipeline.progressPercent.value)

  async function execute(config: PipelineConfig): Promise<PipelineResult> {
    if (imageStore.images.length === 0) {
      toast.error('请先上传图片')
      return { success: false, completed: 0, failed: 0, cancelled: 0, errors: ['没有图片'] }
    }

    beginTranslationCancellationScope()

    const isBatchScope = config.scope === 'all' || config.scope === 'range'
    const shouldUseParallel = settingsStore.settings.parallel?.enabled && isBatchScope

    const total =
      config.scope === 'range' && config.pageRange
        ? Math.max(0, config.pageRange.endPage - config.pageRange.startPage + 1)
        : imageStore.images.length

    if (isBatchScope || config.scope === 'failed') {
      imageStore.startBatchTranslation(config.mode, total)
    }

    try {
      return shouldUseParallel
        ? await executeParallelMode(config)
        : await sequentialPipeline.execute(config)
    } finally {
      resetTranslationCancellationScope()
    }
  }

  async function executeParallelMode(config: PipelineConfig): Promise<PipelineResult> {
    let imagesToProcess = imageStore.images
    let startIndex = 0

    if (config.scope === 'range' && config.pageRange) {
      startIndex = Math.max(0, config.pageRange.startPage - 1)
      const endIndex = Math.min(imageStore.images.length - 1, config.pageRange.endPage - 1)
      if (startIndex <= endIndex && startIndex < imageStore.images.length) {
        imagesToProcess = imageStore.images.slice(startIndex, endIndex + 1)
      } else {
        toast.error('无效的页面范围')
        return { success: false, completed: 0, failed: 0, cancelled: 0, errors: ['无效的页面范围'] }
      }
    }

    if (imagesToProcess.length > 1) {
      const { textStyle } = settingsStore.settings
      for (let i = 0; i < imagesToProcess.length; i++) {
        const imageIndex = startIndex + i
        imageStore.updateImageByIndex(imageIndex, {
          fontSize: textStyle.fontSize,
          autoFontSize: textStyle.autoFontSize,
          fontFamily: textStyle.fontFamily,
          layoutDirection: textStyle.layoutDirection,
          textColor: textStyle.textColor,
          fillColor: textStyle.fillColor,
          strokeEnabled: textStyle.strokeEnabled,
          strokeColor: textStyle.strokeColor,
          strokeWidth: textStyle.strokeWidth,
          inpaintMethod: textStyle.inpaintMethod,
          useAutoTextColor: textStyle.useAutoTextColor
        })
      }
    }

    const enableAutoSave = shouldEnableAutoSave()

    try {
      parallelTranslation.progress.value.totalPages = imagesToProcess.length
      parallelTranslation.progress.value.totalCompleted = 0
      parallelTranslation.progress.value.totalFailed = 0

      if (enableAutoSave) {
        const preSaveSuccess = await preSaveOriginalImages({
          onStart: (total) => {
            parallelTranslation.progress.value.preSave = { isRunning: true, current: 0, total }
          },
          onProgress: (current, total) => {
            if (parallelTranslation.progress.value.preSave) {
              parallelTranslation.progress.value.preSave.current = current
              parallelTranslation.progress.value.preSave.total = total
            }
          },
          onComplete: () => {
            if (parallelTranslation.progress.value.preSave) {
              parallelTranslation.progress.value.preSave.isRunning = false
            }
          },
          onError: () => {
            parallelTranslation.progress.value.preSave = undefined
          }
        })

        if (!preSaveSuccess) {
          parallelTranslation.progress.value.preSave = undefined
        }
      }

      if (enableAutoSave) {
        parallelTranslation.progress.value.save = {
          completed: 0,
          total: imagesToProcess.length
        }
      }

      const result = await parallelTranslation.executeParallel(
        config.mode as ParallelTranslationMode,
        imagesToProcess,
        startIndex
      )

      const status = result.wasCancelled
        ? 'cancelled'
        : result.failed > 0
          ? 'failed'
          : 'completed'
      imageStore.finishBatchTranslation({
        status,
        completed: result.success,
        failed: result.failed,
        cancelled: result.cancelled,
        total: imagesToProcess.length
      })

      if (result.wasCancelled) {
        toast.warning(`翻译已取消，已完成 ${result.success} 张，失败 ${result.failed} 张，取消 ${result.cancelled} 张`)
      } else if (result.success > 0 && result.failed === 0) {
        toast.success(`批量处理完成，共 ${result.success} 张`)
      } else if (result.success > 0 || result.failed > 0) {
        toast.warning(`批量处理完成，成功 ${result.success} 张，失败 ${result.failed} 张`)
      } else {
        toast.error('批量处理失败')
      }

      return {
        success: result.failed === 0 && !result.wasCancelled,
        completed: result.success,
        failed: result.failed,
        cancelled: result.cancelled,
        wasCancelled: result.wasCancelled,
        errors: result.errors
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '并行翻译出错'
      imageStore.finishBatchTranslation({
        status: 'failed',
        completed: 0,
        failed: imagesToProcess.length,
        cancelled: 0,
        total: imagesToProcess.length
      })
      toast.error(errorMessage)
      return {
        success: false,
        completed: 0,
        failed: imagesToProcess.length,
        cancelled: 0,
        errors: [errorMessage]
      }
    } finally {
      parallelTranslation.progress.value.preSave = undefined
      parallelTranslation.progress.value.save = undefined
      if (enableAutoSave) {
        await finalizeSave()
      }
    }
  }

  function cancel(): void {
    imageStore.markBatchTranslationCancelling()
    cancelTranslationRequests()
    sequentialPipeline.cancel()
    parallelTranslation.cancel()
    resetSaveState()
  }

  return {
    progress: sequentialPipeline.progress,
    isExecuting: sequentialPipeline.isExecuting,
    isTranslating,
    progressPercent,
    execute,
    cancel,
    STEP_CHAIN_CONFIGS: sequentialPipeline.STEP_CHAIN_CONFIGS
  }
}

export type { PipelineConfig, PipelineResult }
