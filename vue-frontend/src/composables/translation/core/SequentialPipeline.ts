/**
 * 顺序翻译管线 - 原子步骤版本
 * 
 * 设计理念：与并行管线完全一致的原子步骤
 * 
 * 7个原子步骤：
 * 1. detection - 气泡检测
 * 2. ocr - 文字识别
 * 3. color - 颜色提取
 * 4. translate - 普通翻译
 * 5. aiTranslate - AI翻译（高质量翻译和校对共用）
 * 6. inpaint - 背景修复
 * 7. render - 渲染译文
 */

import { ref, computed } from 'vue'
import { useImageStore } from '@/stores/imageStore'
import { useBubbleStore } from '@/stores/bubbleStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useValidation } from '../../useValidation'
import { useToast } from '@/utils/toast'
import { createRateLimiter, type RateLimiter } from '@/utils/rateLimiter'
import { createProgressManager } from './progressManager'
import type {
    PipelineConfig,
    PipelineResult,
    SavedTextStyles,
    TranslationMode
} from './types'
import type { ImageData as AppImageData } from '@/types/image'
import type { BubbleState, BubbleCoords } from '@/types/bubble'

// 原子步骤模块
import {
    executeDetection,
    executeOcr,
    executeColor,
    executeTranslate,
    executeAiTranslate,
    executeInpaint,
    executeRender
} from './steps'

// 自动保存模块
import {
    shouldEnableAutoSave,
    preSaveOriginalImages,
    saveTranslatedImage,
    finalizeSave,
    resetSaveState
} from './saveStep'
import { isTranslationCancellationError } from './cancellation'

// ============================================================
// 原子步骤类型
// ============================================================

export type AtomicStepType =
    | 'detection'     // 气泡检测
    | 'ocr'           // 文字识别
    | 'color'         // 颜色提取
    | 'translate'     // 普通翻译
    | 'aiTranslate'   // AI翻译（高质量翻译 & 校对共用）
    | 'inpaint'       // 背景修复
    | 'render'        // 渲染
    | 'save'          // 自动保存（书架模式）

/**
 * 步骤链配置
 */
export const STEP_CHAIN_CONFIGS: Record<TranslationMode, AtomicStepType[]> = {
    standard: ['detection', 'ocr', 'color', 'translate', 'inpaint', 'render'],
    hq: ['detection', 'ocr', 'color', 'aiTranslate', 'inpaint', 'render'],
    proofread: ['aiTranslate', 'render'],
    removeText: ['detection', 'inpaint', 'render']
}

/** 步骤显示名称 */
const STEP_LABELS: Record<AtomicStepType, string> = {
    detection: '气泡检测',
    ocr: '文字识别',
    color: '颜色提取',
    translate: '翻译',
    aiTranslate: 'AI翻译',
    inpaint: '背景修复',
    render: '渲染',
    save: '保存'
}

// ============================================================
// 任务状态
// ============================================================

interface TaskState {
    imageIndex: number
    image: AppImageData

    // 检测结果
    bubbleCoords: BubbleCoords[]
    bubbleAngles: number[]
    bubblePolygons: number[][][]
    autoDirections: string[]
    textMask?: string
    textlinesPerBubble: any[]

    // OCR结果
    originalTexts: string[]

    // 颜色结果
    colors: Array<{
        textColor: string
        bgColor: string
        autoFgColor?: [number, number, number] | null
        autoBgColor?: [number, number, number] | null
    }>

    // 翻译结果
    translatedTexts: string[]
    textboxTexts: string[]

    // 修复结果
    cleanImage?: string

    // 渲染结果
    finalImage?: string
    bubbleStates?: BubbleState[]
}

// ============================================================
// 顺序管线 Composable
// ============================================================

