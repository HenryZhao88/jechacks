const FEATHERLESS_URL = 'https://api.featherless.ai/v1/chat/completions'
const DEFAULT_MODEL = 'Qwen/Qwen3-VL-235B-A22B-Thinking'
const EXPECTED_IMAGE_COUNT = 6
const MAX_IMAGE_BYTES = 1024 * 1024
const MAX_TOTAL_IMAGE_BYTES = Math.floor(2.75 * 1024 * 1024)
const DEFAULT_TIMEOUT_MS = 50_000
const RETRY_DELAYS_MS = [400, 1_000]

const PASS_VERDICT = /^VERDICT-PASS\b/i
const FAIL_VERDICT = /^VERDICT-FAIL:?\s*/i

const AUDIT_PROMPT = 'Image 1 is the processed ClearFrame result. Image 2 is the original raw camera frame from the same moment. The remaining four images are detailed crops of the processed result. ClearFrame erases some people from the frame while keeping the people who are allowed on camera. A complete, intact person in the processed frame is allowed and is never an artifact. The removal is only a failure if it left visible partial remnants in the processed pixels: stray patches of clothing or skin color, disembodied limbs, ghost silhouettes, seams, or mismatched background patches. Reply with exactly one short sentence that starts with "VERDICT-FAIL:" describing the remnant you can see in the processed frame, or "VERDICT-PASS:" if the processed frame shows no such remnants.'

class PublicError extends Error {
  constructor(status, code, message, headers = {}, logDetails = {}) {
    super(message)
    this.name = 'PublicError'
    this.status = status
    this.code = code
    this.headers = headers
    this.logDetails = logDetails
  }
}

function getPositiveInteger(value, fallback) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

function validateJpegDataUrl(image, index) {
  if (typeof image !== 'string') {
    throw new PublicError(400, 'INVALID_IMAGES', `Image ${index + 1} must be a JPEG data URL`)
  }

  const match = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/.exec(image)
  if (!match || match[1].length % 4 !== 0) {
    throw new PublicError(400, 'INVALID_IMAGES', `Image ${index + 1} must contain valid base64 JPEG data`)
  }

  const bytes = Buffer.from(match[1], 'base64')
  const hasJpegMarkers = bytes.length >= 4
    && bytes[0] === 0xff
    && bytes[1] === 0xd8
    && bytes[2] === 0xff
    && bytes[bytes.length - 2] === 0xff
    && bytes[bytes.length - 1] === 0xd9

  if (!hasJpegMarkers) {
    throw new PublicError(400, 'INVALID_IMAGES', `Image ${index + 1} is not a valid JPEG image`)
  }

  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new PublicError(413, 'IMAGES_TOO_LARGE', `Image ${index + 1} is too large`)
  }

  return bytes.length
}

export function validateFrameCheckBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new PublicError(400, 'INVALID_REQUEST', 'The frame request must be a JSON object')
  }

  if (!Array.isArray(body.images) || body.images.length !== EXPECTED_IMAGE_COUNT) {
    throw new PublicError(400, 'INVALID_IMAGES', `Exactly ${EXPECTED_IMAGE_COUNT} frame images are required`)
  }

  const totalBytes = body.images.reduce((total, image, index) => {
    return total + validateJpegDataUrl(image, index)
  }, 0)

  if (totalBytes > MAX_TOTAL_IMAGE_BYTES) {
    throw new PublicError(413, 'IMAGES_TOO_LARGE', 'The combined frame images are too large')
  }

  return body.images
}

function getHeader(request, name) {
  const value = request.headers?.[name] ?? request.headers?.[name.toLowerCase()]
  return Array.isArray(value) ? value[0] : value
}

function normalizeSiteUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return undefined
  value = value.trim()

  const candidate = value.startsWith('http://') || value.startsWith('https://')
    ? value
    : `https://${value}`

  try {
    const url = new URL(candidate)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    return url.origin
  } catch {
    return undefined
  }
}

function getSiteUrl(request, configuredSiteUrl) {
  const forwardedProtocol = getHeader(request, 'x-forwarded-proto')
  const protocol = forwardedProtocol?.split(',')[0].trim() || (request.socket?.encrypted ? 'https' : 'http')
  const host = getHeader(request, 'x-forwarded-host') || getHeader(request, 'host')

  return normalizeSiteUrl(configuredSiteUrl)
    || normalizeSiteUrl(process.env.SITE_URL)
    || normalizeSiteUrl(process.env.VERCEL_URL)
    || normalizeSiteUrl(getHeader(request, 'origin'))
    || normalizeSiteUrl(host ? `${protocol}://${host}` : undefined)
}

function safeRetryAfter(response) {
  const value = response.headers?.get?.('retry-after')
  if (typeof value !== 'string') return undefined
  if (/^\d{1,4}$/.test(value)) return value

  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? new Date(timestamp).toUTCString() : undefined
}

function providerError(response) {
  const logDetails = { upstreamStatus: response.status }

  if (response.status === 429) {
    const retryAfter = safeRetryAfter(response)
    return new PublicError(
      429,
      'AI_RATE_LIMITED',
      'The AI frame checker is busy. Please try again shortly.',
      retryAfter ? { 'Retry-After': retryAfter } : {},
      logDetails,
    )
  }

  if ([401, 402, 403, 404].includes(response.status)) {
    return new PublicError(
      503,
      'AI_CONFIGURATION_ERROR',
      'AI frame checking is not configured correctly on this server',
      {},
      logDetails,
    )
  }

  if (response.status === 400) {
    return new PublicError(
      502,
      'AI_REQUEST_REJECTED',
      'The AI provider rejected the frame check. Check the configured model and image format.',
      {},
      logDetails,
    )
  }

  return new PublicError(
    502,
    'AI_PROVIDER_ERROR',
    'The AI frame checker is temporarily unavailable. Please try again.',
    {},
    logDetails,
  )
}

