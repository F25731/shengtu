import http from 'node:http'
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomInt, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import initSqlJs from 'sql.js'

const require = createRequire(import.meta.url)
const appRoot = normalize(join(fileURLToPath(new URL('..', import.meta.url))))
const distRoot = join(appRoot, 'dist')
const dataDir = process.env.YUNYI_DATA_DIR || join(appRoot, 'server', 'data')
const tempImageDir = process.env.YUNYI_TEMP_IMAGE_DIR || join(dataDir, 'temp-images')
const publicBaseUrlOverride = String(process.env.YUNYI_PUBLIC_BASE_URL || '').replace(/\/+$/, '')
const dbPath = process.env.YUNYI_DB_PATH || join(dataDir, 'yunyi.sqlite')
const host = process.env.HOST || '0.0.0.0'
const port = Number(process.env.PORT || 3000)
const adminPassword = process.env.YUNYI_ADMIN_PASSWORD || 'admin123456'
const adminToken = createHash('sha256').update(`yunyi-admin:${adminPassword}`).digest('hex')
const cardAlphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const proxyJobs = new Map()
const proxyJobTtlMs = 6 * 60 * 60 * 1000
const ai6800PollIntervalMs = 5 * 1000
const ai6800MaxPollMs = 30 * 60 * 1000
const defaultAnnouncementText = '公告：ChatGPT 审核较严格，涉及版权角色、敏感信息或不合规内容可能生成失败；失败不会扣次数，请调整提示词后重试。'
const defaultGateNoticeText = '云逸生图支持 ChatGPT、Gemini 与 Grok 生图，可上传参考图继续修改，并保留历史记录用于预览和下载。请输入卡密开始使用。'

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
}

mkdirSync(dataDir, { recursive: true })
mkdirSync(tempImageDir, { recursive: true })

const SQL = await initSqlJs({
  locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm'),
})

let db = existsSync(dbPath)
  ? new SQL.Database(readFileSync(dbPath))
  : new SQL.Database()

initDatabase()

function nowIso() {
  return new Date().toISOString()
}

function saveDb() {
  writeFileSync(dbPath, Buffer.from(db.export()))
}

function run(sql, params = []) {
  db.run(sql, params)
  saveDb()
}

function selectAll(sql, params = []) {
  const stmt = db.prepare(sql)
  stmt.bind(params)
  const rows = []
  while (stmt.step()) rows.push(stmt.getAsObject())
  stmt.free()
  return rows
}

function selectOne(sql, params = []) {
  return selectAll(sql, params)[0] || null
}

