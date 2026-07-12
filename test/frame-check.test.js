import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'

import {
  frameCheckLimits,
  requestFrameCheck,
  validateFrameCheckBody,
} from '../lib/frame-check.js'
import { createApp } from '../server.js'

const FEATHERLESS_URL = 'https://api.featherless.ai/v1/chat/completions'
const AUDIT_PROMPT = 'Image 1 is the processed ClearFrame result. Image 2 is the original raw camera frame from the same moment. The remaining four images are detailed crops of the processed result. ClearFrame erases some people from the frame while keeping the people who are allowed on camera. A complete, intact person in the processed frame is allowed and is never an artifact. The removal is only a failure if it left visible partial remnants in the processed pixels: stray patches of clothing or skin color, disembodied limbs, ghost silhouettes, seams, or mismatched background patches. Reply with exactly one short sentence that starts with "VERDICT-FAIL:" describing the remnant you can see in the processed frame, or "VERDICT-PASS:" if the processed frame shows no such remnants.'

function jpegDataUrl(size = 4) {
  assert.ok(size >= 4)
  const bytes = Buffer.alloc(size)
  bytes[0] = 0xff
  bytes[1] = 0xd8
  bytes[2] = 0xff
  bytes[size - 2] = 0xff
  bytes[size - 1] = 0xd9
  return `data:image/jpeg;base64,${bytes.toString('base64')}`
}

function validImages() {
  return Array.from({ length: frameCheckLimits.imageCount }, () => jpegDataUrl())
}

function providerResponse(status, body, headers = {}) {
  const normalizedHeaders = new Map(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), String(value)]),
  )

  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get(name) {
        return normalizedHeaders.get(name.toLowerCase()) ?? null
      },
    },
    async text() {
      return body
    },
  }
}

function assertPublicError(error, { status, code, message }) {
  assert.equal(error.name, 'PublicError')
  assert.equal(error.status, status)
  assert.equal(error.code, code)
  if (message !== undefined) assert.equal(error.message, message)
  return true
}

async function listen(app) {
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address === 'object')

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve())
        server.closeAllConnections?.()
      })
    },
  }
}

test('validateFrameCheckBody rejects non-object request bodies', async (t) => {
  const cases = [
    ['undefined', undefined],
    ['null', null],
    ['string', 'frame'],
    ['array', []],
  ]

  for (const [name, body] of cases) {
    await t.test(name, () => {
      assert.throws(
        () => validateFrameCheckBody(body),
        (error) => assertPublicError(error, {
          status: 400,
          code: 'INVALID_REQUEST',
          message: 'The frame request must be a JSON object',
        }),
      )
    })
  }
})

test('validateFrameCheckBody requires an array containing exactly six images', async (t) => {
  const cases = [
    ['missing images', {}],
    ['non-array images', { images: 'frame' }],
    ['too few images', { images: validImages().slice(0, -1) }],
    ['too many images', { images: [...validImages(), jpegDataUrl()] }],
  ]

  for (const [name, body] of cases) {
    await t.test(name, () => {
      assert.throws(
        () => validateFrameCheckBody(body),
        (error) => assertPublicError(error, {
          status: 400,
          code: 'INVALID_IMAGES',
          message: 'Exactly 6 frame images are required',
        }),
      )
    })
  }
})

test('validateFrameCheckBody rejects invalid image types, encodings, and JPEG data', async (t) => {
  const cases = [
    ['non-string image', 123, 'Image 1 must be a JPEG data URL'],
    ['wrong media type', 'data:image/png;base64,/9j/2Q==', 'Image 1 must contain valid base64 JPEG data'],
    ['invalid base64 characters', 'data:image/jpeg;base64,%%%%', 'Image 1 must contain valid base64 JPEG data'],
    ['invalid base64 length', 'data:image/jpeg;base64,/9j/2Q=', 'Image 1 must contain valid base64 JPEG data'],
    ['non-JPEG bytes', 'data:image/jpeg;base64,AAAAAA==', 'Image 1 is not a valid JPEG image'],
    ['truncated JPEG bytes', 'data:image/jpeg;base64,/9j/', 'Image 1 is not a valid JPEG image'],
  ]

  for (const [name, image, message] of cases) {
    await t.test(name, () => {
      const images = validImages()
      images[0] = image
      assert.throws(
        () => validateFrameCheckBody({ images }),
        (error) => assertPublicError(error, {
          status: 400,
          code: 'INVALID_IMAGES',
          message,
        }),
      )
    })
  }
})

