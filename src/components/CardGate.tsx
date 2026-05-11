import { useEffect, useState } from 'react'
import { addCardCode, hasStoredCards, readCardBalance, readClientConfig, type ClientConfig } from '../lib/cardClient'

interface Props {
  onReady: () => void
}

export default function CardGate({ onReady }: Props) {
  const [config, setConfig] = useState<ClientConfig>({ purchaseUrl: '', costPerGeneration: 1, announcementText: '', gateNoticeText: '' })
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      if (hasStoredCards()) {
        onReady()
        readCardBalance().catch(() => {})
        readClientConfig()
          .then((nextConfig) => {
            if (!cancelled) setConfig(nextConfig)
          })
          .catch(() => {})
        return
      }
      const nextConfig = await readClientConfig()
      if (cancelled) return
      setConfig(nextConfig)
      setLoading(false)
    })().catch(() => {
      if (!cancelled) setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [onReady])

  const submit = async () => {
    setError('')
    setSubmitting(true)
    try {
      await addCardCode(code)
      onReady()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) return null

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-gray-950 p-4">
      <div className="w-full max-w-md rounded-2xl border border-white/[0.08] bg-gray-900 p-6 shadow-2xl">
        <div className="mb-5 flex items-center gap-3">
          <img src="./yunyi-logo.svg" alt="" className="h-10 w-10 rounded-xl" />
          <div>
            <h1 className="text-xl font-bold text-white">云逸生图</h1>
            <p className="text-sm text-gray-400">请输入卡密后开始使用</p>
          </div>
        </div>
        {config.gateNoticeText && (
          <div className="mb-4 flex gap-3 rounded-xl border border-amber-400/20 bg-amber-400/10 px-4 py-3 text-sm leading-6 text-amber-100">
            <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-amber-400 text-sm font-black text-gray-950">!</span>
            <p>{config.gateNoticeText}</p>
          </div>
        )}
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
          }}
          placeholder="YunYi-XXXX-XXXX-XXXX-XXXX"
          className="mb-3 w-full rounded-xl border border-white/[0.08] bg-white/[0.04] px-4 py-3 text-sm text-white outline-none transition focus:border-blue-400"
        />
        {error && <p className="mb-3 text-sm text-red-400">{error}</p>}
        <button
          onClick={submit}
          disabled={submitting || !code.trim()}
          className="mb-3 w-full rounded-xl bg-blue-500 px-4 py-3 text-sm font-semibold text-white transition hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? '验证中...' : '开始使用'}
        </button>
        <button
          onClick={() => config.purchaseUrl && window.open(config.purchaseUrl, '_blank', 'noopener,noreferrer')}
          disabled={!config.purchaseUrl}
          className="w-full rounded-xl bg-orange-500 px-4 py-3 text-sm font-semibold text-white transition hover:bg-orange-600 disabled:cursor-not-allowed disabled:opacity-50"
        >
          购买卡密
        </button>
      </div>
    </div>
  )
}