function initDatabase() {
  db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cards (
      code TEXT PRIMARY KEY,
      total_credits INTEGER NOT NULL,
      used_credits INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      batch_name TEXT,
      activated_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS usage_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      card_code TEXT,
      prompt TEXT,
      cost_credits INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `)
  const defaults = {
    purchase_url: process.env.YUNYI_PURCHASE_URL || '',
    backgrace_api_url: process.env.BACKGRACE_API_URL || 'https://backgrace.com/v1',
    backgrace_api_key: process.env.BACKGRACE_API_KEY || '',
    ai6800_api_url: process.env.AI6800_API_URL || 'https://api.ai6800.com',
    ai6800_api_key: process.env.AI6800_API_KEY || '',
    chatgpt_provider: process.env.YUNYI_CHATGPT_PROVIDER || 'backgrace',
    gemini_provider: process.env.YUNYI_GEMINI_PROVIDER || 'backgrace',
    grok_provider: process.env.YUNYI_GROK_PROVIDER || 'ai6800',
    image_model: process.env.YUNYI_IMAGE_MODEL || 'gpt-image-2',
    gemini_model: process.env.YUNYI_GEMINI_MODEL || 'gemini-3-pro-image-preview',
    grok_model: process.env.YUNYI_GROK_MODEL || 'grok-4.2-image',
    cost_per_generation: process.env.YUNYI_COST_PER_GENERATION || '1',
    max_concurrent_generations: process.env.YUNYI_MAX_CONCURRENT_GENERATIONS || '20',
    announcement_text: process.env.YUNYI_ANNOUNCEMENT_TEXT || defaultAnnouncementText,
    gate_notice_text: process.env.YUNYI_GATE_NOTICE_TEXT || defaultGateNoticeText,
    blocked_words: process.env.YUNYI_BLOCKED_WORDS || '',
  }
  for (const [key, value] of Object.entries(defaults)) {
    const existing = selectOne('SELECT key FROM settings WHERE key = ?', [key])
    if (!existing) db.run('INSERT INTO settings (key, value) VALUES (?, ?)', [key, value])
  }
  const existingModelRoutes = selectOne('SELECT key FROM settings WHERE key = ?', ['model_routes'])
  if (!existingModelRoutes) {
    const settings = Object.fromEntries(Object.entries(defaults))
    for (const row of selectAll('SELECT key, value FROM settings')) settings[row.key] = row.value
    db.run('INSERT INTO settings (key, value) VALUES (?, ?)', ['model_routes', JSON.stringify(buildLegacyModelRoutes(settings))])
  }
  saveDb()
}

function getSettings() {
  const rows = selectAll('SELECT key, value FROM settings')
  return Object.fromEntries(rows.map((row) => [row.key, row.value]))
}

function setSettings(input) {
  const allowed = ['purchase_url', 'backgrace_api_url', 'backgrace_api_key', 'ai6800_api_url', 'ai6800_api_key', 'chatgpt_provider', 'gemini_provider', 'grok_provider', 'image_model', 'gemini_model', 'grok_model', 'cost_per_generation', 'max_concurrent_generations', 'announcement_text', 'gate_notice_text', 'blocked_words', 'model_routes']
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(input, key)) {
      const value = key === 'model_routes' && typeof input[key] !== 'string'
        ? JSON.stringify(input[key])
        : String(input[key] ?? '')
      run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, value])
    }
  }
}

const routeKinds = ['chatgpt', 'gemini', 'grok']
const routeProtocols = new Set(['openai-images', 'openai-chat', 'gemini-generate-content', 'ai6800-media'])
const uploadModes = new Set(['base64', 'url'])

function normalizeRouteProtocol(value, fallback = 'openai-images') {
  const normalized = String(value || '').trim()
  return routeProtocols.has(normalized) ? normalized : fallback
}

function normalizeUploadMode(value, fallback = 'base64') {
  const normalized = String(value || '').trim()
  return uploadModes.has(normalized) ? normalized : fallback
}

function makeRouteId(kind, name, index) {
  const base = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `${kind}-${base || `route-${index + 1}`}`
}

function buildLegacyModelRoutes(settings = {}) {
  const backgraceApiUrl = String(settings.backgrace_api_url || process.env.BACKGRACE_API_URL || 'https://backgrace.com/v1').replace(/\/+$/, '')
  const ai6800ApiUrl = String(settings.ai6800_api_url || process.env.AI6800_API_URL || 'https://api.ai6800.com').replace(/\/+$/, '')
  const backgraceApiKey = String(settings.backgrace_api_key || process.env.BACKGRACE_API_KEY || '')
  const ai6800ApiKey = String(settings.ai6800_api_key || process.env.AI6800_API_KEY || '')
  const chatgptProvider = normalizeProviderId(settings.chatgpt_provider || process.env.YUNYI_CHATGPT_PROVIDER || 'backgrace', 'backgrace')
  const geminiProvider = normalizeProviderId(settings.gemini_provider || process.env.YUNYI_GEMINI_PROVIDER || 'backgrace', 'backgrace')
  const grokProvider = normalizeProviderId(settings.grok_provider || process.env.YUNYI_GROK_PROVIDER || 'ai6800', 'ai6800')
  const imageModel = String(settings.image_model || process.env.YUNYI_IMAGE_MODEL || 'gpt-image-2')
  const geminiModel = String(settings.gemini_model || process.env.YUNYI_GEMINI_MODEL || 'gemini-3-pro-image-preview')
  const grokModel = String(settings.grok_model || process.env.YUNYI_GROK_MODEL || 'grok-4.2-image')

  return {
    chatgpt: {
      defaultRouteId: chatgptProvider === 'ai6800' ? 'chatgpt-ai6800' : 'chatgpt-backgrace',
      routes: [
        { id: 'chatgpt-backgrace', enabled: true, name: 'BackGrace', protocol: 'openai-images', endpoint: backgraceApiUrl, model: imageModel, apiKey: backgraceApiKey, uploadMode: 'base64' },
        { id: 'chatgpt-ai6800', enabled: true, name: 'ai6800', protocol: 'ai6800-media', endpoint: ai6800ApiUrl, model: imageModel, apiKey: ai6800ApiKey, uploadMode: 'url' },
      ],
    },
    gemini: {
      defaultRouteId: geminiProvider === 'ai6800' ? 'gemini-ai6800' : 'gemini-backgrace',
      routes: [
        { id: 'gemini-backgrace', enabled: true, name: 'BackGrace', protocol: 'openai-chat', endpoint: backgraceApiUrl, model: geminiModel, apiKey: backgraceApiKey, uploadMode: 'base64' },
        { id: 'gemini-ai6800', enabled: true, name: 'ai6800', protocol: 'ai6800-media', endpoint: ai6800ApiUrl, model: geminiModel, apiKey: ai6800ApiKey, uploadMode: 'url' },
      ],
    },
    grok: {
      defaultRouteId: grokProvider === 'backgrace' ? 'grok-backgrace' : 'grok-ai6800',
      routes: [
        { id: 'grok-ai6800', enabled: true, name: 'ai6800', protocol: 'ai6800-media', endpoint: ai6800ApiUrl, model: grokModel, apiKey: ai6800ApiKey, uploadMode: 'url' },
        { id: 'grok-backgrace', enabled: false, name: 'BackGrace', protocol: 'openai-images', endpoint: backgraceApiUrl, model: grokModel, apiKey: backgraceApiKey, uploadMode: 'base64' },
      ],
    },
  }
}

function parseModelRoutesConfig(input) {
  if (!input) return null
  if (typeof input === 'object') return input
  try {
    return JSON.parse(String(input))
  } catch {
    return null
  }
}

function normalizeModelRoutesConfig(input, legacySettings = {}) {
  const parsed = parseModelRoutesConfig(input)
  const fallback = buildLegacyModelRoutes(legacySettings)
  const output = {}
  for (const kind of routeKinds) {
    const source = parsed?.[kind] && typeof parsed[kind] === 'object' ? parsed[kind] : fallback[kind]
    const rawRoutes = Array.isArray(source.routes) ? source.routes : fallback[kind].routes
    const seen = new Set()
    const routes = rawRoutes.slice(0, 5).map((route, index) => {
      const name = String(route?.name || `线路 ${index + 1}`).trim()
      let id = String(route?.id || makeRouteId(kind, name, index)).trim()
      if (!id || seen.has(id)) id = `${makeRouteId(kind, name, index)}-${index + 1}`
      seen.add(id)
      return {
        id,
        enabled: route?.enabled !== false,
        name,
        protocol: normalizeRouteProtocol(route?.protocol, fallback[kind].routes[index]?.protocol || 'openai-images'),
        endpoint: String(route?.endpoint || '').trim(),
        model: String(route?.model || '').trim(),
        apiKey: String(route?.apiKey || ''),
        uploadMode: normalizeUploadMode(route?.uploadMode, fallback[kind].routes[index]?.uploadMode || 'base64'),
      }
    })
    if (!routes.length) routes.push(...fallback[kind].routes.slice(0, 1))
    const requestedDefault = String(source.defaultRouteId || '')
    const defaultRouteId = routes.some((route) => route.id === requestedDefault)
      ? requestedDefault
      : (routes.find((route) => route.enabled)?.id || routes[0]?.id || '')
    output[kind] = { defaultRouteId, routes }
  }
  return output
}

function getModelRoutes(settings = getSettings()) {
  return normalizeModelRoutesConfig(settings.model_routes, settings)
}

function maskModelRoutesConfig(config) {
  const output = {}
  for (const kind of routeKinds) {
    output[kind] = {
      defaultRouteId: config[kind]?.defaultRouteId || '',
      routes: (config[kind]?.routes || []).map((route) => ({
        ...route,
        apiKey: route.apiKey ? '********' : '',
      })),
    }
  }
  return output
}

function preserveMaskedModelRouteKeys(inputConfig, currentConfig) {
  const output = normalizeModelRoutesConfig(inputConfig)
  for (const kind of routeKinds) {
    for (const route of output[kind].routes) {
      if (route.apiKey !== '********') continue
      const current = currentConfig[kind]?.routes?.find((item) => item.id === route.id)
      route.apiKey = current?.apiKey || ''
    }
  }
  return output
}

function getDefaultModelRoute(config, kind) {
  const group = config?.[kind]
  if (!group) return null
  return group.routes.find((route) => route.id === group.defaultRouteId) || group.routes.find((route) => route.enabled) || group.routes[0] || null
}

function providerFromModelRoute(route) {
  const endpoint = String(route?.endpoint || '').toLowerCase()
  if (route?.protocol === 'ai6800-media' || endpoint.includes('ai6800')) return 'ai6800'
  return 'backgrace'
}

function deriveLegacySettingsFromModelRoutes(config) {
  const chatgptRoute = getDefaultModelRoute(config, 'chatgpt')
  const geminiRoute = getDefaultModelRoute(config, 'gemini')
  const grokRoute = getDefaultModelRoute(config, 'grok')
  const defaultRoutes = [chatgptRoute, geminiRoute, grokRoute].filter(Boolean)
  const backgraceRoute = defaultRoutes.find((route) => providerFromModelRoute(route) === 'backgrace' && route.apiKey)
    || defaultRoutes.find((route) => providerFromModelRoute(route) === 'backgrace')
  const ai6800Route = defaultRoutes.find((route) => providerFromModelRoute(route) === 'ai6800' && route.apiKey)
    || defaultRoutes.find((route) => providerFromModelRoute(route) === 'ai6800')
  const legacy = {}
  if (chatgptRoute) {
    legacy.chatgpt_provider = providerFromModelRoute(chatgptRoute)
    legacy.image_model = chatgptRoute.model
  }
  if (geminiRoute) {
    legacy.gemini_provider = providerFromModelRoute(geminiRoute)
    legacy.gemini_model = geminiRoute.model
  }
  if (grokRoute) {
    legacy.grok_provider = providerFromModelRoute(grokRoute)
    legacy.grok_model = grokRoute.model
  }
  if (backgraceRoute) {
    legacy.backgrace_api_url = backgraceRoute.endpoint
    legacy.backgrace_api_key = backgraceRoute.apiKey
  }
  if (ai6800Route) {
    legacy.ai6800_api_url = ai6800Route.endpoint
    legacy.ai6800_api_key = ai6800Route.apiKey
  }
  return legacy
}

function normalizeCardCode(input) {
  const raw = String(input || '')
    .trim()
    .replace(/[—–−]/g, '-')
    .replace(/\s+/g, '')
  const withoutPrefix = raw.replace(/^YunYi-?/i, '')
  const compact = withoutPrefix.replace(/[^a-zA-Z0-9]/g, '').toUpperCase()
  if (compact.length !== 16) return ''
  return `YunYi-${compact.slice(0, 4)}-${compact.slice(4, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}`
}

function generateCardCode() {
  let compact = ''
  for (let i = 0; i < 16; i += 1) compact += cardAlphabet[randomInt(cardAlphabet.length)]
  return normalizeCardCode(`YunYi-${compact}`)
}

function publicCard(row) {
  if (!row) return null
  const remaining = Math.max(0, Number(row.total_credits) - Number(row.used_credits))
  return {
    code: row.code,
    totalCredits: Number(row.total_credits),
    usedCredits: Number(row.used_credits),
    remainingCredits: remaining,
    status: row.status === 'disabled' ? 'disabled' : remaining > 0 ? 'active' : 'depleted',
    batchName: row.batch_name || '',
    activatedAt: row.activated_at || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function getCard(code) {
  return selectOne('SELECT * FROM cards WHERE code = ?', [code])
}

function parseCardsHeader(req) {
  const raw = req.headers['x-yunyi-cards']
  const value = Array.isArray(raw) ? raw.join(',') : String(raw || '')
  let items = []
  try {
    const parsed = JSON.parse(value)
    if (Array.isArray(parsed)) items = parsed
  } catch {
    items = value.split(',')
  }
  return [...new Set(items.map(normalizeCardCode).filter(Boolean))]
}

function getCardsBalance(codes) {
  const busyCodes = getBusyCardCodes(codes)
  const cards = codes
    .map((code) => publicCard(getCard(code)) || { code, totalCredits: 0, usedCredits: 0, remainingCredits: 0, status: 'missing' })
    .map((card) => ({ ...card, busy: busyCodes.has(card.code) }))
  const totalRemaining = cards.reduce((sum, card) => sum + (card.status === 'active' ? card.remainingCredits : 0), 0)
  const hasBusyCard = cards.some((card) => card.busy)
  const availableForGeneration = cards.some((card) => card.status === 'active' && card.remainingCredits > 0 && !card.busy)
  return { cards, totalRemaining, hasBusyCard, availableForGeneration }
}

function deductCredits(codes, cost) {
  for (const code of codes) {
    const card = publicCard(getCard(code))
    if (!card || card.status !== 'active' || card.remainingCredits < cost) continue
    const updatedAt = nowIso()
    db.run(
      'UPDATE cards SET used_credits = used_credits + ?, activated_at = COALESCE(activated_at, ?), updated_at = ? WHERE code = ? AND status != ? AND used_credits + ? <= total_credits',
      [cost, updatedAt, updatedAt, code, 'disabled', cost],
    )
    const changed = db.getRowsModified()
    saveDb()
    if (changed > 0) return code
  }
  return ''
}

function refundCredits(code, cost) {
  if (!code) return
  run(
    'UPDATE cards SET used_credits = MAX(0, used_credits - ?), updated_at = ? WHERE code = ?',
    [cost, nowIso(), code],
  )
}

function insertUsageLog({ cardCode, prompt, cost, status, errorMessage = '' }) {
  const createdAt = nowIso()
  db.run(
    'INSERT INTO usage_logs (card_code, prompt, cost_credits, status, error_message, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [cardCode, prompt || '', cost, status, errorMessage, createdAt, createdAt],
  )
  const id = selectOne('SELECT last_insert_rowid() AS id')?.id
  saveDb()
  return Number(id || 0)
}

function updateUsageLog(id, status, errorMessage = '') {
  if (!id) return
  run('UPDATE usage_logs SET status = ?, error_message = ?, updated_at = ? WHERE id = ?', [status, errorMessage, nowIso(), id])
}

function getUsageStats() {
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const total = selectOne(`
    SELECT
      SUM(CASE WHEN status != 'pending' THEN 1 ELSE 0 END) AS total,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success,
      SUM(CASE WHEN status NOT IN ('success', 'pending') THEN 1 ELSE 0 END) AS failed
    FROM usage_logs
  `) || {}
  const recent = selectOne(`
    SELECT
      SUM(CASE WHEN status != 'pending' THEN 1 ELSE 0 END) AS total,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success,
      SUM(CASE WHEN status NOT IN ('success', 'pending') THEN 1 ELSE 0 END) AS failed
    FROM usage_logs
    WHERE created_at >= ?
  `, [since24h]) || {}
  const normalize = (row) => {
    const totalCount = Number(row.total || 0)
    const successCount = Number(row.success || 0)
    const failedCount = Number(row.failed || 0)
    return {
      total: totalCount,
      success: successCount,
      failed: failedCount,
      successRate: totalCount > 0 ? Math.round((successCount / totalCount) * 10000) / 100 : 0,
    }
  }
  return { all: normalize(total), last24h: normalize(recent) }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    Pragma: 'no-cache',
    Expires: '0',
  })
  res.end(body)
}

function getImageExtFromMime(mime) {
  const normalized = String(mime || '').split(';')[0].trim().toLowerCase()
  if (normalized === 'image/jpeg' || normalized === 'image/jpg') return '.jpg'
  if (normalized === 'image/webp') return '.webp'
  if (normalized === 'image/gif') return '.gif'
  if (normalized === 'image/png') return '.png'
  return '.png'
}

function getPublicBaseUrl(req) {
  if (publicBaseUrlOverride) return publicBaseUrlOverride
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim()
  const forwardedHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim()
  const proto = forwardedProto || (req.socket.encrypted ? 'https' : 'http')
  const requestHost = forwardedHost || String(req.headers.host || `${host}:${port}`)
  return `${proto}://${requestHost}`.replace(/\/+$/, '')
}

function persistTempImageFromDataUrl(dataUrl, publicBaseUrl, tempFiles = []) {
  const image = dataUrlToImagePayload(dataUrl)
  if (!image) return ''
  const ext = getImageExtFromMime(image.mime)
  const filename = `${randomUUID()}${ext}`
  const filePath = normalize(join(tempImageDir, filename))
  if (!filePath.startsWith(tempImageDir)) throw new Error('Invalid temp image path')
  writeFileSync(filePath, Buffer.from(image.b64Json, 'base64'))
  const url = `${publicBaseUrl}/api/temp-images/${filename}`
  tempFiles.push({ path: filePath, url })
  return url
}

function prepareImageStringsForUploadMode(images, route, publicBaseUrl, tempFiles = []) {
  if (route?.uploadMode !== 'url') return images
  return images.map((image) => {
    const text = String(image || '').trim()
    if (/^https?:\/\//i.test(text)) return text
    if (/^data:image\//i.test(text)) return persistTempImageFromDataUrl(text, publicBaseUrl, tempFiles)
    return text
  }).filter(Boolean)
}

function cleanupTempFiles(files = []) {
  for (const file of files) {
    try {
      const filePath = normalize(String(file?.path || ''))
      if (filePath && filePath.startsWith(tempImageDir) && existsSync(filePath)) unlinkSync(filePath)
    } catch (err) {
      console.warn('Failed to clean temp image:', err instanceof Error ? err.message : String(err))
    }
  }
  files.length = 0
}

function cleanupProxyJobs() {
  const now = Date.now()
  for (const [id, job] of proxyJobs.entries()) {
    if (job.expiresAt <= now) {
      cleanupTempFiles(job.tempFiles || [])
      proxyJobs.delete(id)
    }
  }
}

function createProxyJob(initial) {
  cleanupProxyJobs()
  const now = Date.now()
  const job = {
    id: randomUUID(),
    status: 'pending',
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    expiresAt: now + proxyJobTtlMs,
    httpStatus: 202,
    contentType: 'application/json; charset=utf-8',
    body: undefined,
    bodyText: '',
    errorMessage: '',
    tempFiles: [],
    ...initial,
  }
  proxyJobs.set(job.id, job)
  return job
}

function touchProxyJob(job, patch = {}) {
  Object.assign(job, patch, {
    updatedAt: nowIso(),
    expiresAt: Date.now() + proxyJobTtlMs,
  })
}

function isActiveProxyJob(job) {
  return Boolean(job && (job.status === 'pending' || job.status === 'running') && job.expiresAt > Date.now())
}

function getActiveProxyJobs() {
  cleanupProxyJobs()
  return [...proxyJobs.values()].filter(isActiveProxyJob)
}

function getBusyCardCodes(codes = []) {
  const wanted = new Set(codes)
  const busy = new Set()
  if (!wanted.size) return busy
  for (const job of getActiveProxyJobs()) {
    if (job.chargedCard && wanted.has(job.chargedCard)) busy.add(job.chargedCard)
  }
  return busy
}

function getMaxConcurrentProxyJobs(settings) {
  const value = Number(settings.max_concurrent_generations || 0)
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

function parseProxyResponseBody(buffer, contentType) {
  const text = buffer.toString('utf8')
  if (contentType.includes('application/json')) {
    try {
      return { body: JSON.parse(text), bodyText: '' }
    } catch {
      return { body: undefined, bodyText: text }
    }
  }
  return { body: undefined, bodyText: text }
}

function createProxyErrorMessage(prefix, detail) {
  const text = String(detail || '').trim()
  return text ? `${prefix}: ${text}` : prefix
}

const connectionInterruptedMessage = '内容违规或连接中断，请重试'
const streamDisconnectedNeedle = 'stream disconnected before completion'

function extractTextContent(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value
      .map((item) => typeof item === 'string' ? item : item?.text || item?.content || '')
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

function extractProxyProviderMessage(payload) {
  if (!payload || typeof payload !== 'object') return ''
  const record = payload
  if (typeof record.error?.message === 'string') return record.error.message
  if (typeof record.error === 'string') return record.error
  if (typeof record.message === 'string') return record.message
  if (typeof record.detail === 'string') return record.detail
  if (typeof record.output_text === 'string') return record.output_text

  if (Array.isArray(record.choices)) {
    for (const choice of record.choices) {
      const text = extractTextContent(choice?.message?.content) || extractTextContent(choice?.text)
      if (text) return text
    }
  }

  if (Array.isArray(record.output)) {
    for (const item of record.output) {
      const text = extractTextContent(item?.content) || extractTextContent(item?.text)
      if (text) return text
    }
  }

  return ''
}

function isStreamDisconnectedMessage(message) {
  return String(message || '').toLowerCase().includes(streamDisconnectedNeedle)
}

function isLikelyModelRefusalMessage(message) {
  const text = String(message || '').toLowerCase()
  return /policy|safety|safe|content|copyright|disallowed|not allowed|cannot|can't|unable|violate|violation|违规|敏感|安全|版权|无法|不能/.test(text)
}

function getProxyCustomerErrorMessage(parsed, fallbackText) {
  const providerMessage = extractProxyProviderMessage(parsed?.body)
  const rawText = String(fallbackText || parsed?.bodyText || '').trim()
  const candidate = String(providerMessage || rawText || '').trim()
  if (!candidate || isStreamDisconnectedMessage(candidate)) return connectionInterruptedMessage
  if (providerMessage && isLikelyModelRefusalMessage(providerMessage)) return providerMessage
  if (!providerMessage && isLikelyModelRefusalMessage(rawText)) return rawText
  return connectionInterruptedMessage
}

function normalizeProxyParsedError(parsed, customerMessage) {
  return {
    ...parsed,
    body: { error: { message: customerMessage } },
    bodyText: '',
  }
}

function buildRefundedProxyErrorMessage(message, prefix = '生图失败，次数已退回') {
  const text = String(message || '').trim()
  return text === connectionInterruptedMessage ? text : createProxyErrorMessage(prefix, text)
}

function sendText(res, status, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    Pragma: 'no-cache',
    Expires: '0',
  })
  res.end(text)
}

function readBody(req, limit = 80 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function parseJsonBody(buffer) {
  if (!buffer.length) return {}
  return JSON.parse(buffer.toString('utf8'))
}

function extractPrompt(contentType, body) {
  try {
    if (contentType.includes('application/json')) {
      const data = parseJsonBody(body)
      if (typeof data.prompt === 'string') return data.prompt
      if (typeof data.input === 'string') return data.input
      if (Array.isArray(data.input)) {
        return data.input
          .flatMap((item) => Array.isArray(item?.content) ? item.content : [])
          .map((item) => item?.text)
          .filter(Boolean)
          .join('\n')
      }
      if (Array.isArray(data.messages)) {
        return data.messages
          .flatMap((message) => {
            if (typeof message?.content === 'string') return [message.content]
            if (Array.isArray(message?.content)) return message.content.map((item) => item?.text).filter(Boolean)
            return []
          })
          .filter(Boolean)
          .join('\n')
      }
    }
    if (contentType.includes('multipart/form-data')) {
      const text = body.toString('utf8')
      const match = text.match(/name="prompt"\r?\n\r?\n([\s\S]*?)\r?\n--/)
      return match?.[1]?.trim() || ''
    }
  } catch {
    return ''
  }
  return ''
}

function parseBlockedWords(settings) {
  return String(settings.blocked_words || '')
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter((item) => item && !item.startsWith('#'))
}

function findBlockedWord(prompt, settings) {
  const rawPrompt = String(prompt || '').toLowerCase()
  for (const word of parseBlockedWords(settings)) {
    const lowerWord = word.toLowerCase()
    if (lowerWord && rawPrompt.includes(lowerWord)) return word
  }
  return ''
}

function extractImageCount(contentType, body) {
  try {
    if (contentType.includes('application/json')) {
      const data = parseJsonBody(body)
      const direct = Number(data.n)
      if (Number.isFinite(direct) && direct > 0) return Math.floor(direct)
      if (Array.isArray(data.tools)) {
        for (const tool of data.tools) {
          const toolCount = Number(tool?.n)
          if (Number.isFinite(toolCount) && toolCount > 0) return Math.floor(toolCount)
        }
      }
      return 1
    }
    if (contentType.includes('multipart/form-data')) {
      const text = body.toString('utf8')
      const match = text.match(/name="n"\r?\n\r?\n(\d+)/)
      const count = Number(match?.[1])
      if (Number.isFinite(count) && count > 0) return Math.floor(count)
    }
  } catch {
    return 1
  }
  return 1
}

function getTextFieldFromMultipart(contentType, body, fieldName) {
  if (!contentType.includes('multipart/form-data')) return ''
  const text = body.toString('utf8')
  const escaped = fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = text.match(new RegExp(`name="${escaped}"\\r?\\n\\r?\\n([\\s\\S]*?)\\r?\\n--`))
  return match?.[1]?.trim() || ''
}

function parseMultipartBody(contentType, body) {
  const boundary = String(contentType.match(/boundary=([^;]+)/i)?.[1] || '').trim().replace(/^"|"$/g, '')
  const result = { fields: {}, images: [] }
  if (!boundary) return result

  const delimiter = Buffer.from(`--${boundary}`)
  let cursor = body.indexOf(delimiter)
  while (cursor >= 0) {
    const next = body.indexOf(delimiter, cursor + delimiter.length)
    if (next < 0) break
    let part = body.slice(cursor + delimiter.length, next)
    cursor = next
    if (part.length >= 2 && part[0] === 13 && part[1] === 10) part = part.slice(2)
    if (part.length >= 2 && part[part.length - 2] === 13 && part[part.length - 1] === 10) part = part.slice(0, -2)
    const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'))
    if (headerEnd < 0) continue
    const headers = part.slice(0, headerEnd).toString('utf8')
    const value = part.slice(headerEnd + 4)
    const name = headers.match(/name="([^"]+)"/i)?.[1] || ''
    const filename = headers.match(/filename="([^"]*)"/i)?.[1] || ''
    const mime = headers.match(/content-type:\s*([^\r\n]+)/i)?.[1]?.trim() || ''
    if (!name) continue
    if (filename || mime.startsWith('image/')) {
      if (mime.startsWith('image/') && value.length) result.images.push(`data:${mime};base64,${value.toString('base64')}`)
    } else {
      result.fields[name] = value.toString('utf8').trim()
    }
  }
  return result
}

function extractRequestModel(contentType, body) {
  try {
    if (contentType.includes('application/json')) {
      const data = parseJsonBody(body)
      return typeof data.model === 'string' ? data.model : ''
    }
    return getTextFieldFromMultipart(contentType, body, 'model')
  } catch {
    return ''
  }
}

function getProxyModelKind(apiPath, contentType, body) {
  const path = `/${String(apiPath || '').replace(/^\/+/, '')}`
  if (path.includes('/chat/completions')) return 'gemini'
  const model = extractRequestModel(contentType, body).toLowerCase()
  if (model.includes('grok')) return 'grok'
  if (model.includes('gemini')) return 'gemini'
  return 'chatgpt'
}

function normalizeProviderId(value, fallback = 'backgrace') {
  const provider = String(value || '').trim().toLowerCase()
  return provider === 'ai6800' ? 'ai6800' : provider === 'backgrace' ? 'backgrace' : fallback
}

function getModelForKind(settings, kind) {
  if (kind === 'gemini') return String(settings.gemini_model || 'gemini-3-pro-image-preview').trim()
  if (kind === 'grok') return String(settings.grok_model || 'grok-4.2-image').trim()
  return String(settings.image_model || 'gpt-image-2').trim()
}

function getProtocolProvider(route) {
  if (route?.protocol === 'ai6800-media') return 'ai6800'
  if (String(route?.endpoint || '').toLowerCase().includes('ai6800')) return 'ai6800'
  return 'custom'
}

function getSelectedModelRoute(settings, kind) {
  const config = getModelRoutes(settings)
  const route = getDefaultModelRoute(config, kind)
  if (!route) return null
  const apiUrl = String(route.endpoint || '').replace(/\/+$/, '')
  const hydrated = {
    ...route,
    kind,
    provider: getProtocolProvider(route),
    apiUrl,
    apiKey: String(route.apiKey || '').trim(),
    model: String(route.model || getModelForKind(settings, kind)).trim(),
  }
  if (hydrated.protocol === 'ai6800-media') hydrated.apiUrl = getAi6800BaseUrl(hydrated)
  return {
    ...hydrated,
  }
}

function resolveProxyRoute(settings, pathname, contentType, body) {
  const kind = getProxyModelKind(pathname, contentType, body)
  const configuredRoute = getSelectedModelRoute(settings, kind)
  if (configuredRoute) return configuredRoute
  const providerSetting = kind === 'gemini'
    ? settings.gemini_provider
    : kind === 'grok'
      ? settings.grok_provider
      : settings.chatgpt_provider
  const provider = normalizeProviderId(providerSetting, kind === 'grok' ? 'ai6800' : 'backgrace')
  if (provider === 'ai6800') {
    return {
      kind,
      provider,
      model: getModelForKind(settings, kind),
      apiUrl: String(settings.ai6800_api_url || 'https://api.ai6800.com').replace(/\/+$/, ''),
      apiKey: String(settings.ai6800_api_key || '').trim(),
    }
  }
  return {
    kind,
    provider: 'backgrace',
    model: getModelForKind(settings, kind),
    apiUrl: String(settings.backgrace_api_url || 'https://backgrace.com/v1').replace(/\/+$/, ''),
    apiKey: String(settings.backgrace_api_key || '').trim(),
  }
}

function isFullProxyEndpoint(endpoint) {
  try {
    const url = new URL(endpoint)
    return /\/(images\/generations|chat\/completions|media\/generate|v1beta\/models\/[^/]+:(?:streamGenerateContent|generateContent))$/i.test(url.pathname)
  } catch {
    return false
  }
}

function buildOpenAiProxyTargetUrl(route, pathname) {
  let endpoint = String(route.apiUrl || '').replace(/\/+$/, '')
  if (isFullProxyEndpoint(endpoint)) return endpoint
  try {
    const url = new URL(endpoint)
    const modelSegment = `/${encodeURIComponent(String(route.model || '')).replace(/%20/g, '+')}`
    const rawModelSegment = `/${String(route.model || '')}`
    if (route.model && (url.pathname.endsWith(modelSegment) || url.pathname.endsWith(rawModelSegment))) {
      url.pathname = url.pathname.slice(0, -rawModelSegment.length) || '/'
      endpoint = url.toString().replace(/\/+$/, '')
    }
  } catch {
    // Keep the original endpoint if it is not a URL.
  }
  const apiPath = pathname.replace(/^\/api-proxy\/(?:v1\/?)?/, '')
  return `${endpoint}/${apiPath}`
}

function getAi6800BaseUrl(route) {
  const endpoint = String(route.apiUrl || 'https://api.ai6800.com').replace(/\/+$/, '')
  return endpoint
    .replace(/\/v1\/media\/generate$/i, '')
    .replace(/\/v1\/media\/status$/i, '')
}

function imageStringToGeminiPart(value) {
  const text = String(value || '').trim()
  const data = dataUrlToImagePayload(text)
  if (data) return { inlineData: { mimeType: data.mime, data: data.b64Json } }
  if (/^https?:\/\//i.test(text)) return { fileData: { fileUri: text } }
  return null
}

function buildGeminiGenerateContentBody(contentType, body, prompt, route, publicBaseUrl, tempFiles) {
  const multipart = contentType.includes('multipart/form-data') ? parseMultipartBody(contentType, body) : { images: [] }
  const jsonData = readJsonRequestData(contentType, body)
  const params = getRequestParams(contentType, body)
  const images = prepareImageStringsForUploadMode([
    ...collectImageStrings(jsonData.images),
    ...collectImageStrings(jsonData.input),
    ...collectImageStrings(jsonData.messages),
    ...multipart.images,
  ].slice(0, 14), route, publicBaseUrl, tempFiles)
  const parts = [{ text: prompt }, ...images.map(imageStringToGeminiPart).filter(Boolean)]
  const size = String(params.size || 'auto')
  return Buffer.from(JSON.stringify({
    contents: [{ role: 'user', parts }],
    generationConfig: {
      imageConfig: { aspectRatio: String(params.aspectRatio || getGeminiAspectRatio(size)) },
      responseModalities: ['IMAGE', 'TEXT'],
    },
  }))
}

function normalizeGeminiGenerateContentParsed(parsed) {
  const payload = parsed?.body
  if (!payload || typeof payload !== 'object') return parsed
  const images = []
  const walk = (value) => {
    if (!value) return
    if (Array.isArray(value)) {
      for (const item of value) walk(item)
      return
    }
    if (typeof value !== 'object') return
    const inline = value.inlineData || value.inline_data
    const data = inline?.data
    if (typeof data === 'string') {
      images.push({
        mime: inline.mimeType || inline.mime_type || 'image/png',
        b64Json: data,
      })
    }
    for (const item of Object.values(value)) walk(item)
  }
  walk(payload)
  if (!images.length) return parsed
  return {
    body: {
      choices: [
        {
          message: {
            role: 'assistant',
            content: images.map((item) => `![image](data:${item.mime};base64,${item.b64Json})`).join('\n'),
          },
        },
      ],
    },
    bodyText: '',
  }
}

function rewriteDataUrlsForUploadMode(value, route, publicBaseUrl, tempFiles) {
  if (route?.uploadMode !== 'url') return value
  if (typeof value === 'string') {
    const text = value.trim()
    if (/^data:image\//i.test(text)) return persistTempImageFromDataUrl(text, publicBaseUrl, tempFiles)
    return value
  }
  if (Array.isArray(value)) {
    return value.map((item) => rewriteDataUrlsForUploadMode(item, route, publicBaseUrl, tempFiles))
  }
  if (value && typeof value === 'object') {
    const next = {}
    for (const [key, item] of Object.entries(value)) {
      next[key] = rewriteDataUrlsForUploadMode(item, route, publicBaseUrl, tempFiles)
    }
    return next
  }
  return value
}

function buildProxyBody(contentType, body, settings, apiPath, routeOrKind = '', publicBaseUrl = '', tempFiles = []) {
  const route = typeof routeOrKind === 'object' && routeOrKind ? routeOrKind : null
  const modelKind = route?.kind || routeOrKind || ''
  const model = route?.model || getModelForKind(settings, modelKind)
  const prompt = extractPrompt(contentType, body)
  if (route?.protocol === 'gemini-generate-content') return buildGeminiGenerateContentBody(contentType, body, prompt, route, publicBaseUrl, tempFiles)
  if (!contentType.includes('application/json')) return body
  try {
    const data = rewriteDataUrlsForUploadMode(parseJsonBody(body), route, publicBaseUrl, tempFiles)
    const path = `/${String(apiPath || '').replace(/^\/+/, '')}`
    if (path.includes('/chat/completions') || route?.protocol === 'openai-chat') {
      if (model) data.model = model
    } else if (model) {
      data.model = model
    }
    delete data.yunyi_params
    if (path.includes('/images/') || route?.protocol === 'openai-images') data.response_format = 'b64_json'
    return Buffer.from(JSON.stringify(data))
  } catch {
    return body
  }
}

function requireAdmin(req, res) {
  const header = String(req.headers.authorization || '')
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  if (token && token === adminToken) return true
  sendJson(res, 401, { error: '未授权' })
  return false
}

function serveStatic(req, res, pathname) {
  let target = pathname === '/admin' ? join(appRoot, 'server', 'admin.html') : join(distRoot, pathname)
  target = normalize(target)
  const root = pathname === '/admin' ? join(appRoot, 'server') : distRoot
  if (!target.startsWith(root)) {
    sendText(res, 403, 'Forbidden')
    return
  }
  try {
    const info = statSync(target)
    if (info.isDirectory()) target = join(target, 'index.html')
  } catch {
    target = join(distRoot, 'index.html')
  }
  const type = mimeTypes[extname(target)] || 'application/octet-stream'
  res.writeHead(200, {
    'Content-Type': type,
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    Pragma: 'no-cache',
    Expires: '0',
  })
  createReadStream(target).on('error', () => sendText(res, 404, 'Not found')).pipe(res)
}

function serveTempImage(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { error: 'Method not allowed' })
    return
  }
  const match = pathname.match(/^\/api\/temp-images\/([a-f0-9-]+\.(?:png|jpe?g|webp|gif))$/i)
  if (!match) {
    sendJson(res, 404, { error: 'Not found' })
    return
  }
  const filePath = normalize(join(tempImageDir, match[1]))
  if (!filePath.startsWith(tempImageDir) || !existsSync(filePath) || !statSync(filePath).isFile()) {
    sendJson(res, 404, { error: 'Not found' })
    return
  }
  res.writeHead(200, {
    'Content-Type': mimeTypes[extname(filePath).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
  })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  createReadStream(filePath).pipe(res)
}

async function handleImageProxy(req, res, pathname) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: { message: 'Method not allowed' } })
    return
  }
  const settings = getSettings()
  const apiKey = String(settings.backgrace_api_key || '').trim()
  const apiUrl = String(settings.backgrace_api_url || 'https://backgrace.com/v1').replace(/\/+$/, '')
  const baseCost = Math.max(1, Number(settings.cost_per_generation || 1))
  if (!apiKey) {
    sendJson(res, 503, { error: { message: '生图服务暂未完成后台配置' } })
    return
  }

  const contentType = String(req.headers['content-type'] || '')
  const body = await readBody(req)
  const prompt = extractPrompt(contentType, body)
  const imageCount = Math.max(1, extractImageCount(contentType, body))
  const cost = baseCost * imageCount

  const codes = parseCardsHeader(req)
  if (!codes.length) {
    sendJson(res, 402, { error: { message: '请先输入卡密' } })
    return
  }
  const blockedWord = findBlockedWord(prompt, settings)
  if (blockedWord) {
    sendJson(res, 400, {
      error: { message: '提示词包含平台不支持的内容，请调整后再提交' },
      code: 'prompt_blocked',
      balance: getCardsBalance(codes),
    })
    return
  }

  const maxConcurrentJobs = getMaxConcurrentProxyJobs(settings)
  const activeJobs = getActiveProxyJobs()
  if (maxConcurrentJobs > 0 && activeJobs.length >= maxConcurrentJobs) {
    sendJson(res, 429, {
      error: { message: '当前生成队列较忙，请稍后再试' },
      code: 'server_busy',
      balance: getCardsBalance(codes),
    })
    return
  }

  const busyCodes = getBusyCardCodes(codes)
  const availableCodes = codes.filter((code) => !busyCodes.has(code))
  if (!availableCodes.length && busyCodes.size > 0) {
    sendJson(res, 429, {
      error: { message: '当前卡密已有任务正在生成，请完成后再提交' },
      code: 'card_busy',
      balance: getCardsBalance(codes),
    })
    return
  }

  const chargedCard = deductCredits(availableCodes, cost)
  if (!chargedCard) {
    const balance = getCardsBalance(codes)
    if (busyCodes.size > 0 && balance.cards.some((card) => card.busy && card.remainingCredits >= cost)) {
      sendJson(res, 429, {
        error: { message: '当前卡密已有任务正在生成，请完成后再提交' },
        code: 'card_busy',
        balance,
      })
      return
    }
    sendJson(res, 402, { error: { message: '卡密次数不足，请购买或添加卡密' } })
    return
  }

  const logId = insertUsageLog({ cardCode: chargedCard, prompt, cost, status: 'pending' })

  const controller = new AbortController()
  const timeoutSeconds = Math.max(1, Number(settings.request_timeout_seconds || 300))
  let abortMessage = ''
  let responseCompleted = false
  const abortProxy = (message) => {
    if (responseCompleted || controller.signal.aborted) return
    abortMessage = message
    controller.abort()
  }
  const timeoutId = setTimeout(() => {
    abortProxy(`请求超时：超过 ${timeoutSeconds} 秒仍未完成`)
  }, timeoutSeconds * 1000)
  res.on('close', () => {
    if (!responseCompleted) abortProxy('客户端已断开连接或前端请求超时')
  })

  try {
    const apiPath = pathname.replace(/^\/api-proxy\/(?:v1\/?)?/, '')
    const targetUrl = `${apiUrl}/${apiPath}`
    const proxyBody = buildProxyBody(contentType, body, settings, pathname)
    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': contentType || 'application/json',
        Accept: String(req.headers.accept || 'application/json'),
      },
      body: proxyBody,
      signal: controller.signal,
    })
    let responseBuffer = Buffer.from(await response.arrayBuffer())
    let responseType = response.headers.get('content-type') || 'application/json; charset=utf-8'
    if (!response.ok) {
      const rawDetail = responseBuffer.toString('utf8').slice(0, 2000)
      const parsed = parseProxyResponseBody(responseBuffer, responseType)
      const detail = getProxyCustomerErrorMessage(parsed, rawDetail)
      refundCredits(chargedCard, cost)
      updateUsageLog(logId, 'refunded', detail)
      responseType = 'application/json; charset=utf-8'
      responseBuffer = Buffer.from(JSON.stringify({ error: { message: detail } }))
    } else {
      updateUsageLog(logId, 'success')
    }
    res.writeHead(response.status, {
      'Content-Type': responseType,
      'Cache-Control': 'no-store',
      'X-YunYi-Balance': String(getCardsBalance(codes).totalRemaining),
    })
    responseCompleted = true
    res.end(responseBuffer)
  } catch (err) {
    refundCredits(chargedCard, cost)
    const rawMessage = abortMessage || (err instanceof Error ? err.message : String(err))
    const message = isStreamDisconnectedMessage(rawMessage) ? connectionInterruptedMessage : rawMessage
    updateUsageLog(logId, 'refunded', message)
    if (!res.destroyed && !res.writableEnded) {
      responseCompleted = true
      sendJson(res, 502, { error: { message } })
      return
    }
  } finally {
    clearTimeout(timeoutId)
  }
}