export function useSequentialPipeline() {
    const imageStore = useImageStore()
    const bubbleStore = useBubbleStore()
    const settingsStore = useSettingsStore()
    const validation = useValidation()
    const toast = useToast()

    const { progress, reporter } = createProgressManager()
    const isExecuting = ref(false)
    const rateLimiter = ref<RateLimiter | null>(null)
    let savedTextStyles: SavedTextStyles | null = null
    let currentMode: TranslationMode = 'standard'

    const isTranslating = computed(() => isExecuting.value || imageStore.isBatchTranslationInProgress)
    const progressPercent = computed(() => progress.value.percentage || 0)

    // ============================================================
    // 工具函数
    // ============================================================

    function initRateLimiter(): void {
        const rpm = settingsStore.settings.translation.rpmLimit
        if (!rateLimiter.value) {
            rateLimiter.value = createRateLimiter(rpm)
        } else {
            rateLimiter.value.setRpm(rpm)
        }
    }

    function validateConfig(config: PipelineConfig): boolean {
        const validationType = config.mode === 'hq' ? 'hq'
            : config.mode === 'proofread' ? 'proofread'
                : config.mode === 'removeText' ? 'ocr'
                    : 'normal'
        return validation.validateBeforeTranslation(validationType)
    }

    function saveCurrentStyles(): void {
        const { textStyle } = settingsStore.settings
        const layoutDirectionValue = textStyle.layoutDirection
        savedTextStyles = {
            fontFamily: textStyle.fontFamily,
            fontSize: textStyle.fontSize,
            autoFontSize: textStyle.autoFontSize,
            autoTextDirection: layoutDirectionValue === 'auto',
            textDirection: layoutDirectionValue === 'auto' ? 'vertical' : layoutDirectionValue,
            layoutDirection: layoutDirectionValue,  // 保存用户原始选择（包括 'auto'）
            fillColor: textStyle.fillColor,
            textColor: textStyle.textColor,
            rotationAngle: 0,
            strokeEnabled: textStyle.strokeEnabled,
            strokeColor: textStyle.strokeColor,
            strokeWidth: textStyle.strokeWidth,
            useAutoTextColor: textStyle.useAutoTextColor,
            inpaintMethod: textStyle.inpaintMethod
        }
    }

    function getImagesToProcess(config: PipelineConfig): { image: AppImageData; index: number }[] {
        const images = imageStore.images
        if (config.scope === 'current') {
            const currentImage = imageStore.currentImage
            return currentImage ? [{ image: currentImage, index: imageStore.currentImageIndex }] : []
        }
        if (config.scope === 'failed') {
            return imageStore.getFailedImageIndices()
                .map(index => ({ image: images[index]!, index }))
                .filter(item => item.image !== undefined)
        }
        if (config.scope === 'range' && config.pageRange) {
            // 页码从1开始，转换为0索引
            const startIndex = Math.max(0, config.pageRange.startPage - 1)
            const endIndex = Math.min(images.length - 1, config.pageRange.endPage - 1)

            if (startIndex > endIndex || startIndex >= images.length) {
                return []
            }

            return images
                .slice(startIndex, endIndex + 1)
                .map((image, idx) => ({ image, index: startIndex + idx }))
        }
        return images.map((image, index) => ({ image, index }))
    }

    // ============================================================
    // 原子步骤执行器
    // ============================================================

    async function stepDetection(task: TaskState): Promise<void> {
        const result = await executeDetection({
            imageIndex: task.imageIndex,
            image: task.image,
            forceDetect: false
        })

        task.bubbleCoords = result.bubbleCoords
        task.bubbleAngles = result.bubbleAngles
        task.bubblePolygons = result.bubblePolygons
        task.autoDirections = result.autoDirections
        task.textMask = result.textMask
        task.textlinesPerBubble = result.textlinesPerBubble
        if (result.originalTexts) {
            task.originalTexts = result.originalTexts
        }
    }

    async function stepOcr(task: TaskState): Promise<void> {
        const result = await executeOcr({
            imageIndex: task.imageIndex,
            image: task.image,
            bubbleCoords: task.bubbleCoords,
            textlinesPerBubble: task.textlinesPerBubble
        })

        task.originalTexts = result.originalTexts
    }

    async function stepColor(task: TaskState): Promise<void> {
        const result = await executeColor({
            imageIndex: task.imageIndex,
            image: task.image,
            bubbleCoords: task.bubbleCoords,
            textlinesPerBubble: task.textlinesPerBubble
        })

        task.colors = result.colors
    }

    async function stepTranslate(task: TaskState): Promise<void> {
        const result = await executeTranslate({
            imageIndex: task.imageIndex,
            originalTexts: task.originalTexts,
            rateLimiter: rateLimiter.value
        })

        task.translatedTexts = result.translatedTexts
        task.textboxTexts = result.textboxTexts
    }

    /**
     * AI翻译步骤（高质量翻译 & 校对共用）
     * 使用独立的步骤模块
     */
    async function stepAiTranslate(tasks: TaskState[]): Promise<void> {
        const mode = currentMode === 'proofread' ? 'proofread' : 'hq'

        const result = await executeAiTranslate({
            mode,
            tasks: tasks.map(t => ({
                imageIndex: t.imageIndex,
                image: t.image,
                originalTexts: t.originalTexts,
                autoDirections: t.autoDirections
            }))
        })

        // 填充结果到tasks
        for (const t of tasks) {
            const taskResult = result.results.find(r => r.imageIndex === t.imageIndex)
            if (taskResult) {
                t.translatedTexts = taskResult.translatedTexts
                t.textboxTexts = taskResult.textboxTexts
            } else {
                t.translatedTexts = []
                t.textboxTexts = []
            }
        }
    }

    async function stepInpaint(task: TaskState): Promise<void> {
        const result = await executeInpaint({
            imageIndex: task.imageIndex,
            image: task.image,
            bubbleCoords: task.bubbleCoords,
            bubblePolygons: task.bubblePolygons,
            textMask: task.textMask,
            userMask: task.image.userMask || undefined  // ✅ 传递用户掩膜
        })

        task.cleanImage = result.cleanImage
    }

    async function stepRender(task: TaskState): Promise<void> {
        const result = await executeRender({
            imageIndex: task.imageIndex,
            cleanImage: task.cleanImage!,
            bubbleCoords: task.bubbleCoords,
            bubbleAngles: task.bubbleAngles,
            autoDirections: task.autoDirections,
            originalTexts: task.originalTexts,
            translatedTexts: task.translatedTexts,
            textboxTexts: task.textboxTexts,
            colors: task.colors,
            savedTextStyles,
            currentMode
        })

        task.finalImage = result.finalImage
        task.bubbleStates = result.bubbleStates
    }

    // ============================================================
    // 辅助函数
    // ============================================================
    // 步骤调度器
    // ============================================================


    /**
     * 执行单个步骤（通用调度函数）
     * 根据步骤名称调用对应的step函数
     */
    async function executeStep(step: AtomicStepType, task: TaskState): Promise<void> {
        switch (step) {
            case 'detection':
                await stepDetection(task)
                break
            case 'ocr':
                await stepOcr(task)
                break
            case 'color':
                await stepColor(task)
                break
            case 'translate':
                await stepTranslate(task)
                break
            case 'inpaint':
                await stepInpaint(task)
                break
            case 'render':
                await stepRender(task)
                break
            case 'save':
                await saveTranslatedImage(task.imageIndex)
                break
            case 'aiTranslate':
                throw new Error('aiTranslate should be handled in batch mode')
        }
    }

    function updateImageStore(task: TaskState): void {
        const translatedDataURL = task.finalImage
            ? `data:image/png;base64,${task.finalImage}`
            : task.cleanImage
                ? `data:image/png;base64,${task.cleanImage}`
                : null

        const { textStyle } = settingsStore.settings

        imageStore.updateImageByIndex(task.imageIndex, {
            translatedDataURL,
            cleanImageData: task.cleanImage || null,
            bubbleStates: task.bubbleStates,
            bubbleCoords: task.bubbleCoords,
            bubbleAngles: task.bubbleAngles,
            originalTexts: task.originalTexts,
            textboxTexts: task.textboxTexts,
            bubbleTexts: task.translatedTexts,
            textMask: task.textMask || null,  // 保存精确文字掩膜
            userMask: task.image.userMask || null,  // 【重要】保留用户笔刷掩膜
            translationStatus: 'completed',
            translationFailed: false,
            showOriginal: false,
            hasUnsavedChanges: true,
            // 保存用户翻译时选择的设置（用于切换图片时恢复）
            // 【修复】保存完整的文字设置，避免切换图片后侧边栏显示默认值
            fontSize: savedTextStyles?.fontSize ?? textStyle.fontSize,
            autoFontSize: savedTextStyles?.autoFontSize ?? textStyle.autoFontSize,
            fontFamily: savedTextStyles?.fontFamily ?? textStyle.fontFamily,
            layoutDirection: savedTextStyles?.layoutDirection ?? textStyle.layoutDirection,
            textColor: savedTextStyles?.textColor ?? textStyle.textColor,
            fillColor: savedTextStyles?.fillColor ?? textStyle.fillColor,
            strokeEnabled: savedTextStyles?.strokeEnabled ?? textStyle.strokeEnabled,
            strokeColor: savedTextStyles?.strokeColor ?? textStyle.strokeColor,
            strokeWidth: savedTextStyles?.strokeWidth ?? textStyle.strokeWidth,
            inpaintMethod: savedTextStyles?.inpaintMethod ?? textStyle.inpaintMethod,
            useAutoTextColor: savedTextStyles?.useAutoTextColor ?? textStyle.useAutoTextColor
        })

        if (task.imageIndex === imageStore.currentImageIndex && task.bubbleStates) {
            bubbleStore.setBubbles(task.bubbleStates)
        }
    }

    // ============================================================
    // 主执行函数
    // ============================================================

    /**
     * 判断是否使用逐张处理模式
     * - standard / removeText: 逐张处理（每张图完成全部步骤后再处理下一张）
     * - hq / proofread: 按批次处理（批次内保持按步骤批量处理）
     */
    function shouldUsePerImageMode(mode: TranslationMode): boolean {
        return mode === 'standard' || mode === 'removeText'
    }

    /**
     * 获取批次大小配置
     * 仅在 executeBatchMode 中调用，用于 hq 和 proofread 模式
     */
    function getBatchSize(mode: TranslationMode): number {
        const settings = settingsStore.settings
        if (mode === 'hq') {
            return settings.hqTranslation.batchSize || 5
        }
        if (mode === 'proofread') {
            // 使用第一轮校对的批次大小，如果没有则使用默认值
            return settings.proofreading.rounds[0]?.batchSize || 5
        }
        // 防御性代码：standard 和 removeText 模式不应调用此函数
        return 1
    }

    /**
     * 逐张处理模式（标准翻译/消除文字）
     * 每张图片走完全部步骤后再处理下一张
     */
    async function executePerImageMode(
        tasks: TaskState[],
        stepChain: AtomicStepType[],
        config: PipelineConfig,
        errors: string[]
    ): Promise<{ completed: number; failed: number; cancelled: number }> {
        let completed = 0
        let failed = 0
        let cancelled = 0

        for (let imageIdx = 0; imageIdx < tasks.length; imageIdx++) {
            const task = tasks[imageIdx]!

            if ((config.scope === 'all' || config.scope === 'range' || config.scope === 'failed') && !imageStore.isBatchTranslationInProgress) {
                cancelled += tasks.length - imageIdx
                for (let i = imageIdx; i < tasks.length; i++) {
                    imageStore.setTranslationStatus(tasks[i]!.imageIndex, 'cancelled', '翻译已取消')
                }
                break
            }

            const imageProgress = Math.floor((imageIdx / tasks.length) * 90)
            reporter.setPercentage(imageProgress, `处理图片 ${imageIdx + 1}/${tasks.length}`)
            imageStore.setTranslationStatus(task.imageIndex, 'processing')

            let taskFailed = false
            for (let stepIdx = 0; stepIdx < stepChain.length; stepIdx++) {
                const step = stepChain[stepIdx]!
                if (taskFailed) break

                if (rateLimiter.value) {
                    await rateLimiter.value.acquire()
                }

                try {
                    const stepProgress = imageProgress + Math.floor((stepIdx / stepChain.length) * (90 / tasks.length))
                    reporter.setPercentage(stepProgress, `图片 ${imageIdx + 1}: ${STEP_LABELS[step]}`)
                    await executeStep(step, task)
                } catch (err) {
                    if (isTranslationCancellationError(err)) {
                        imageStore.setTranslationStatus(task.imageIndex, 'cancelled', '翻译已取消')
                        cancelled++
                        throw err
                    }

                    const msg = err instanceof Error ? err.message : '未知错误'
                    errors.push(`图片 ${task.imageIndex + 1}: ${step} - ${msg}`)
                    imageStore.setTranslationStatus(task.imageIndex, 'failed', msg)
                    taskFailed = true
                    failed++
                }
            }

            if (!taskFailed) {
                updateImageStore(task)
                completed++
            }
        }

        return { completed, failed, cancelled }
    }

    /**
     * 批次处理模式（高质量翻译/AI校对）
     * 
     * 处理流程：
     * 1. 对每张图片逐张执行 aiTranslate 之前的步骤
     * 2. 批量发送 aiTranslate（利用 AI 的多图上下文能力）
     * 3. 对每张图片逐张执行 aiTranslate 之后的步骤
     * 
     * 这样设计的好处：
     * - 除 aiTranslate 外，其他步骤都是逐张处理，代码简单
     * - 未来添加新步骤更容易
     * - aiTranslate 仍然保持批量发送，利用 AI 的上下文理解能力
     */
    async function executeBatchMode(
        tasks: TaskState[],
        stepChain: AtomicStepType[],
        config: PipelineConfig,
        errors: string[]
    ): Promise<{ completed: number; failed: number; cancelled: number }> {
        let completed = 0
        let failed = 0
        let cancelled = 0

        const batchSize = getBatchSize(config.mode)
        const totalBatches = Math.ceil(tasks.length / batchSize)
        const aiTranslateIdx = stepChain.indexOf('aiTranslate')
        const stepsBeforeAi = aiTranslateIdx >= 0 ? stepChain.slice(0, aiTranslateIdx) : stepChain
        const stepsAfterAi = aiTranslateIdx >= 0 ? stepChain.slice(aiTranslateIdx + 1) : []

        for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
            const batchStart = batchIdx * batchSize
            if ((config.scope === 'all' || config.scope === 'range' || config.scope === 'failed') && !imageStore.isBatchTranslationInProgress) {
                cancelled += tasks.length - batchStart
                for (let i = batchStart; i < tasks.length; i++) {
                    imageStore.setTranslationStatus(tasks[i]!.imageIndex, 'cancelled', '翻译已取消')
                }
                break
            }

            const batchEnd = Math.min(batchStart + batchSize, tasks.length)
            const batchTasks = tasks.slice(batchStart, batchEnd)
            const batchProgress = Math.floor((batchIdx / totalBatches) * 90)
            reporter.setPercentage(batchProgress, `处理批次 ${batchIdx + 1}/${totalBatches}`)

            for (const task of batchTasks) {
                imageStore.setTranslationStatus(task.imageIndex, 'processing')
            }

            const batchFailedIndices = new Set<number>()

            for (let i = 0; i < batchTasks.length; i++) {
                const task = batchTasks[i]!
                for (const step of stepsBeforeAi) {
                    if (batchFailedIndices.has(task.imageIndex)) break
                    if (rateLimiter.value) {
                        await rateLimiter.value.acquire()
                    }

                    try {
                        const stepProgress = batchProgress + Math.floor((i / batchTasks.length) * 30)
                        reporter.setPercentage(stepProgress, `图片 ${batchStart + i + 1}: ${STEP_LABELS[step]}`)
                        await executeStep(step, task)
                    } catch (err) {
                        if (isTranslationCancellationError(err)) {
                            imageStore.setTranslationStatus(task.imageIndex, 'cancelled', '翻译已取消')
                            batchFailedIndices.add(task.imageIndex)
                            cancelled++
                            throw err
                        }

                        const msg = err instanceof Error ? err.message : '未知错误'
                        errors.push(`图片 ${task.imageIndex + 1}: ${step} - ${msg}`)
                        imageStore.setTranslationStatus(task.imageIndex, 'failed', msg)
                        batchFailedIndices.add(task.imageIndex)
                    }
                }
            }

            if (aiTranslateIdx >= 0) {
                try {
                    const validTasks = batchTasks.filter(t => !batchFailedIndices.has(t.imageIndex))
                    if (validTasks.length > 0) {
                        reporter.setPercentage(batchProgress + 40, `批次 ${batchIdx + 1}: ${STEP_LABELS.aiTranslate}`)
                        await stepAiTranslate(validTasks)
                    }
                } catch (err) {
                    if (isTranslationCancellationError(err)) {
                        for (const task of batchTasks) {
                            if (!batchFailedIndices.has(task.imageIndex)) {
                                imageStore.setTranslationStatus(task.imageIndex, 'cancelled', '翻译已取消')
                                batchFailedIndices.add(task.imageIndex)
                                cancelled++
                            }
                        }
                        throw err
                    }

                    const msg = err instanceof Error ? err.message : '未知错误'
                    errors.push(`批次 ${batchIdx + 1} AI翻译失败: ${msg}`)
                    for (const task of batchTasks) {
                        if (!batchFailedIndices.has(task.imageIndex)) {
                            imageStore.setTranslationStatus(task.imageIndex, 'failed', msg)
                            batchFailedIndices.add(task.imageIndex)
                        }
                    }
                }
            }

            for (let i = 0; i < batchTasks.length; i++) {
                const task = batchTasks[i]!
                if (batchFailedIndices.has(task.imageIndex)) continue

                for (const step of stepsAfterAi) {
                    if (batchFailedIndices.has(task.imageIndex)) break
                    if (rateLimiter.value) {
                        await rateLimiter.value.acquire()
                    }

                    try {
                        const stepProgress = batchProgress + 50 + Math.floor((i / batchTasks.length) * 40)
                        reporter.setPercentage(stepProgress, `图片 ${batchStart + i + 1}: ${STEP_LABELS[step]}`)
                        await executeStep(step, task)
                    } catch (err) {
                        if (isTranslationCancellationError(err)) {
                            imageStore.setTranslationStatus(task.imageIndex, 'cancelled', '翻译已取消')
                            batchFailedIndices.add(task.imageIndex)
                            cancelled++
                            throw err
                        }

                        const msg = err instanceof Error ? err.message : '未知错误'
                        errors.push(`图片 ${task.imageIndex + 1}: ${step} - ${msg}`)
                        imageStore.setTranslationStatus(task.imageIndex, 'failed', msg)
                        batchFailedIndices.add(task.imageIndex)
                    }
                }

                if (!batchFailedIndices.has(task.imageIndex)) {
                    updateImageStore(task)
                    completed++
                }
            }

            failed += batchTasks.filter(task => imageStore.images[task.imageIndex]?.translationStatus === 'failed').length
        }

        return { completed, failed, cancelled }
    }

    async function execute(config: PipelineConfig): Promise<PipelineResult> {
        if (!validateConfig(config)) {
            return { success: false, completed: 0, failed: 0, cancelled: 0, errors: ['Invalid configuration'] }
        }

        const images = imageStore.images
        if (images.length === 0) {
            toast.error('Please upload images first')
            return { success: false, completed: 0, failed: 0, cancelled: 0, errors: ['No images'] }
        }

        currentMode = config.mode
        const usePerImageMode = shouldUsePerImageMode(config.mode)

        isExecuting.value = true
        if (config.scope === 'all' || config.scope === 'failed' || config.scope === 'range') {
            imageStore.setBatchTranslationInProgress(true)
        }
        initRateLimiter()
        saveCurrentStyles()

        const imagesToProcess = getImagesToProcess(config)
        const errors: string[] = []

        if (savedTextStyles && imagesToProcess.length > 1) {
            for (const { index } of imagesToProcess) {
                imageStore.updateImageByIndex(index, {
                    fontSize: savedTextStyles.fontSize,
                    autoFontSize: savedTextStyles.autoFontSize,
                    fontFamily: savedTextStyles.fontFamily,
                    layoutDirection: savedTextStyles.layoutDirection,
                    textColor: savedTextStyles.textColor,
                    fillColor: savedTextStyles.fillColor,
                    strokeEnabled: savedTextStyles.strokeEnabled,
                    strokeColor: savedTextStyles.strokeColor,
                    strokeWidth: savedTextStyles.strokeWidth,
                    inpaintMethod: savedTextStyles.inpaintMethod,
                    useAutoTextColor: savedTextStyles.useAutoTextColor
                })
            }
        }

        const enableAutoSave = shouldEnableAutoSave()
        const stepChain = [...STEP_CHAIN_CONFIGS[config.mode]]

        if (config.mode === 'removeText' && settingsStore.settings.removeTextWithOcr) {
            const detectionIdx = stepChain.indexOf('detection')
            if (detectionIdx !== -1) {
                stepChain.splice(detectionIdx + 1, 0, 'ocr')
            }
        }

        if (enableAutoSave) {
            stepChain.push('save')
        }

        const tasks: TaskState[] = imagesToProcess.map(({ image, index }) => {
            const task: TaskState = {
                imageIndex: index,
                image,
                bubbleCoords: [],
                bubbleAngles: [],
                bubblePolygons: [],
                autoDirections: [],
                textMask: image.textMask || undefined,
                textlinesPerBubble: [],
                originalTexts: [],
                colors: [],
                translatedTexts: [],
                textboxTexts: []
            }

            if (config.mode === 'proofread' && image.bubbleStates && image.bubbleStates.length > 0) {
                task.bubbleCoords = image.bubbleStates.map(s => s.coords)
                task.bubbleAngles = image.bubbleStates.map(s => s.rotationAngle || 0)
                task.autoDirections = image.bubbleStates.map(s => s.autoTextDirection || s.textDirection || 'vertical')
                task.originalTexts = image.bubbleStates.map(s => s.originalText || '')
                task.translatedTexts = image.bubbleStates.map(s => s.translatedText || '')
                task.textboxTexts = image.bubbleStates.map(s => s.textboxText || '')
                task.colors = image.bubbleStates.map(s => ({
                    textColor: s.textColor || '',
                    bgColor: s.fillColor || '',
                    autoFgColor: s.autoFgColor || null,
                    autoBgColor: s.autoBgColor || null
                }))
                if (image.cleanImageData) {
                    task.cleanImage = image.cleanImageData
                }
            }

            return task
        })

        try {
            reporter.init(imagesToProcess.length, `${config.mode} started...`)

            if (enableAutoSave) {
                reporter.setPercentage(0, 'Preparing originals...')
                const preSaveSuccess = await preSaveOriginalImages({
                    onStart: (total) => {
                        reporter.setPercentage(0, `Preparing originals 0/${total}...`)
                    },
                    onProgress: (current, total) => {
                        const percent = Math.round((current / total) * 10)
                        reporter.setPercentage(percent, `Preparing originals ${current}/${total}...`)
                    },
                    onComplete: () => {
                        reporter.setPercentage(10, 'Preparation done, starting translation...')
                    },
                    onError: (error) => {
                        reporter.setPercentage(0, `Preparation failed: ${error}`)
                    }
                })
                if (!preSaveSuccess) {
                    toast.warning('Preparation failed, please save manually after translation')
                }
            }

            let result: { completed: number; failed: number; cancelled: number }

            if (usePerImageMode) {
                result = await executePerImageMode(tasks, stepChain, config, errors)
            } else {
                result = await executeBatchMode(tasks, stepChain, config, errors)
            }

            reporter.setPercentage(100, result.cancelled > 0 ? 'Cancelled' : 'Completed')

            const modeLabels: Record<TranslationMode, string> = {
                standard: 'Translation',
                hq: 'HQ Translation',
                proofread: 'AI Proofread',
                removeText: 'Remove Text'
            }

            if (result.cancelled > 0) {
                toast.warning(`${modeLabels[config.mode]} cancelled: success ${result.completed}, failed ${result.failed}, cancelled ${result.cancelled}`)
            } else {
                toast.success(`${modeLabels[config.mode]} completed!`)
            }

            imageStore.finishBatchTranslation({
                status: result.cancelled > 0 ? 'cancelled' : result.failed > 0 ? 'failed' : 'completed',
                completed: result.completed,
                failed: result.failed,
                cancelled: result.cancelled,
                total: imagesToProcess.length
            })

            return {
                success: result.failed === 0 && result.cancelled === 0,
                completed: result.completed,
                failed: result.failed,
                cancelled: result.cancelled,
                wasCancelled: result.cancelled > 0,
                errors: errors.length > 0 ? errors : undefined
            }
        } catch (error) {
            if (isTranslationCancellationError(error)) {
                const completed = imagesToProcess.filter(img => imageStore.images[img.index]?.translationStatus === 'completed').length
                const failed = imagesToProcess.filter(img => imageStore.images[img.index]?.translationStatus === 'failed').length
                const cancelled = imagesToProcess.filter(img => imageStore.images[img.index]?.translationStatus === 'cancelled').length
                imageStore.finishBatchTranslation({
                    status: 'cancelled',
                    completed,
                    failed,
                    cancelled,
                    total: imagesToProcess.length
                })
                return {
                    success: false,
                    completed,
                    failed,
                    cancelled,
                    wasCancelled: true,
                    errors
                }
            }

            const errorMessage = error instanceof Error ? error.message : 'Execution failed'
            toast.error(errorMessage)
            errors.push(errorMessage)
            imageStore.finishBatchTranslation({
                status: 'failed',
                completed: 0,
                failed: imagesToProcess.length,
                cancelled: 0,
                total: imagesToProcess.length
            })
            return {
                success: false,
                completed: 0,
                failed: imagesToProcess.length,
                cancelled: 0,
                errors
            }
        } finally {
            isExecuting.value = false
            imageStore.setBatchTranslationInProgress(false)

            if (enableAutoSave) {
                await finalizeSave()
            }

            const currentIndex = imageStore.currentImageIndex
            const currentImage = imageStore.images[currentIndex]
            if (currentImage?.bubbleStates && currentImage.bubbleStates.length > 0) {
                bubbleStore.setBubbles(currentImage.bubbleStates)
            }

            setTimeout(() => reporter.finish(), 1000)
        }
    }

    function cancel(): void {
        if (imageStore.isBatchTranslationInProgress) {
            imageStore.markBatchTranslationCancelling()
            imageStore.setBatchTranslationInProgress(false)
            // 重置自动保存状态
            resetSaveState()
            toast.info('Operation cancelled')
        }
    }

    return {
        progress,
        isExecuting,
        isTranslating,
        progressPercent,
        execute,
        cancel,
        STEP_CHAIN_CONFIGS
    }
}
