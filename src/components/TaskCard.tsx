import { memo, useEffect, useState, useRef } from 'react'
import type { TaskRecord } from '../types'
import { useStore, ensureImageThumbnailCached, subscribeImageThumbnail, retryTask } from '../store'
import { formatImageRatio } from '../lib/size'
import { getParamDisplay, ActualValueBadge } from '../lib/paramDisplay'

interface Props {
  task: TaskRecord
  onReuse: () => void
  onEditOutputs: () => void
  onDelete: () => void
  onClick: (e: React.MouseEvent | React.TouchEvent) => void
  isSelected?: boolean
}

function getTaskAiLabel(task: TaskRecord) {
  const text = `${task.apiProvider || ''} ${task.apiProfileName || ''} ${task.apiModel || ''}`.toLowerCase()
  if (text.includes('gemini')) return {
    label: 'Gemini',
    className: 'bg-gradient-to-r from-purple-500/20 to-pink-500/20 text-purple-600 dark:text-purple-400 border border-purple-500/30',
    iconColor: 'text-purple-500'
  }
  if (text.includes('grok')) return {
    label: 'Grok',
    className: 'bg-gradient-to-r from-sky-500/20 to-blue-500/20 text-sky-600 dark:text-sky-400 border border-sky-500/30',
    iconColor: 'text-sky-500'
  }
  return {
    label: 'ChatGPT',
    className: 'bg-gradient-to-r from-emerald-500/20 to-teal-500/20 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30',
    iconColor: 'text-emerald-500'
  }
}