async function handleImageProxyTaskMode(req, res, pathname) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: { message: 'Method not allowed' } })
    return
  }
  const settings = getSettings()
  const baseCost = Math.max(1, Number(settings.cost_per_generation || 1))

  const contentType = String(req.headers['content-type'] || '')
  const body = await readBody(req)
  const route = resolveProxyRoute(settings, pathname, contentType, body)
  if (!route.apiKey) {
    const providerName = route.name || route.provider || '当前线路'
    sendJson(res, 503, { error: { message: `生图服务暂未完成后台配置，请填写 ${providerName} API Key 后再试` } })
    return
  }
  if (!route.apiUrl) {
    sendJson(res, 503, { error: { message: `生图服务暂未完成后台配置，请填写 ${route.name || '当前线路' } 调用地址` } })
    return
  }
  const prompt = extractPrompt(contentType, body)
  const imageCount = Math.max(1, extractImageCount(contentType, body))
  const cost = baseCost * imageCount
  const codes = parseCardsHeader(req)
  if (!codes.length) {
    sendJson(res, 402, { error: { message: '请先输入卡密' } })
    return
  }

  const blockedWord = findBlockedWord(prompt, settings)
  if (blockedWord) {
    sendJson(res, 400, {
      error: { message: '提示词包含平台不支持的内容，请调整后再提交' },
      code: 'prompt_blocked',
      balance: getCardsBalance(codes),
    })
    return
  }

  const maxConcurrentJobs = getMaxConcurrentProxyJobs(settings)
  const activeJobs = getActiveProxyJobs()
  if (maxConcurrentJobs > 0 && activeJobs.length >= maxConcurrentJobs) {
    sendJson(res, 429, {
      error: { message: '当前生成队列较忙，请稍后再试' },
      code: 'server_busy',
      balance: getCardsBalance(codes),
    })
    return
  }

  const busyCodes = getBusyCardCodes(codes)
  const availableCodes = codes.filter((code) => !busyCodes.has(code))
  if (!availableCodes.length && busyCodes.size > 0) {
    sendJson(res, 429, {
      error: { message: '当前卡密已有任务正在生成，请完成后再提交' },
      code: 'card_busy',
      balance: getCardsBalance(codes),
    })
    return
  }

  const chargedCard = deductCredits(availableCodes, cost)
  if (!chargedCard) {
    const balance = getCardsBalance(codes)
    if (busyCodes.size > 0 && balance.cards.some((card) => card.busy && card.remainingCredits >= cost)) {
      sendJson(res, 429, {
        error: { message: '当前卡密已有任务正在生成，请完成后再提交' },
        code: 'card_busy',
        balance,
      })
      return
    }
    sendJson(res, 402, { error: { message: '卡密次数不足，请购买或添加卡密' } })
    return
  }

  const logId = insertUsageLog({ cardCode: chargedCard, prompt, cost, status: 'pending' })
  const job = createProxyJob({ logId, chargedCard, codes, cost, prompt })
  const publicBaseUrl = getPublicBaseUrl(req)

  sendJson(res, 202, {
    ok: true,
    taskId: job.id,
    status: job.status,
    pollUrl: `/api-proxy/tasks/${job.id}`,
    balance: getCardsBalance(codes),
  })

  const runner = route.protocol === 'ai6800-media' ? runAi6800ProxyJob : runImageProxyJob
  runner(job, {
    reqAccept: String(req.headers.accept || 'application/json'),
    settings,
    route,
    pathname,
    contentType,
    body,
    publicBaseUrl,
  }).catch((err) => {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`YunYi proxy job ${job.id} failed unexpectedly:`, message)
  })
}

