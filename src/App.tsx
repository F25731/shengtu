import { useCallback, useEffect, useState } from 'react'
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
import PurchaseButton from './components/PurchaseButton'
import { readCardBalance, readClientConfig, type CardBalance, type ClientConfig } from './lib/cardClient'

export default function App() {
  const setSettings = useStore((s) => s.setSettings)
  const [cardReady, setCardReady] = useState(false)
  const [showAddCard, setShowAddCard] = useState(false)
  const [balance, setBalance] = useState<CardBalance>({ cards: [], totalRemaining: 0 })
  const [clientConfig, setClientConfig] = useState<ClientConfig>({ purchaseUrl: '', costPerGeneration: 1 })

  const refreshBalance = useCallback(async () => {
    const [nextBalance, nextConfig] = await Promise.all([
      readCardBalance(),
      readClientConfig(),
    ])
    setBalance(nextBalance)
    setClientConfig(nextConfig)
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
      <Header balance={balance} onAddCard={() => setShowAddCard(true)} />
      <main data-home-main data-drag-select-surface className="pb-48">
        <div className="safe-area-x max-w-7xl mx-auto">
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
      <PurchaseButton config={clientConfig} />
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