test('validateFrameCheckBody enforces per-image and combined decoded-byte limits', async (t) => {
  await t.test('single image above one MiB', () => {
    const images = validImages()
    images[2] = jpegDataUrl(frameCheckLimits.maxImageBytes + 1)

    assert.throws(
      () => validateFrameCheckBody({ images }),
      (error) => assertPublicError(error, {
        status: 413,
        code: 'IMAGES_TOO_LARGE',
        message: 'Image 3 is too large',
      }),
    )
  })

  await t.test('combined images above 2.75 MiB', () => {
    const images = [
      jpegDataUrl(frameCheckLimits.maxImageBytes),
      jpegDataUrl(frameCheckLimits.maxImageBytes),
      jpegDataUrl(frameCheckLimits.maxImageBytes),
      jpegDataUrl(),
      jpegDataUrl(),
      jpegDataUrl(),
    ]

    assert.throws(
      () => validateFrameCheckBody({ images }),
      (error) => assertPublicError(error, {
        status: 413,
        code: 'IMAGES_TOO_LARGE',
        message: 'The combined frame images are too large',
      }),
    )
  })
})

test('validateFrameCheckBody returns the validated image array unchanged', () => {
  const images = validImages()
  assert.equal(validateFrameCheckBody({ images }), images)
})

test('requestFrameCheck sends the expected Featherless request and returns trimmed content', async () => {
  const images = validImages()
  let observedUrl
  let observedOptions

  const message = await requestFrameCheck(images, {
    apiKey: 'test-secret',
    model: 'test/model',
    siteUrl: 'https://clearframe.example',
    timeoutMs: 1_000,
    async fetchImpl(url, options) {
      observedUrl = url
      observedOptions = options
      return providerResponse(200, JSON.stringify({
        choices: [{ message: { content: '  Frame passes.  ' } }],
      }))
    },
  })

  assert.equal(message, 'Frame passes.')
  assert.equal(observedUrl, FEATHERLESS_URL)
  assert.equal(observedOptions.method, 'POST')
  assert.deepEqual(observedOptions.headers, {
    Authorization: 'Bearer test-secret',
    'Content-Type': 'application/json',
    'X-Title': 'ClearFrame',
    'HTTP-Referer': 'https://clearframe.example',
  })
  assert.equal(observedOptions.signal instanceof AbortSignal, true)
  assert.equal(observedOptions.signal.aborted, false)
  assert.deepEqual(JSON.parse(observedOptions.body), {
    model: 'test/model',
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
  })
})

test('requestFrameCheck fails safely when the API key is missing', async () => {
  let fetchCalled = false

  await assert.rejects(
    requestFrameCheck(validImages(), {
      apiKey: '',
      fetchImpl() {
        fetchCalled = true
      },
    }),
    (error) => assertPublicError(error, {
      status: 503,
      code: 'AI_NOT_CONFIGURED',
      message: 'AI frame checking is not configured on this server',
    }),
  )
  assert.equal(fetchCalled, false)
})

test('requestFrameCheck returns 429 immediately and does not expose raw provider errors', async () => {
  const rawProviderError = 'account upstream-secret-token has insufficient credits'
  const delays = []
  let attempts = 0

  await assert.rejects(
    requestFrameCheck(validImages(), {
      apiKey: 'test-secret',
      fetchImpl: async () => {
        attempts += 1
        return providerResponse(429, rawProviderError, { 'Retry-After': '17' })
      },
      sleepImpl: async (delay) => delays.push(delay),
    }),
    (error) => {
      assertPublicError(error, {
        status: 429,
        code: 'AI_RATE_LIMITED',
        message: 'The AI frame checker is busy. Please try again shortly.',
      })
      assert.deepEqual(error.headers, { 'Retry-After': '17' })
      assert.equal(error.message.includes(rawProviderError), false)
      return true
    },
  )

  assert.equal(attempts, 1)
  assert.deepEqual(delays, [])
})