async function runImageProxyJob(job, { reqAccept, settings, route, pathname, contentType, body, publicBaseUrl }) {
  const { chargedCard, codes, cost, logId } = job

  try {
    touchProxyJob(job, { status: 'running' })
    const targetUrl = buildOpenAiProxyTargetUrl(route, pathname)
    const proxyBody = buildProxyBody(contentType, body, settings, pathname, route, publicBaseUrl, job.tempFiles)
    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${route.apiKey}`,
        'Content-Type': route.protocol === 'gemini-generate-content' ? 'application/json' : (contentType || 'application/json'),
        Accept: reqAccept,
      },
      body: proxyBody,
    })
    const responseBuffer = Buffer.from(await response.arrayBuffer())
    const responseType = response.headers.get('content-type') || 'application/json; charset=utf-8'
    let parsed = parseProxyResponseBody(responseBuffer, responseType)

    if (!response.ok) {
      const rawDetail = responseBuffer.toString('utf8').slice(0, 2000)
      const detail = getProxyCustomerErrorMessage(parsed, rawDetail)
      parsed = normalizeProxyParsedError(parsed, detail)
      refundCredits(chargedCard, cost)
      updateUsageLog(logId, 'refunded', detail)
      touchProxyJob(job, {
        status: 'error',
        httpStatus: response.status,
        contentType: responseType,
        ...parsed,
        errorMessage: detail,
        balance: getCardsBalance(codes),
      })
      return
    }

    if (route.protocol === 'gemini-generate-content') parsed = normalizeGeminiGenerateContentParsed(parsed)
    updateUsageLog(logId, 'success')
    touchProxyJob(job, {
      status: 'success',
      httpStatus: response.status,
      contentType: responseType,
      ...parsed,
      balance: getCardsBalance(codes),
    })
  } catch (err) {
    refundCredits(chargedCard, cost)
    const rawMessage = err instanceof Error ? err.message : String(err)
    const message = isStreamDisconnectedMessage(rawMessage) ? connectionInterruptedMessage : rawMessage
    updateUsageLog(logId, 'refunded', message)
    touchProxyJob(job, {
      status: 'error',
      httpStatus: 502,
      contentType: 'application/json; charset=utf-8',
      body: { error: { message: buildRefundedProxyErrorMessage(message) } },
      bodyText: '',
      errorMessage: message,
      balance: getCardsBalance(codes),
    })
  } finally {
    cleanupTempFiles(job.tempFiles || [])
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function extractTaskIdFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return ''
  const direct = payload.task_id ?? payload.taskId ?? payload.id
  if (direct != null && String(direct).trim()) return String(direct).trim()
  for (const value of Object.values(payload)) {
    if (value && typeof value === 'object') {
      const found = extractTaskIdFromPayload(value)
      if (found) return found
    }
  }
  return ''
}

function isAi6800SuccessCode(code) {
  const value = String(code ?? '').trim().toLowerCase()
  if (!value) return true
  return value === '0' || value === '200' || value === 'success' || value === 'ok'
}

function collectImageStrings(value, output = []) {
  if (!value) return output
  if (typeof value === 'string') {
    if (/^(data:image\/|https?:\/\/)/i.test(value.trim())) output.push(value.trim())
    return output
  }
  if (Array.isArray(value)) {
    for (const item of value) collectImageStrings(item, output)
    return output
  }
  if (typeof value === 'object') {
    for (const item of Object.values(value)) collectImageStrings(item, output)
  }
  return output
}

function extractAi6800ResultUrls(payload) {
  return [...new Set(collectImageStrings(payload))]
}

function readJsonRequestData(contentType, body) {
  if (!contentType.includes('application/json')) return {}
  try {
    return parseJsonBody(body)
  } catch {
    return {}
  }
}

function getRequestParams(contentType, body) {
  if (contentType.includes('application/json')) {
    const data = readJsonRequestData(contentType, body)
    return data.yunyi_params && typeof data.yunyi_params === 'object' ? data.yunyi_params : data
  }
  return parseMultipartBody(contentType, body).fields
}

function parseSizeRatio(size) {
  const match = String(size || '').match(/^(\d+)x(\d+)$/)
  if (!match) return null
  const width = Number(match[1])
  const height = Number(match[2])
  if (!width || !height) return null
  return { width, height, ratio: width / height }
}

function getGeminiAspectRatio(size) {
  const parsed = parseSizeRatio(size)
  if (!parsed) return '1:1'
  const options = [
    ['1:1', 1],
    ['2:3', 2 / 3],
    ['3:2', 3 / 2],
    ['3:4', 3 / 4],
    ['4:3', 4 / 3],
    ['9:16', 9 / 16],
    ['16:9', 16 / 9],
  ]
  return options.reduce((best, item) =>
    Math.abs(item[1] - parsed.ratio) < Math.abs(best[1] - parsed.ratio) ? item : best,
  )[0]
}

function getGeminiImageSize(size, quality) {
  const parsed = parseSizeRatio(size)
  if (!parsed) return quality === 'high' ? '2K' : '1K'
  const max = Math.max(parsed.width, parsed.height)
  if (max >= 2800) return '4K'
  if (max >= 1600) return '2K'
  return '1K'
}

function getGrokSize(size) {
  const allowed = new Set([
    '1024x1024', '1080x1080', '1200x1200', '2048x2048', '2160x2160',
    '1280x720', '1366x768', '1600x900', '1920x1080', '2048x1152', '2560x1440',
    '1024x768', '1280x960', '2048x1536', '720x1280', '768x1366', '900x1600',
    '1080x1920', '1440x2560',
  ])
  const text = String(size || '')
  if (allowed.has(text)) return text
  const parsed = parseSizeRatio(text)
  if (!parsed) return '1024x1024'
  if (parsed.ratio > 1.2) return '1280x720'
  if (parsed.ratio < 0.85) return '720x1280'
  return '1024x1024'
}

function buildAi6800SubmitPayload({ route, contentType, body, prompt, publicBaseUrl, tempFiles }) {
  const params = getRequestParams(contentType, body)
  const multipart = contentType.includes('multipart/form-data') ? parseMultipartBody(contentType, body) : { images: [] }
  const jsonData = readJsonRequestData(contentType, body)
  const images = prepareImageStringsForUploadMode([
    ...collectImageStrings(jsonData.images),
    ...collectImageStrings(jsonData.input),
    ...collectImageStrings(jsonData.messages),
    ...multipart.images,
  ].slice(0, route.kind === 'grok' ? 1 : route.kind === 'gemini' ? 14 : 10), route, publicBaseUrl, tempFiles)
  const size = String(params.size || 'auto')
  const quality = String(params.quality || 'auto')

  if (route.kind === 'gemini') {
    return {
      model: route.model,
      prompt,
      params: {
        aspectRatio: String(params.aspectRatio || getGeminiAspectRatio(size)),
        imageSize: String(params.imageSize || getGeminiImageSize(size, quality)),
        ...(images.length ? { images } : {}),
      },
    }
  }

  if (route.kind === 'grok') {
    return {
      model: route.model,
      prompt,
      size: getGrokSize(size),
      n: 1,
      response_format: 'url',
      ...(images.length ? { images } : {}),
    }
  }

  return {
    model: route.model,
    prompt,
    size,
    quality,
    background: String(params.background || 'opaque'),
    n: Math.max(1, Number(params.n || 1)),
    ...(images.length ? { images } : {}),
  }
}

async function fetchAi6800Json(url, route, options = {}) {
  const headers = {
    Authorization: `Bearer ${route.apiKey}`,
    Accept: 'application/json',
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...(options.headers || {}),
  }
  for (const key of Object.keys(headers)) {
    if (headers[key] == null) delete headers[key]
  }
  const response = await fetch(url, {
    ...options,
    headers,
  })
  const text = await response.text()
  let json = {}
  try {
    json = text ? JSON.parse(text) : {}
  } catch {
    json = { message: text }
  }
  if (!response.ok) {
    const message = getProxyCustomerErrorMessage({ body: json, bodyText: text }, text)
    throw new Error(message)
  }
  if (json && typeof json === 'object' && 'code' in json && !isAi6800SuccessCode(json.code)) {
    throw new Error(String(json.msg || json.message || '中转站请求失败'))
  }
  return json
}

async function pollAi6800Task(route, taskId) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < ai6800MaxPollMs) {
    const url = `${route.apiUrl}/v1/media/status?task_id=${encodeURIComponent(taskId)}`
    const status = await fetchAi6800Json(url, route, { method: 'GET', headers: { 'Content-Type': undefined } })
    const isFinal = status?.is_final === true || status?.is_final === 'true'
    const state = String(status?.state || '').toLowerCase()
    if (isFinal || state === 'success' || state === 'failed') return status
    await sleep(ai6800PollIntervalMs)
  }
  throw new Error('任务生成时间较长，请稍后刷新或重试')
}

function dataUrlToImagePayload(dataUrl) {
  const match = String(dataUrl).match(/^data:([^;,]+);base64,(.+)$/i)
  if (!match) return null
  return { mime: match[1], b64Json: match[2] }
}

async function downloadImagePayload(url) {
  if (/^data:image\//i.test(url)) return dataUrlToImagePayload(url)
  const response = await fetch(url, { headers: { Accept: 'image/*,*/*' } })
  if (!response.ok) throw new Error(`结果图片下载失败: HTTP ${response.status}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  return {
    mime: response.headers.get('content-type') || 'image/png',
    b64Json: buffer.toString('base64'),
  }
}

function buildAi6800SuccessBody(route, imagePayloads, resultUrls) {
  if (route.kind === 'gemini') {
    return {
      choices: [
        {
          message: {
            role: 'assistant',
            content: imagePayloads.map((item) => `![image](data:${item.mime};base64,${item.b64Json})`).join('\n'),
          },
        },
      ],
    }
  }
  return {
    data: imagePayloads.map((item, index) => ({
      b64_json: item.b64Json,
      url: resultUrls[index] || '',
    })),
  }
}

async function runAi6800ProxyJob(job, { settings, route, pathname, contentType, body, publicBaseUrl }) {
  const { chargedCard, codes, cost, logId, prompt } = job
  try {
    touchProxyJob(job, { status: 'running' })
    const submitPayload = buildAi6800SubmitPayload({ route, contentType, body, prompt, publicBaseUrl, tempFiles: job.tempFiles })
    const submit = await fetchAi6800Json(`${route.apiUrl}/v1/media/generate`, route, {
      method: 'POST',
      body: JSON.stringify(submitPayload),
    })
    const taskId = extractTaskIdFromPayload(submit)
    if (!taskId) throw new Error('中转站没有返回 task_id')
    const finalStatus = await pollAi6800Task(route, taskId)
    const state = String(finalStatus?.state || '').toLowerCase()
    if (state === 'failed') {
      throw new Error(String(finalStatus?.error || finalStatus?.status || '生成失败'))
    }
    const resultUrls = extractAi6800ResultUrls(finalStatus)
    if (!resultUrls.length) throw new Error('中转站完成任务但没有返回图片地址')
    const imagePayloads = []
    for (const url of resultUrls) {
      const image = await downloadImagePayload(url)
      if (image) imagePayloads.push(image)
    }
    if (!imagePayloads.length) throw new Error('结果图片下载失败')
    updateUsageLog(logId, 'success')
    touchProxyJob(job, {
      status: 'success',
      httpStatus: 200,
      contentType: 'application/json; charset=utf-8',
      body: buildAi6800SuccessBody(route, imagePayloads, resultUrls),
      bodyText: '',
      balance: getCardsBalance(codes),
    })
  } catch (err) {
    refundCredits(chargedCard, cost)
    const rawMessage = err instanceof Error ? err.message : String(err)
    const message = isStreamDisconnectedMessage(rawMessage) ? connectionInterruptedMessage : rawMessage
    updateUsageLog(logId, 'refunded', message)
    touchProxyJob(job, {
      status: 'error',
      httpStatus: 502,
      contentType: 'application/json; charset=utf-8',
      body: { error: { message: buildRefundedProxyErrorMessage(message) } },
      bodyText: '',
      errorMessage: message,
      balance: getCardsBalance(codes),
    })
  } finally {
    cleanupTempFiles(job.tempFiles || [])
  }
}

function handleImageProxyTaskStatus(req, res, taskId) {
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: { message: 'Method not allowed' } })
    return
  }
  cleanupProxyJobs()
  const job = proxyJobs.get(taskId)
  if (!job) {
    sendJson(res, 404, { ok: false, status: 'missing', error: { message: '任务不存在或已过期' } })
    return
  }

  const payload = {
    ok: job.status === 'success',
    taskId: job.id,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    balance: job.balance || getCardsBalance(job.codes || []),
  }

  if (job.status === 'success') {
    sendJson(res, 200, {
      ...payload,
      httpStatus: job.httpStatus || 200,
      contentType: job.contentType || 'application/json; charset=utf-8',
      body: job.body,
      bodyText: job.bodyText || '',
    })
    return
  }

  if (job.status === 'error') {
    sendJson(res, 200, {
      ...payload,
      httpStatus: job.httpStatus || 502,
      contentType: job.contentType || 'application/json; charset=utf-8',
      body: job.body,
      bodyText: job.bodyText || '',
      error: { message: job.errorMessage || '生成失败，次数已退回' },
    })
    return
  }

  sendJson(res, 200, payload)
}

