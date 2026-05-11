import { useCallback, useEffect, useRef, useState } from 'react'
import { initStore } from './store'
import { useStore } from './store'
import { buildSettingsFromUrlParams, clearUrlSettingParams, hasUrlSettingParams } from './lib/urlSettings'
import Header from './components/Header'
import TaskGrid from './components/TaskGrid'
import InputBar from './components/InputBar'
import DetailModal from './components/DetailModal'
import Lightbox from './components/Lightbox'
import ConfirmDialog from './components/ConfirmDialog'
import Toast from './components/Toast'
import MaskEditorModal from './components/MaskEditorModal'
import ImageContextMenu from './components/ImageContextMenu'
import CardGate from './components/CardGate'
import AddCardModal from './components/AddCardModal'
import AnnouncementBanner from './components/AnnouncementBanner'
import { readCachedCardBalance, readCardBalance, readClientConfig, type CardBalance, type ClientConfig } from './lib/cardClient'

const BALANCE_REFRESH_INTERVAL_MS = 30_000
const BUSY_BALANCE_REFRESH_INTERVAL_MS = 3_000

function areClientConfigsEqual(a: ClientConfig, b: ClientConfig) {
  return (
    a.purchaseUrl === b.purchaseUrl &&
    a.costPerGeneration === b.costPerGeneration &&
    a.announcementText === b.announcementText &&
    a.gateNoticeText === b.gateNoticeText
  )
}

function areCardBalancesEqual(a: CardBalance, b: CardBalance) {
  if (
    a.totalRemaining !== b.totalRemaining ||
    a.hasBusyCard !== b.hasBusyCard ||
    a.availableForGeneration !== b.availableForGeneration ||
    a.cards.length !== b.cards.length
  ) {
    return false
  }

  return a.cards.every((card, index) => {
    const next = b.cards[index]
    return (
      card.code === next.code &&
      card.totalCredits === next.totalCredits &&
      card.usedCredits === next.usedCredits &&
      card.remainingCredits === next.remainingCredits &&
      card.status === next.status &&
      card.batchName === next.batchName &&
      card.activatedAt === next.activatedAt &&
      card.createdAt === next.createdAt &&
      card.updatedAt === next.updatedAt &&
      card.busy === next.busy
    )
  })
}

export default function App() {
  const setSettings = useStore((s) => s.setSettings)
  const [cardReady, setCardReady] = useState(false)
  const [showAddCard, setShowAddCard] = useState(false)
  const [balance, setBalance] = useState<CardBalance>(() => readCachedCardBalance() ?? { cards: [], totalRemaining: 0 })
  const [clientConfig, setClientConfig] = useState<ClientConfig>({ purchaseUrl: '', costPerGeneration: 1, announcementText: '', gateNoticeText: '' })
  const refreshInFlightRef = useRef(false)

  const refreshBalance = useCallback(async () => {
    if (refreshInFlightRef.current) return
    refreshInFlightRef.current = true
    try {
      const [nextBalance, nextConfig] = await Promise.all([
        readCardBalance(),
        readClientConfig(),
      ])
      setBalance((current) => (areCardBalancesEqual(current, nextBalance) ? current : nextBalance))
      setClientConfig((current) => (areClientConfigsEqual(current, nextConfig) ? current : nextConfig))
    } catch {
      // Keep the cached balance visible if the network is temporarily unavailable.
    } finally {
      refreshInFlightRef.current = false
    }
  }, [])

  useEffect(() => {
    window.__YUNYI_REFRESH_BALANCE__ = () => {
      void refreshBalance()
    }
    return () => {
      delete window.__YUNYI_REFRESH_BALANCE__
    }
  }, [refreshBalance])

  useEffect(() => {
    if (!cardReady) return

    void refreshBalance()
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refreshBalance()
    }, BALANCE_REFRESH_INTERVAL_MS)

    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') void refreshBalance()
    }
    const refreshNow = () => {
      void refreshBalance()
    }

    document.addEventListener('visibilitychange', refreshWhenVisible)
    window.addEventListener('focus', refreshNow)
    window.addEventListener('online', refreshNow)

    return () => {
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', refreshWhenVisible)
      window.removeEventListener('focus', refreshNow)
      window.removeEventListener('online', refreshNow)
    }
  }, [cardReady, refreshBalance])

  useEffect(() => {
    if (!cardReady || !balance.cards.some((card) => card.busy)) return

    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refreshBalance()
    }, BUSY_BALANCE_REFRESH_INTERVAL_MS)

    return () => window.clearInterval(interval)
  }, [balance.cards, cardReady, refreshBalance])

  useEffect(() => {
    const searchParams = new URLSearchParams(window.location.search)
    const nextSettings = buildSettingsFromUrlParams(useStore.getState().settings, searchParams)

    setSettings(nextSettings)

    if (hasUrlSettingParams(searchParams)) {
      clearUrlSettingParams(searchParams)

      const nextSearch = searchParams.toString()
      const nextUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ''}${window.location.hash}`
      window.history.replaceState(null, '', nextUrl)
    }

    initStore()
  }, [setSettings])

  useEffect(() => {
    const preventPageImageDrag = (e: DragEvent) => {
      if ((e.target as HTMLElement | null)?.closest('img')) {
        e.preventDefault()
      }
    }

    document.addEventListener('dragstart', preventPageImageDrag)
    return () => document.removeEventListener('dragstart', preventPageImageDrag)
  }, [])

  return (
    <>
      <Header balance={balance} onAddCard={() => setShowAddCard(true)} purchaseUrl={clientConfig.purchaseUrl} />
      <main data-home-main data-drag-select-surface className="pt-6 pb-48 sm:pt-8">
        <div className="safe-area-x max-w-7xl mx-auto">
          <AnnouncementBanner text={clientConfig.announcementText} />
          <TaskGrid />
        </div>
      </main>
      <InputBar />
      <DetailModal />
      <Lightbox />
      <ConfirmDialog />
      <Toast />
      <MaskEditorModal />
      <ImageContextMenu />
      {!cardReady && <CardGate onReady={() => {
        setCardReady(true)
        void refreshBalance()
      }} />}
      {showAddCard && (
        <AddCardModal
          onClose={() => setShowAddCard(false)}
          onAdded={() => {
            void refreshBalance()
          }}
        />
      )}
    </>
  )
}