function TaskCard({
  task,
  onReuse,
  onEditOutputs,
  onDelete,
  onClick,
  isSelected,
}: Props) {
  const [thumbSrc, setThumbSrc] = useState<string>('')
  const [coverRatio, setCoverRatio] = useState<string>('')
  const [coverSize, setCoverSize] = useState<string>('')
  const [now, setNow] = useState(Date.now())
  const [swipeOffset, setSwipeOffset] = useState(0)
  const [isSwiping, setIsSwiping] = useState(false)
  const [swipeStartedSelected, setSwipeStartedSelected] = useState(false)
  const [swipeActionActive, setSwipeActionActive] = useState(false)
  const toggleTaskSelection = useStore((s) => s.toggleTaskSelection)
  const settings = useStore((s) => s.settings)
  const touchStartRef = useRef<{ x: number; y: number } | null>(null)
  const swipeResetTimerRef = useRef<number | null>(null)
  const suppressClickUntilRef = useRef(0)
  const horizontalSwipeRef = useRef(false)

  const isTagScrollTarget = (target: EventTarget | null) => {
    return target instanceof Element && Boolean(target.closest('[data-tag-scroll-area]'))
  }

  const handleTouchStart = (e: React.TouchEvent) => {
    if (isTagScrollTarget(e.target)) {
      touchStartRef.current = null
      horizontalSwipeRef.current = false
      setIsSwiping(false)
      setSwipeOffset(0)
      setSwipeActionActive(false)
      return
    }

    if (swipeResetTimerRef.current != null) {
      window.clearTimeout(swipeResetTimerRef.current)
      swipeResetTimerRef.current = null
    }
    touchStartRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }
    horizontalSwipeRef.current = false
    setSwipeStartedSelected(Boolean(isSelected))
    setSwipeActionActive(false)
    setIsSwiping(true)
  }

  const handleTouchMove = (e: React.TouchEvent) => {
    if (isTagScrollTarget(e.target)) return
    if (!touchStartRef.current) return
    const deltaX = e.touches[0].clientX - touchStartRef.current.x
    const deltaY = e.touches[0].clientY - touchStartRef.current.y
    
    // 如果主要是水平滑动
    if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > 10) {
      horizontalSwipeRef.current = true
      e.preventDefault()
      // 限制滑动距离，例如最大 60px
      const boundedOffset = Math.max(-60, Math.min(60, deltaX))
      setSwipeOffset(boundedOffset)
      setSwipeActionActive(Math.abs(deltaX) >= 40)
    }
  }

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (isTagScrollTarget(e.target)) {
      touchStartRef.current = null
      horizontalSwipeRef.current = false
      setIsSwiping(false)
      setSwipeOffset(0)
      setSwipeActionActive(false)
      return
    }

    setIsSwiping(false)
    setSwipeOffset(0)
    
    if (!touchStartRef.current) return
    const deltaX = e.changedTouches[0].clientX - touchStartRef.current.x
    touchStartRef.current = null
    const isSwipeAction = horizontalSwipeRef.current && Math.abs(deltaX) > 40
    horizontalSwipeRef.current = false
    setSwipeActionActive(isSwipeAction)
    swipeResetTimerRef.current = window.setTimeout(() => {
      setSwipeActionActive(false)
      swipeResetTimerRef.current = null
    }, 220)

    // 如果是水平滑动，且垂直偏移较小，认为是滑动选择
    if (isSwipeAction) {
      suppressClickUntilRef.current = Date.now() + 350
      e.preventDefault()
      e.stopPropagation()
      toggleTaskSelection(task.id)
    }
  }

  const handleTouchCancel = () => {
    touchStartRef.current = null
    horizontalSwipeRef.current = false
    setIsSwiping(false)
    setSwipeOffset(0)
    setSwipeActionActive(false)
  }

  useEffect(() => () => {
    if (swipeResetTimerRef.current != null) {
      window.clearTimeout(swipeResetTimerRef.current)
    }
  }, [])

  // 定时更新运行中任务的计时
  useEffect(() => {
    if (task.status !== 'running' && !(task.status === 'error' && (task.falRecoverable || task.customRecoverable))) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    setNow(Date.now())
    return () => clearInterval(id)
  }, [task.customRecoverable, task.falRecoverable, task.proxyRecoverable, task.status])

  // 加载缩略图
  useEffect(() => {
    setCoverRatio('')
    setCoverSize('')
    setThumbSrc('')

    let cancelled = false
    const imageId = task.outputImages?.[0]
    let unsubscribe: (() => void) | undefined

    const applyThumbnail = (thumbnail: { dataUrl: string; width?: number; height?: number }) => {
      if (cancelled) return
      setThumbSrc(thumbnail.dataUrl)
      if (thumbnail.width && thumbnail.height) {
        setCoverRatio(formatImageRatio(thumbnail.width, thumbnail.height))
        setCoverSize(`${thumbnail.width}×${thumbnail.height}`)
      }
    }

    if (imageId) {
      unsubscribe = subscribeImageThumbnail(imageId, applyThumbnail)
      ensureImageThumbnailCached(imageId).then((thumbnail) => {
        if (cancelled || !thumbnail) return
        applyThumbnail(thumbnail)
      }).catch(() => {
        if (!cancelled) setThumbSrc('')
      })
    }

    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [task.outputImages])

  const duration = (() => {
    let seconds: number
    if (task.status === 'running' || task.falRecoverable || task.customRecoverable) {
      seconds = Math.floor((now - task.createdAt) / 1000)
    } else if (task.elapsed != null) {
      seconds = Math.floor(task.elapsed / 1000)
    } else {
      return '00:00'
    }
    const mm = String(Math.floor(seconds / 60)).padStart(2, '0')
    const ss = String(seconds % 60).padStart(2, '0')
    return `${mm}:${ss}`
  })()
  const isSwipeReady = Math.abs(swipeOffset) >= 40
  const showSwipeAction = isSwipeReady || swipeActionActive
  const isFalReconnecting = task.status === 'error' && task.falRecoverable
  const isCustomReconnecting = task.status === 'error' && task.customRecoverable
  const isProxyReconnecting = task.status === 'running' && task.proxyRecoverable
  const showRunningTimer = task.status === 'running' || isFalReconnecting || isCustomReconnecting
  const swipeBgClass = showSwipeAction
    ? swipeStartedSelected
      ? 'bg-gray-500 dark:bg-gray-600'
      : 'bg-blue-500'
    : 'bg-gray-200 dark:bg-gray-700'

  const qualityDisplay = getParamDisplay(task, 'quality')
  const showQuality = task.params.quality !== 'auto' || qualityDisplay.isMismatch

  const sizeDisplay = getParamDisplay(task, 'size')
  const showSize = task.params.size !== 'auto' || sizeDisplay.isMismatch

  const formatDisplay = getParamDisplay(task, 'output_format')
  const showFormat = task.params.output_format !== 'png' || formatDisplay.isMismatch

  const nDisplay = getParamDisplay(task, 'n')
  const showN = task.params.n > 1 || nDisplay.isMismatch
  const aiLabel = getTaskAiLabel(task)

  return (
    <div className="relative rounded-2xl">
      {/* 侧滑底图 */}
      <div
        className={`absolute inset-0 rounded-2xl flex items-center transition-opacity duration-200 pointer-events-none ${
          isSwiping || swipeOffset || swipeActionActive ? 'opacity-100' : 'opacity-0'
        } ${swipeBgClass} ${
          swipeOffset > 0 ? 'justify-start pl-6' : 'justify-end pr-6'
        }`}
      >
        <svg className={`w-8 h-8 transition-transform duration-150 ${showSwipeAction ? 'scale-110 text-white' : 'scale-90 text-white/60'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          {swipeStartedSelected && showSwipeAction ? (
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          ) : (
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
          )}
        </svg>
      </div>

      <div
        className={`relative bg-gradient-to-br from-white to-gray-50/50 dark:from-gray-900 dark:to-gray-900/80 rounded-2xl border backdrop-blur-sm overflow-hidden cursor-pointer duration-200 hover:shadow-xl hover:shadow-gray-200/50 dark:hover:shadow-black/30 dark:hover:from-gray-800/90 dark:hover:to-gray-900 ${
          !isSwiping ? 'transition-[box-shadow,border-color,background,transform]' : 'transition-[box-shadow,border-color,background]'
        } ${
          task.status === 'running'
            ? 'border-blue-400/60 shadow-lg shadow-blue-500/10 generating'
            : isSelected
            ? 'border-blue-500/60 shadow-xl shadow-blue-500/20 ring-2 ring-blue-500/40'
            : 'border-gray-200/60 dark:border-white/[0.06] hover:border-gray-300/80 dark:hover:border-white/[0.12]'
        }`}
        style={{
          transform: swipeOffset ? `translateX(${swipeOffset}px)` : undefined,
        }}
        onClick={(e) => {
          if (Date.now() < suppressClickUntilRef.current) {
            e.preventDefault()
            e.stopPropagation()
            return
          }
          onClick(e)
        }}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchCancel}
      >
        {/* 选中时的角标 */}
      {isSelected && (
        <div className="absolute top-3 right-3 z-10 w-6 h-6 bg-gradient-to-br from-blue-500 to-blue-600 rounded-full flex items-center justify-center shadow-lg shadow-blue-500/50">
          <svg className="w-3.5 h-3.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
          </svg>
        </div>
      )}
      <div className="flex h-40">
        {/* 左侧图片区域 */}
        <div className="w-40 min-w-[10rem] h-full bg-gradient-to-br from-gray-100 to-gray-50 dark:from-black/30 dark:to-black/20 relative flex items-center justify-center overflow-hidden flex-shrink-0">
          {task.status === 'running' && (
            <div className="flex flex-col items-center gap-2">
              <svg
                className="w-8 h-8 text-blue-400 animate-spin"
                fill="none"
                viewBox="0 0 24 24"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                />
              </svg>
              <span className={`text-xs text-center ${isProxyReconnecting ? 'text-yellow-500' : 'text-gray-400 dark:text-gray-500'}`}>
                {isProxyReconnecting ? task.error || '连接中，稍后自动刷新' : '生成中...'}
              </span>
            </div>
          )}
          {task.status === 'error' && isFalReconnecting && (
            <div className="flex flex-col items-center gap-1 px-2">
              <svg
                className="w-7 h-7 text-yellow-400"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                />
              </svg>
              <span className="text-xs text-yellow-500 text-center leading-tight">
                重连中
              </span>
            </div>
          )}
          {task.status === 'error' && !isFalReconnecting && (
            <div className="flex flex-col items-center gap-1 px-2">
              <svg
                className="w-7 h-7 text-red-400"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
              <span className="text-xs text-red-400 text-center leading-tight">
                失败
              </span>
            </div>
          )}
          {task.status === 'done' && thumbSrc && (
            <>
              <img
                src={thumbSrc}
                data-image-id={task.outputImages[0]}
                className="saveable-image w-full h-full object-cover"
                loading="lazy"
                decoding="async"
                alt=""
              />
              {task.outputImages.length > 1 && (
                <span className="absolute bottom-1 right-1 bg-black/60 text-white text-xs px-1.5 py-0.5 rounded">
                  {task.outputImages.length}
                </span>
              )}
            </>
          )}
          {task.status === 'done' && !thumbSrc && (
            <svg
              className="w-8 h-8 text-gray-300"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
              />
            </svg>
          )}
          {/* 运行中显示耗时，完成后显示封面图比例与分辨率标签 */}
          <div className="absolute top-2 left-2 flex items-center gap-1.5">
            {showRunningTimer || task.status !== 'done' || !coverRatio || !coverSize ? (
              <span className="flex items-center gap-1.5 bg-gradient-to-r from-black/60 to-black/50 text-white text-[10px] sm:text-xs px-2 py-1 rounded-lg backdrop-blur-md font-mono shadow-lg">
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                {duration}
              </span>
            ) : (
              <>
                <span className="bg-gradient-to-r from-blue-500/90 to-blue-600/90 text-white text-[10px] sm:text-xs px-2 py-1 rounded-lg backdrop-blur-md font-mono shadow-lg shadow-blue-500/30">
                  {coverRatio}
                </span>
                <span className="bg-gradient-to-r from-purple-500/90 to-purple-600/90 text-white text-[10px] sm:text-xs px-2 py-1 rounded-lg backdrop-blur-md font-medium shadow-lg shadow-purple-500/30">
                  {coverSize}
                </span>
              </>
            )}
          </div>
        </div>

        {/* 右侧信息区域 */}
        <div className="flex-1 p-3 flex flex-col min-w-0">
          <div className="flex-1 min-h-0 mb-2 overflow-hidden">
            <p className="text-sm text-gray-700 dark:text-gray-300 leading-relaxed line-clamp-3">
              {task.prompt || '(无提示词)'}
            </p>
          </div>
          <div className="mt-auto flex flex-col gap-1.5">
            {/* 参数与信息：横向滚动 */}
            <div
              data-tag-scroll-area
              className="flex overflow-x-auto hide-scrollbar pt-0.5 gap-2 whitespace-nowrap mask-edge-r min-w-0 pr-2"
              onTouchStart={(e) => e.stopPropagation()}
              onTouchMove={(e) => e.stopPropagation()}
              onTouchEnd={(e) => e.stopPropagation()}
              onTouchCancel={(e) => e.stopPropagation()}
            >
              <span className={`flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs font-medium flex-shrink-0 shadow-sm ${aiLabel.className}`}>
                {aiLabel.label}
              </span>
              {/* Mask */}
              {task.maskImageId && (
                <span className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-gradient-to-r from-blue-500/15 to-cyan-500/15 border border-blue-500/30 text-blue-600 dark:text-blue-400 text-xs flex-shrink-0 shadow-sm">
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                  </svg>
                  局部重绘
                </span>
              )}
              {/* Params: only show if not default or mismatch */}
              {showQuality && (
                <span className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-gradient-to-r from-gray-100 to-gray-50 dark:from-white/[0.06] dark:to-white/[0.04] border border-gray-200/50 dark:border-white/[0.08] text-xs flex-shrink-0 shadow-sm">
                  <span className="text-gray-500 dark:text-gray-400">质量</span>
                  {qualityDisplay.isMismatch ? <ActualValueBadge value={qualityDisplay.displayValue} className="px-1.5 py-0.5 rounded" /> : <span className="text-gray-700 dark:text-gray-200 font-medium">{qualityDisplay.displayValue}</span>}
                </span>
              )}
              {showSize && (
                <span className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-gradient-to-r from-gray-100 to-gray-50 dark:from-white/[0.06] dark:to-white/[0.04] border border-gray-200/50 dark:border-white/[0.08] text-xs flex-shrink-0 shadow-sm">
                  <span className="text-gray-500 dark:text-gray-400">尺寸</span>
                  {sizeDisplay.isMismatch ? <ActualValueBadge value={sizeDisplay.displayValue} className="px-1.5 py-0.5 rounded" /> : <span className="text-gray-700 dark:text-gray-200 font-medium">{sizeDisplay.displayValue}</span>}
                </span>
              )}
              {showFormat && (
                <span className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-gradient-to-r from-gray-100 to-gray-50 dark:from-white/[0.06] dark:to-white/[0.04] border border-gray-200/50 dark:border-white/[0.08] text-xs flex-shrink-0 shadow-sm">
                  <span className="text-gray-500 dark:text-gray-400">格式</span>
                  {formatDisplay.isMismatch ? <ActualValueBadge value={formatDisplay.displayValue} className="px-1.5 py-0.5 rounded" /> : <span className="text-gray-700 dark:text-gray-200 font-medium">{formatDisplay.displayValue}</span>}
                </span>
              )}
              {showN && (
                <span className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-gradient-to-r from-gray-100 to-gray-50 dark:from-white/[0.06] dark:to-white/[0.04] border border-gray-200/50 dark:border-white/[0.08] text-xs flex-shrink-0 shadow-sm">
                  <span className="text-gray-500 dark:text-gray-400">数量</span>
                  {nDisplay.isMismatch ? <ActualValueBadge value={nDisplay.displayValue} className="px-1.5 py-0.5 rounded" /> : <span className="text-gray-700 dark:text-gray-200 font-medium">{nDisplay.displayValue}</span>}
                </span>
              )}
            </div>
            {/* 操作按钮 */}
            <div
              className="flex w-full items-center justify-between flex-shrink-0 mt-0.5 sm:w-auto sm:justify-end sm:gap-1.5"
              onClick={(e) => e.stopPropagation()}
            >
              {((task.status === 'error' && !isFalReconnecting) || settings.alwaysShowRetryButton) && (
                <button
                  onClick={() => retryTask(task)}
                  className="p-2 rounded-xl bg-gradient-to-br from-white to-gray-50/50 dark:from-white/[0.06] dark:to-white/[0.03] hover:from-blue-50 hover:to-blue-100/50 dark:hover:from-blue-500/20 dark:hover:to-blue-600/10 text-gray-500 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 transition-all duration-200 border border-gray-200/60 dark:border-white/[0.08] hover:border-blue-300/60 dark:hover:border-blue-500/30 shadow-sm hover:shadow-md hover:shadow-blue-500/20"
                  title="重试任务"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                </button>
              )}
              <button
                onClick={onReuse}
                className="p-2 rounded-xl bg-gradient-to-br from-white to-gray-50/50 dark:from-white/[0.06] dark:to-white/[0.03] hover:from-blue-50 hover:to-blue-100/50 dark:hover:from-blue-500/20 dark:hover:to-blue-600/10 text-gray-500 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 transition-all duration-200 border border-gray-200/60 dark:border-white/[0.08] hover:border-blue-300/60 dark:hover:border-blue-500/30 shadow-sm hover:shadow-md hover:shadow-blue-500/20"
                title="重新生成"
              >
                <svg
                  className="w-4 h-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"
                  />
                </svg>
              </button>
              <button
                onClick={onEditOutputs}
                className="p-2 rounded-xl bg-gradient-to-br from-white to-gray-50/50 dark:from-white/[0.06] dark:to-white/[0.03] hover:from-green-50 hover:to-green-100/50 dark:hover:from-green-500/20 dark:hover:to-green-600/10 text-gray-500 dark:text-gray-400 hover:text-green-600 dark:hover:text-green-400 transition-all duration-200 border border-gray-200/60 dark:border-white/[0.08] hover:border-green-300/60 dark:hover:border-green-500/30 shadow-sm hover:shadow-md hover:shadow-green-500/20 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:from-white disabled:hover:to-gray-50/50 dark:disabled:hover:from-white/[0.06] dark:disabled:hover:to-white/[0.03] disabled:hover:border-gray-200/60 dark:disabled:hover:border-white/[0.08] disabled:hover:shadow-sm disabled:hover:text-gray-500 dark:disabled:hover:text-gray-400"
                title="继续修改"
                disabled={!task.outputImages?.length}
              >
                <svg
                  className="w-4 h-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                  />
                </svg>
              </button>
              <button
                onClick={onDelete}
                className="p-2 rounded-xl bg-gradient-to-br from-white to-gray-50/50 dark:from-white/[0.06] dark:to-white/[0.03] hover:from-red-50 hover:to-red-100/50 dark:hover:from-red-500/20 dark:hover:to-red-600/10 text-gray-500 dark:text-gray-400 hover:text-red-600 dark:hover:text-red-400 transition-all duration-200 border border-gray-200/60 dark:border-white/[0.08] hover:border-red-300/60 dark:hover:border-red-500/30 shadow-sm hover:shadow-md hover:shadow-red-500/20"
                title="删除记录"
              >
                <svg
                  className="w-4 h-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                  />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </div>
      </div>
    </div>
  )
}

export default memo(TaskCard)