function timeoutError() {
  return new PublicError(
    504,
    'AI_TIMEOUT',
    'The AI frame check timed out. Please try again.',
  )
}

function delay(milliseconds, sleepImpl) {
  return sleepImpl
    ? sleepImpl(milliseconds)
    : new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function fetchWithDeadline(fetchImpl, url, options, deadline) {
  const remaining = deadline - Date.now()
  if (remaining <= 0) throw timeoutError()

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), remaining)

  try {
    const response = await fetchImpl(url, { ...options, signal: controller.signal })
    const text = await response.text()
    return { response, text }
  } catch (error) {
    if (controller.signal.aborted || error?.name === 'AbortError') throw timeoutError()
    throw error
  } finally {
    clearTimeout(timer)
  }
}

export async function requestFrameCheck(images, options = {}) {
  const apiKey = options.apiKey ?? process.env.FEATHERLESS_API_KEY
  if (!apiKey) {
    throw new PublicError(503, 'AI_NOT_CONFIGURED', 'AI frame checking is not configured on this server')
  }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    throw new PublicError(503, 'AI_NOT_CONFIGURED', 'AI frame checking is not available on this server')
  }

  const timeoutMs = getPositiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS)
  const deadline = Date.now() + timeoutMs
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'X-Title': 'ClearFrame',
  }

  if (options.siteUrl) headers['HTTP-Referer'] = options.siteUrl

  const requestOptions = {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: options.model || process.env.FEATHERLESS_MODEL || DEFAULT_MODEL,
      max_tokens: 250,
      temperature: 0,
      chat_template_kwargs: { enable_thinking: false },
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: AUDIT_PROMPT },
          ...images.map((image) => ({
            type: 'image_url',
            image_url: { url: image },
          })),
        ],
      }],
    }),
  }

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const { response, text } = await fetchWithDeadline(fetchImpl, FEATHERLESS_URL, requestOptions, deadline)
      const retryable = [500, 502, 503, 504].includes(response.status)

      if (retryable && attempt < RETRY_DELAYS_MS.length) {
        await delay(RETRY_DELAYS_MS[attempt], options.sleepImpl)
        continue
      }

      if (!response.ok) throw providerError(response)

      let data
      try {
        data = JSON.parse(text)
      } catch {
        throw new PublicError(502, 'AI_INVALID_RESPONSE', 'The AI frame checker returned an invalid response')
      }

      const rawContent = data?.choices?.[0]?.message?.content
      const reasoningContent = data?.choices?.[0]?.message?.reasoning_content
      const content = typeof rawContent === 'string'
        ? rawContent.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
        : ''
      const message = content
        || (typeof reasoningContent === 'string' ? reasoningContent.trim() : '')

      if (!message) {
        throw new PublicError(502, 'AI_INVALID_RESPONSE', 'The AI frame checker returned an empty response')
      }

      if (PASS_VERDICT.test(message)) return ''
      return message.replace(FAIL_VERDICT, '')
    } catch (error) {
      if (error instanceof PublicError) throw error
      if (attempt < RETRY_DELAYS_MS.length) {
        await delay(RETRY_DELAYS_MS[attempt], options.sleepImpl)
        continue
      }
    }
  }

  throw new PublicError(502, 'AI_NETWORK_ERROR', 'The AI frame checker could not be reached. Please try again.')
}

function sendJson(response, status, body, headers = {}) {
  response.setHeader?.('Cache-Control', 'no-store')
  Object.entries(headers).forEach(([name, value]) => response.setHeader?.(name, value))
  return response.status(status).json(body)
}

export async function handleFrameCheckRequest(request, response, options = {}) {
  try {
    if (request.method !== 'POST') {
      response.setHeader?.('Allow', 'POST')
      return sendJson(response, 405, { error: 'Use POST for frame checks', code: 'METHOD_NOT_ALLOWED' })
    }

    const images = validateFrameCheckBody(request.body)
    const siteUrl = getSiteUrl(request, options.siteUrl)
    const message = await requestFrameCheck(images, { ...options, siteUrl })
    return sendJson(response, 200, { message })
  } catch (error) {
    if (error instanceof PublicError) {
      if (error.status >= 500) {
        const logger = options.logger || console
        logger.warn?.('Frame-check request failed', {
          code: error.code,
          status: error.status,
          ...error.logDetails,
        })
      }
      return sendJson(response, error.status, { error: error.message, code: error.code }, error.headers)
    }

    options.logger?.error?.('Unexpected frame-check failure', {
      name: error?.name || 'Error',
    })
    return sendJson(response, 500, { error: 'The frame check failed unexpectedly', code: 'INTERNAL_ERROR' })
  }
}

export const frameCheckLimits = Object.freeze({
  imageCount: EXPECTED_IMAGE_COUNT,
  maxImageBytes: MAX_IMAGE_BYTES,
  maxTotalImageBytes: MAX_TOTAL_IMAGE_BYTES,
})
