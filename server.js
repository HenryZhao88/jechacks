import 'dotenv/config'
import express from 'express'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import { handleFrameCheckRequest } from './lib/frame-check.js'

const rootDirectory = path.dirname(fileURLToPath(import.meta.url))

function sendBodyError(error, response) {
  if (error.type === 'entity.too.large') {
    response.status(413).json({
      error: 'The frame images were too large to check',
      code: 'IMAGES_TOO_LARGE',
    })
    return true
  }

  if (error.type === 'entity.parse.failed') {
    response.status(400).json({
      error: 'The frame request was not valid JSON',
      code: 'INVALID_JSON',
    })
    return true
  }

  return false
}

export async function createApp(options = {}) {
  const app = express()
  const mode = options.mode || (process.env.NODE_ENV === 'production' ? 'production' : 'development')

  app.disable('x-powered-by')
  app.use(express.json({ limit: '4mb' }))

  app.all('/api/check-frame', (request, response, next) => {
    Promise.resolve(handleFrameCheckRequest(request, response, options.frameCheckOptions)).catch(next)
  })

  if (mode === 'development') {
    const { createServer: createViteServer } = await import('vite')
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'mpa',
    })
    app.use(vite.middlewares)
  } else if (mode === 'production') {
    app.use(express.static(path.join(rootDirectory, 'dist')))
  }

  app.use((request, response) => {
    response.status(404).json({ error: 'Not found', code: 'NOT_FOUND' })
  })

  app.use((error, request, response, next) => {
    if (response.headersSent) {
      next(error)
      return
    }

    if (sendBodyError(error, response)) return
    console.error('Unexpected server error', { name: error?.name || 'Error' })
    response.status(500).json({ error: 'The server failed unexpectedly', code: 'INTERNAL_ERROR' })
  })

  return app
}

async function startServer() {
  const productionFlag = process.argv.includes('--production')
  const mode = productionFlag ? 'production' : undefined
  const app = await createApp({ mode })
  const parsedPort = Number(process.env.PORT)
  const port = Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : 5173

  app.listen(port, () => {
    console.log(`ClearFrame is running at http://localhost:${port}`)
  })
}

const entryPoint = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : undefined
if (entryPoint === import.meta.url) await startServer()