async function handleApi(req, res, pathname) {
  if (pathname === '/api/config' && req.method === 'GET') {
    const settings = getSettings()
    sendJson(res, 200, {
      purchaseUrl: settings.purchase_url || '',
      costPerGeneration: Number(settings.cost_per_generation || 1),
      announcementText: settings.announcement_text || defaultAnnouncementText,
      gateNoticeText: settings.gate_notice_text || defaultGateNoticeText,
    })
    return
  }
  if ((pathname === '/api/cards/add' || pathname === '/api/cards/verify') && req.method === 'POST') {
    const { code } = parseJsonBody(await readBody(req, 1024 * 1024))
    const normalized = normalizeCardCode(code)
    const card = publicCard(normalized ? getCard(normalized) : null)
    if (!normalized || !card) {
      sendJson(res, 404, { ok: false, error: '卡密不存在' })
      return
    }
    if (card.status === 'disabled') {
      sendJson(res, 403, { ok: false, error: '卡密已被禁用' })
      return
    }
    if (!card.activatedAt) run('UPDATE cards SET activated_at = ?, updated_at = ? WHERE code = ?', [nowIso(), nowIso(), normalized])
    sendJson(res, 200, { ok: true, card: publicCard(getCard(normalized)) })
    return
  }
  if (pathname === '/api/cards/balance' && req.method === 'POST') {
    const { codes } = parseJsonBody(await readBody(req, 1024 * 1024))
    const normalized = Array.isArray(codes) ? [...new Set(codes.map(normalizeCardCode).filter(Boolean))] : []
    sendJson(res, 200, getCardsBalance(normalized))
    return
  }
  sendJson(res, 404, { error: 'Not found' })
}

