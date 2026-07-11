import 'dotenv/config'
import express from 'express'
import { createServer as createViteServer } from 'vite'

const app = express()
const port = 5173

app.use(express.json({ limit: '20mb' }))

app.use((error, request, response, next) => {
  if (error.type === 'entity.too.large') {
    response.status(413).json({ error: 'The frame images were too large to check' })
    return
  }

  if (error instanceof SyntaxError) {
    response.status(400).json({ error: 'The frame request was not valid JSON' })
    return
  }

  next(error)
})

app.post('/api/check-frame', async (request, response) => {
  if (!process.env.FEATHERLESS_API_KEY) {
    response.status(500).json({ error: 'FEATHERLESS_API_KEY is missing from .env' })
    return
  }

  const images = request.body.images || [request.body.image]

  if (!images.length || images.some((image) => !image?.startsWith('data:image/'))) {
    response.status(400).json({ error: 'No camera image was provided' })
    return
  }

  try {
    const featherlessResponse = await fetch('https://api.featherless.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.FEATHERLESS_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': `http://localhost:${port}`,
        'X-Title': 'ClearFrame',
      },
      body: JSON.stringify({
        model: 'Qwen/Qwen3.6-35B-A3B',
        max_tokens: 250,
        temperature: 0,
        chat_template_kwargs: { enable_thinking: false },
        messages: [{
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Image 1 is the processed ClearFrame result. Image 2 is the original raw camera frame from the same moment. The remaining four images are detailed crops of the processed result. Compare the people in the raw frame against the processed frame. Inspect carefully for any part of a removed person that remains, even a tiny clothing, hair, skin, hand, limb, or silhouette fragment. Also check for ghosts, seams, and mismatched patches. Be strict. Reply in one short sentence saying whether the frame passes or describing the remaining artifact.',
            },
            ...images.map((image) => ({
              type: 'image_url',
              image_url: { url: image },
            })),
          ],
        }],
      }),
    })

    const responseText = await featherlessResponse.text()
    let data

    try {
      data = JSON.parse(responseText)
    } catch {
      throw new Error(`Featherless returned an invalid response (${featherlessResponse.status})`)
    }

    if (!featherlessResponse.ok) {
      throw new Error(data.error?.message || 'Featherless request failed')
    }

    const modelMessage = data.choices?.[0]?.message
    const message = modelMessage?.content?.trim() || modelMessage?.reasoning_content?.trim()

    if (!message) throw new Error('Featherless returned an empty response')
    response.json({ message })
  } catch (error) {
    response.status(500).json({ error: error.message })
  }
})

const vite = await createViteServer({
  server: { middlewareMode: true },
  appType: 'spa',
})

app.use(vite.middlewares)

app.listen(port, () => {
  console.log(`ClearFrame is running at http://localhost:${port}`)
})
