import { useState } from 'react'
import { addCardCode } from '../lib/cardClient'

interface Props {
  onClose: () => void
  onAdded: () => void
}

export default function AddCardModal({ onClose, onAdded }: Props) {
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const submit = async () => {
    setError('')
    setLoading(true)
    try {
      await addCardCode(code)
      onAdded()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-sm rounded-2xl border border-white/[0.08] bg-gray-900 p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-1 text-lg font-bold text-white">添加卡密</h2>
        <p className="mb-4 text-sm text-gray-400">新卡密会加入本机卡包，剩余次数自动叠加。</p>
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
        <div className="flex gap-2">
          <button onClick={onClose} className="flex-1 rounded-xl bg-white/[0.06] px-4 py-2.5 text-sm font-semibold text-gray-200 hover:bg-white/[0.1]">
            取消
          </button>
          <button
            onClick={submit}
            disabled={loading || !code.trim()}
            className="flex-1 rounded-xl bg-blue-500 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? '添加中...' : '添加'}
          </button>
        </div>
      </div>
    </div>
  )
}
