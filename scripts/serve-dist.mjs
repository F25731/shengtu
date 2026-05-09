import http from 'node:http'
import { createReadStream, statSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = normalize(join(fileURLToPath(new URL('..', import.meta.url)), 'dist'))
const port = Number(process.env.PORT || 5173)
const host = process.env.HOST || '127.0.0.1'

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
}

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url || '/', `http://${host}:${port}`).pathname)
  const requested = normalize(join(root, urlPath))
  const filePath = requested.startsWith(root) ? requested : root
  let target = filePath

  try {
    const info = statSync(target)
    if (info.isDirectory()) target = join(target, 'index.html')
  } catch {
    target = join(root, 'index.html')
  }

  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Content-Type', types[extname(target)] || 'application/octet-stream')
  createReadStream(target)
    .on('error', () => {
      res.statusCode = 404
      res.end('Not found')
    })
    .pipe(res)
})

server.listen(port, host)