test('requestFrameCheck preserves a valid HTTP-date Retry-After value', async () => {
  const retryAfter = 'Wed, 21 Oct 2015 07:28:00 GMT'

  await assert.rejects(
    requestFrameCheck(validImages(), {
      apiKey: 'test-secret',
      fetchImpl: async () => providerResponse(429, 'busy', { 'Retry-After': retryAfter }),
    }),
    (error) => {
      assert.equal(error.code, 'AI_RATE_LIMITED')
      assert.deepEqual(error.headers, { 'Retry-After': retryAfter })
      return true
    },
  )
})

test('requestFrameCheck classifies provider authentication failures without leaking details', async () => {
  const rawProviderError = JSON.stringify({ error: 'do not leak provider diagnostics' })
  let attempts = 0

  await assert.rejects(
    requestFrameCheck(validImages(), {
      apiKey: 'test-secret',
      fetchImpl: async () => {
        attempts += 1
        return providerResponse(401, rawProviderError)
      },
    }),
    (error) => {
      assertPublicError(error, {
        status: 503,
        code: 'AI_CONFIGURATION_ERROR',
        message: 'AI frame checking is not configured correctly on this server',
      })
      assert.equal(error.message.includes(rawProviderError), false)
      return true
    },
  )
  assert.equal(attempts, 1)
})

test('requestFrameCheck retries provider 500 responses before succeeding', async () => {
  const delays = []
  let attempts = 0

  const message = await requestFrameCheck(validImages(), {
    apiKey: 'test-secret',
    fetchImpl: async () => {
      attempts += 1
      if (attempts < 3) return providerResponse(500, 'private upstream failure')
      return providerResponse(200, JSON.stringify({
        choices: [{ message: { content: 'Frame passes.' } }],
      }))
    },
    sleepImpl: async (delay) => delays.push(delay),
  })

  assert.equal(message, 'Frame passes.')
  assert.equal(attempts, 3)
  assert.deepEqual(delays, [400, 1_000])
})

test('requestFrameCheck rejects invalid and empty successful provider replies', async (t) => {
  const cases = [
    [
      'invalid JSON',
      'this is not JSON',
      'The AI frame checker returned an invalid response',
    ],
    [
      'missing choices',
      JSON.stringify({ choices: [] }),
      'The AI frame checker returned an empty response',
    ],
    [
      'blank content and reasoning',
      JSON.stringify({ choices: [{ message: { content: '  ', reasoning_content: '\n' } }] }),
      'The AI frame checker returned an empty response',
    ],
    [
      'non-string content',
      JSON.stringify({ choices: [{ message: { content: { text: 'pass' } } }] }),
      'The AI frame checker returned an empty response',
    ],
  ]

  for (const [name, body, message] of cases) {
    await t.test(name, async () => {
      await assert.rejects(
        requestFrameCheck(validImages(), {
          apiKey: 'test-secret',
          fetchImpl: async () => providerResponse(200, body),
        }),
        (error) => assertPublicError(error, {
          status: 502,
          code: 'AI_INVALID_RESPONSE',
          message,
        }),
      )
    })
  }
})

test('requestFrameCheck accepts reasoning content when normal content is empty', async () => {
  const message = await requestFrameCheck(validImages(), {
    apiKey: 'test-secret',
    fetchImpl: async () => providerResponse(200, JSON.stringify({
      choices: [{ message: { content: '', reasoning_content: '  No artifact remains.  ' } }],
    })),
  })

  assert.equal(message, 'No artifact remains.')
})

test('requestFrameCheck maps verdicts to display messages', async () => {
  const cases = [
    ['VERDICT-PASS: The frame is clean.', ''],
    ['verdict-pass', ''],
    ['<think>inspecting the crops</think>\nVERDICT-PASS: No leftovers visible.', ''],
    ['VERDICT-FAIL: A green patch remains on the right.', 'A green patch remains on the right.'],
    ['<think>found something</think>VERDICT-FAIL: A ghost outline remains.', 'A ghost outline remains.'],
    ['No verdict prefix at all.', 'No verdict prefix at all.'],
  ]

  for (const [content, expected] of cases) {
    const message = await requestFrameCheck(validImages(), {
      apiKey: 'test-secret',
      fetchImpl: async () => providerResponse(200, JSON.stringify({
        choices: [{ message: { content } }],
      })),
    })

    assert.equal(message, expected)
  }
})