async function handleAdmin(req, res, pathname, searchParams) {
  if (pathname === '/api/admin/login' && req.method === 'POST') {
    const { password } = parseJsonBody(await readBody(req, 1024 * 1024))
    if (String(password || '') !== adminPassword) {
      sendJson(res, 401, { error: '密码错误' })
      return
    }
    sendJson(res, 200, { token: adminToken })
    return
  }
  if (!requireAdmin(req, res)) return

  if (pathname === '/api/admin/settings') {
    if (req.method === 'GET') {
      const settings = getSettings()
      const modelRoutes = getModelRoutes(settings)
      sendJson(res, 200, {
        ...settings,
        backgrace_api_key: settings.backgrace_api_key ? '********' : '',
        ai6800_api_key: settings.ai6800_api_key ? '********' : '',
        model_routes: maskModelRoutesConfig(modelRoutes),
      })
      return
    }
    if (req.method === 'POST') {
      const input = parseJsonBody(await readBody(req, 1024 * 1024))
      const current = getSettings()
      if (input.backgrace_api_key === '********') input.backgrace_api_key = current.backgrace_api_key || ''
      if (input.ai6800_api_key === '********') input.ai6800_api_key = current.ai6800_api_key || ''
      if (input.model_routes) {
        const currentRoutes = getModelRoutes(current)
        const modelRoutes = preserveMaskedModelRouteKeys(input.model_routes, currentRoutes)
        Object.assign(input, deriveLegacySettingsFromModelRoutes(modelRoutes))
        input.model_routes = modelRoutes
      }
      setSettings(input)
      sendJson(res, 200, { ok: true })
      return
    }
  }

  if (pathname === '/api/admin/cards' && req.method === 'GET') {
    const q = String(searchParams.get('q') || '').trim()
    const status = String(searchParams.get('status') || 'all')
    const page = Math.max(1, Number(searchParams.get('page') || 1))
    const pageSize = Math.min(100, Math.max(1, Number(searchParams.get('pageSize') || 10)))
    const where = []
    const params = []
    if (q) {
      where.push('(code LIKE ? OR batch_name LIKE ?)')
      params.push(`%${q}%`, `%${q}%`)
    }
    if (status === 'depleted') {
      where.push('status != ? AND used_credits >= total_credits')
      params.push('disabled')
    } else if (status === 'available') {
      where.push('status != ? AND used_credits < total_credits')
      params.push('disabled')
    } else if (status === 'disabled') {
      where.push('status = ?')
      params.push('disabled')
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const total = Number(selectOne(`SELECT COUNT(*) AS total FROM cards ${whereSql}`, params)?.total || 0)
    const rows = selectAll(
      `SELECT * FROM cards ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, pageSize, (page - 1) * pageSize],
    )
    sendJson(res, 200, { cards: rows.map(publicCard), total, page, pageSize })
    return
  }

  if (pathname === '/api/admin/cards/generate' && req.method === 'POST') {
    const input = parseJsonBody(await readBody(req, 1024 * 1024))
    const count = Math.min(5000, Math.max(1, Number(input.count || 1)))
    const credits = Math.max(1, Number(input.credits || 1))
    const batchName = String(input.batchName || '').trim()
    const createdAt = nowIso()
    const codes = []
    for (let i = 0; i < count; i += 1) {
      let code = generateCardCode()
      while (getCard(code)) code = generateCardCode()
      db.run(
        'INSERT INTO cards (code, total_credits, used_credits, status, batch_name, created_at, updated_at) VALUES (?, ?, 0, ?, ?, ?, ?)',
        [code, credits, 'active', batchName, createdAt, createdAt],
      )
      codes.push(code)
    }
    saveDb()
    sendJson(res, 200, { codes })
    return
  }

  const disableMatch = pathname.match(/^\/api\/admin\/cards\/([^/]+)\/disable$/)
  if (disableMatch && req.method === 'POST') {
    const code = normalizeCardCode(decodeURIComponent(disableMatch[1]))
    run('UPDATE cards SET status = ?, updated_at = ? WHERE code = ?', ['disabled', nowIso(), code])
    sendJson(res, 200, { ok: true })
    return
  }

  const deleteCardMatch = pathname.match(/^\/api\/admin\/cards\/([^/]+)$/)
  if (deleteCardMatch && req.method === 'DELETE') {
    const code = normalizeCardCode(decodeURIComponent(deleteCardMatch[1]))
    run('DELETE FROM cards WHERE code = ?', [code])
    sendJson(res, 200, { ok: true })
    return
  }

  if (pathname === '/api/admin/stats' && req.method === 'GET') {
    sendJson(res, 200, getUsageStats())
    return
  }

  if (pathname === '/api/admin/failures' && req.method === 'GET') {
    const rows = selectAll("SELECT * FROM usage_logs WHERE status NOT IN ('success', 'pending') ORDER BY created_at DESC LIMIT 300")
    sendJson(res, 200, { logs: rows })
    return
  }

  if (pathname === '/api/admin/logs' && req.method === 'GET') {
    const rows = selectAll('SELECT * FROM usage_logs ORDER BY created_at DESC LIMIT 300')
    sendJson(res, 200, { logs: rows })
    return
  }

  sendJson(res, 404, { error: 'Not found' })
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || `${host}:${port}`}`)
    const pathname = decodeURIComponent(url.pathname)
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }
    if (pathname.startsWith('/api/temp-images/')) {
      serveTempImage(req, res, pathname)
      return
    }
    const taskMatch = pathname.match(/^\/api-proxy\/tasks\/([^/]+)$/)
    if (taskMatch) {
      handleImageProxyTaskStatus(req, res, taskMatch[1])
      return
    }
    if (pathname.startsWith('/api-proxy/')) {
      await handleImageProxyTaskMode(req, res, pathname)
      return
    }
    if (pathname.startsWith('/api/admin/')) {
      await handleAdmin(req, res, pathname, url.searchParams)
      return
    }
    if (pathname.startsWith('/api/')) {
      await handleApi(req, res, pathname)
      return
    }
    serveStatic(req, res, pathname)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    sendJson(res, 500, { error: message })
  }
})

server.listen(port, host, () => {
  console.log(`云逸生图服务已启动：http://${host}:${port}`)
  console.log(`后台地址：http://${host}:${port}/admin`)
})
