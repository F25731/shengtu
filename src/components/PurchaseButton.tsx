import type { ClientConfig } from '../lib/cardClient'

export default function PurchaseButton({ config }: { config: ClientConfig }) {
  if (!config.purchaseUrl) return null
  return (
    <button
      data-no-drag-select
      onClick={() => window.open(config.purchaseUrl, '_blank', 'noopener,noreferrer')}
      className="fixed right-5 top-1/2 z-30 flex h-24 w-24 -translate-y-1/2 flex-col items-center justify-center gap-2 rounded-3xl bg-orange-500 text-white shadow-[0_18px_44px_rgba(249,115,22,0.42)] transition hover:bg-orange-600"
      title="购买卡密"
    >
      <svg className="h-8 w-8" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="9" cy="21" r="1" />
        <circle cx="20" cy="21" r="1" />
        <path d="M1 1h4l2.7 13.4a2 2 0 0 0 2 1.6h9.7a2 2 0 0 0 2-1.6L23 6H6" />
      </svg>
      <span className="text-sm font-bold">购买卡密</span>
    </button>
  )
}
