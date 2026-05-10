import http from 'node:http'
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomInt } from 'node:crypto'
import { createRequire } from 'node:module'
import initSqlJs from 'sql.js'

const require = createRequire(import.meta.url)
const appRoot = normalize(join(fileURLToPath(new URL('..', import.meta.url))))
const distRoot = join(appRoot, 'dist')
const dataDir = process.env.YUNYI_DATA_DIR || join(appRoot, 'server', 'data')
const dbPath = process.env.YUNYI_DB_PATH || join(dataDir, 'yunyi.sqlite')
const host = process.env.HOST || '0.0.0.0'
const port = Number(process.env.PORT || 3000)
const adminPassword = process.env.YUNYI_ADMIN_PASSWORD || 'admin123456'
const adminToken = createHash('sha256').update(`yunyi-admin:${adminPassword}`).digest('hex')
const cardAlphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

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
    image_model: process.env.YUNYI_IMAGE_MODEL || 'gpt-image-2',
    cost_per_generation: process.env.YUNYI_COST_PER_GENERATION || '1',
  }
  for (const [key, value] of Object.entries(defaults)) {
    const existing = selectOne('SELECT key FROM settings WHERE key = ?', [key])
    if (!existing) db.run('INSERT INTO settings (key, value) VALUES (?, ?)', [key, value])
  }
  saveDb()
}

function getSettings() {
  const rows = selectAll('SELECT key, value FROM settings')
  return Object.fromEntries(rows.map((row) => [row.key, row.value]))
}

function setSettings(input) {
  const allowed = ['purchase_url', 'backgrace_api_url', 'backgrace_api_key', 'image_model', 'cost_per_generation']
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(input, key)) {
      run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, String(input[key] ?? '')])
    }
  }
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
  const cards = codes
    .map((code) => publicCard(getCard(code)) || { code, totalCredits: 0, usedCredits: 0, remainingCredits: 0, status: 'missing' })
  const totalRemaining = cards.reduce((sum, card) => sum + (card.status === 'active' ? card.remainingCredits : 0), 0)
  return { cards, totalRemaining }
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
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

function sendText(res, status, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': 'no-store' })
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

function buildProxyBody(contentType, body, settings, apiPath) {
  if (!contentType.includes('application/json')) return body
  try {
    const data = parseJsonBody(body)
    if (settings.image_model) data.model = settings.image_model
    if (apiPath.includes('/images/')) data.response_format = 'b64_json'
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
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' })
  createReadStream(target).on('error', () => sendText(res, 404, 'Not found')).pipe(res)
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
  const imageCount = Math.max(1, extractImageCount(contentType, body))
  const cost = baseCost * imageCount

  const codes = parseCardsHeader(req)
  if (!codes.length) {
    sendJson(res, 402, { error: { message: '请先输入卡密' } })
    return
  }
  const chargedCard = deductCredits(codes, cost)
  if (!chargedCard) {
    sendJson(res, 402, { error: { message: '卡密次数不足，请购买或添加卡密' } })
    return
  }

  const prompt = extractPrompt(contentType, body)
  const logId = insertUsageLog({ cardCode: chargedCard, prompt, cost, status: 'pending' })

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
    })
    const responseBuffer = Buffer.from(await response.arrayBuffer())
    const responseType = response.headers.get('content-type') || 'application/json; charset=utf-8'
    if (!response.ok) {
      refundCredits(chargedCard, cost)
      updateUsageLog(logId, 'refunded', responseBuffer.toString('utf8').slice(0, 2000))
    } else {
      updateUsageLog(logId, 'success')
    }
    res.writeHead(response.status, {
      'Content-Type': responseType,
      'Cache-Control': 'no-store',
      'X-YunYi-Balance': String(getCardsBalance(codes).totalRemaining),
    })
    res.end(responseBuffer)
  } catch (err) {
    refundCredits(chargedCard, cost)
    const message = err instanceof Error ? err.message : String(err)
    updateUsageLog(logId, 'refunded', message)
    sendJson(res, 502, { error: { message: `生图失败，次数已退回：${message}` } })
  }
}

async function handleApi(req, res, pathname) {
  if (pathname === '/api/config' && req.method === 'GET') {
    const settings = getSettings()
    sendJson(res, 200, {
      purchaseUrl: settings.purchase_url || '',
      costPerGeneration: Number(settings.cost_per_generation || 1),
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
      sendJson(res, 200, { ...settings, backgrace_api_key: settings.backgrace_api_key ? '********' : '' })
      return
    }
    if (req.method === 'POST') {
      const input = parseJsonBody(await readBody(req, 1024 * 1024))
      const current = getSettings()
      if (input.backgrace_api_key === '********') input.backgrace_api_key = current.backgrace_api_key || ''
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
    if (pathname.startsWith('/api-proxy/')) {
      await handleImageProxy(req, res, pathname)
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
