const CARD_CODES_STORAGE_KEY = 'yunyi.cardCodes'
const CARD_BALANCE_CACHE_KEY = 'yunyi.cardBalanceCache'

export interface PublicCard {
  code: string
  totalCredits: number
  usedCredits: number
  remainingCredits: number
  status: 'active' | 'depleted' | 'disabled' | 'missing'
  batchName?: string
  activatedAt?: string
  createdAt?: string
  updatedAt?: string
}

export interface CardBalance {
  cards: PublicCard[]
  totalRemaining: number
}

export interface ClientConfig {
  purchaseUrl: string
  costPerGeneration: number
  announcementText: string
}

function normalizeCardCode(input: string): string {
  const raw = input.trim().replace(/[—–−]/g, '-').replace(/\s+/g, '')
  const compact = raw.replace(/^YunYi-?/i, '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase()
  if (compact.length !== 16) return ''
  return `YunYi-${compact.slice(0, 4)}-${compact.slice(4, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}`
}

export function readStoredCardCodes(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(CARD_CODES_STORAGE_KEY) || '[]')
    return Array.isArray(parsed) ? [...new Set(parsed.map((item) => normalizeCardCode(String(item))).filter(Boolean))] : []
  } catch {
    return []
  }
}

export function saveStoredCardCodes(codes: string[]) {
  localStorage.setItem(CARD_CODES_STORAGE_KEY, JSON.stringify([...new Set(codes.map(normalizeCardCode).filter(Boolean))]))
}

export function readCachedCardBalance(): CardBalance | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(CARD_BALANCE_CACHE_KEY) || 'null')
    if (!parsed || typeof parsed !== 'object') return null
    const totalRemaining = Number(parsed.totalRemaining)
    const cards = Array.isArray(parsed.cards) ? parsed.cards : []
    if (!Number.isFinite(totalRemaining)) return null
    return { cards, totalRemaining }
  } catch {
    return null
  }
}

function saveCachedCardBalance(balance: CardBalance) {
  localStorage.setItem(CARD_BALANCE_CACHE_KEY, JSON.stringify({
    ...balance,
    cachedAt: Date.now(),
  }))
}

export function hasStoredCards() {
  return readStoredCardCodes().length > 0
}

export async function readClientConfig(): Promise<ClientConfig> {
  const response = await fetch('/api/config', { cache: 'no-store' })
  if (!response.ok) return { purchaseUrl: '', costPerGeneration: 1, announcementText: '' }
  const data = await response.json()
  return {
    purchaseUrl: String(data.purchaseUrl || ''),
    costPerGeneration: Number(data.costPerGeneration || 1),
    announcementText: String(data.announcementText || ''),
  }
}

export async function addCardCode(code: string): Promise<PublicCard> {
  const normalized = normalizeCardCode(code)
  if (!normalized) throw new Error('卡密格式不正确')
  const response = await fetch('/api/cards/add', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({ code: normalized }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok || !data.ok) throw new Error(data.error || '卡密验证失败')
  saveStoredCardCodes([...readStoredCardCodes(), normalized])
  return data.card
}

export async function readCardBalance(): Promise<CardBalance> {
  const response = await fetch('/api/cards/balance', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({ codes: readStoredCardCodes() }),
  })
  if (!response.ok) return { cards: [], totalRemaining: 0 }
  const balance = await response.json()
  saveCachedCardBalance(balance)
  return balance
}

export function createCardsHeaderValue() {
  return JSON.stringify(readStoredCardCodes())
}
