import type { CardBalance } from '../lib/cardClient'

export default function Header({
  balance,
  onAddCard,
  purchaseUrl,
}: {
  balance: CardBalance
  onAddCard: () => void
  purchaseUrl?: string
}) {
  const hasBusyCard = Boolean(balance.hasBusyCard || balance.cards.some((card) => card.busy))
  const hasUsableCard = balance.cards.some((card) => card.status === 'active' && card.remainingCredits > 0)
  const cardStatusClass = hasBusyCard
    ? 'bg-red-500 shadow-[0_0_10px_rgba(239,68,68,0.8)]'
    : hasUsableCard
      ? 'bg-green-500 shadow-[0_0_10px_rgba(34,197,94,0.75)]'
      : 'bg-gray-400 dark:bg-gray-500'
  const cardStatusTitle = hasBusyCard
    ? '当前卡密有任务正在生成'
    : hasUsableCard
      ? '当前卡密可用'
      : '当前卡密暂无可用次数'

  return (
    <>
      <header data-no-drag-select className="safe-area-top fixed top-0 left-0 right-0 z-40 bg-white/85 dark:bg-gray-950/85 backdrop-blur border-b border-gray-200 dark:border-white/[0.08]">
        <div className="safe-area-x safe-header-inner max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <img src="./yunyi-logo.svg" alt="" className="h-8 w-8 rounded-lg shadow-sm" />
            <div className="min-w-0">
              <h1 className="truncate text-lg font-bold tracking-tight text-gray-900 dark:text-gray-100">
                云逸生图
              </h1>
            </div>
            <div className="flex items-center gap-2 rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-600 dark:bg-white/[0.06] dark:text-gray-300">
              <span>剩余 {balance.totalRemaining} 次</span>
              <button
                type="button"
                onClick={onAddCard}
                className="flex h-5 w-5 items-center justify-center rounded-full bg-blue-500 text-white transition hover:bg-blue-600"
                aria-label="添加卡密"
                title="添加卡密"
              >
                +
              </button>
              {purchaseUrl && (
                <button
                  type="button"
                  onClick={() => window.open(purchaseUrl, '_blank', 'noopener,noreferrer')}
                  className="flex h-7 w-7 items-center justify-center rounded-full bg-orange-500 text-white shadow-[0_8px_22px_rgba(249,115,22,0.38)] transition hover:bg-orange-600"
                  aria-label="购买卡密"
                  title="购买卡密"
                >
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
                    <circle cx="9" cy="21" r="1" />
                    <circle cx="20" cy="21" r="1" />
                    <path d="M1 1h4l2.7 13.4a2 2 0 0 0 2 1.6h9.7a2 2 0 0 0 2-1.6L23 6H6" />
                  </svg>
                </button>
              )}
              <div
                className="flex h-7 items-center gap-1.5 rounded-full bg-gray-100 px-2.5 text-xs font-medium text-gray-600 dark:bg-white/[0.06] dark:text-gray-300"
                title={cardStatusTitle}
              >
                <span>卡密情况</span>
                <span className={`h-2 w-2 rounded-full ${cardStatusClass}`} aria-hidden="true" />
              </div>
            </div>
          </div>
        </div>
      </header>
      <div className="safe-area-top invisible pointer-events-none" aria-hidden="true">
        <div className="safe-header-inner" />
      </div>
    </>
  )
}