test('requestFrameCheck retries transient network failures before succeeding', async () => {
  const delays = []
  let attempts = 0

  const message = await requestFrameCheck(validImages(), {
    apiKey: 'test-secret',
    fetchImpl: async () => {
      attempts += 1
      if (attempts < 3) throw new Error('sensitive low-level network failure')
      return providerResponse(200, JSON.stringify({
        choices: [{ message: { content: 'Frame passes.' } }],
      }))
    },
    sleepImpl: async (delay) => delays.push(delay),
  })

  assert.equal(message, 'Frame passes.')
  assert.equal(attempts, 3)
  assert.deepEqual(delays, [400, 1_000])
})

test('requestFrameCheck aborts an overdue provider request and returns a timeout error', async () => {
  let observedSignal
  let abortObserved = false
  let attempts = 0

  await assert.rejects(
    requestFrameCheck(validImages(), {
      apiKey: 'test-secret',
      timeoutMs: 20,
      fetchImpl: async (url, options) => {
        attempts += 1
        observedSignal = options.signal

        return new Promise((resolve, reject) => {
          options.signal.addEventListener('abort', () => {
            abortObserved = true
            const error = new Error('aborted')
            error.name = 'AbortError'
            reject(error)
          }, { once: true })
        })
      },
    }),
    (error) => assertPublicError(error, {
      status: 504,
      code: 'AI_TIMEOUT',
      message: 'The AI frame check timed out. Please try again.',
    }),
  )

  assert.equal(attempts, 1)
  assert.equal(observedSignal.aborted, true)
  assert.equal(abortObserved, true)
})

test('createApp handles method, JSON, and image errors without taking down later requests', async () => {
  let providerCalls = 0
  const app = await createApp({
    mode: 'production',
    frameCheckOptions: {
      apiKey: 'integration-secret',
      fetchImpl: async () => {
        providerCalls += 1
        return providerResponse(200, JSON.stringify({
          choices: [{ message: { content: 'Frame passes integration check.' } }],
        }))
      },
    },
  })
  const server = await listen(app)

  try {
    const getResponse = await fetch(`${server.baseUrl}/api/check-frame`)
    assert.equal(getResponse.status, 405)
    assert.equal(getResponse.headers.get('allow'), 'POST')
    assert.equal(getResponse.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await getResponse.json(), {
      error: 'Use POST for frame checks',
      code: 'METHOD_NOT_ALLOWED',
    })

    const invalidJsonResponse = await fetch(`${server.baseUrl}/api/check-frame`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"images":',
    })
    assert.equal(invalidJsonResponse.status, 400)
    assert.deepEqual(await invalidJsonResponse.json(), {
      error: 'The frame request was not valid JSON',
      code: 'INVALID_JSON',
    })

    const oversizedResponse = await fetch(`${server.baseUrl}/api/check-frame`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ padding: 'x'.repeat(4 * 1024 * 1024) }),
    })
    assert.equal(oversizedResponse.status, 413)
    assert.deepEqual(await oversizedResponse.json(), {
      error: 'The frame images were too large to check',
      code: 'IMAGES_TOO_LARGE',
    })

    const malformedImages = validImages()
    malformedImages[0] = 'not-a-data-url'
    const malformedResponse = await fetch(`${server.baseUrl}/api/check-frame`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ images: malformedImages }),
    })
    assert.equal(malformedResponse.status, 400)
    assert.deepEqual(await malformedResponse.json(), {
      error: 'Image 1 must contain valid base64 JPEG data',
      code: 'INVALID_IMAGES',
    })
    assert.equal(providerCalls, 0)

    const successResponse = await fetch(`${server.baseUrl}/api/check-frame`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ images: validImages() }),
    })
    assert.equal(successResponse.status, 200)
    assert.equal(successResponse.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await successResponse.json(), {
      message: 'Frame passes integration check.',
    })
    assert.equal(providerCalls, 1)
  } finally {
    await server.close()
  }
})
