const video = document.querySelector('#video')
const canvas = document.querySelector('#canvas')
const startButton = document.querySelector('#start')
const backgroundButton = document.querySelector('#background')
const resetButton = document.querySelector('#reset')
const checkButton = document.querySelector('#check')
const statusText = document.querySelector('#status')
const checkResult = document.querySelector('#check-result')
const placeholder = document.querySelector('#placeholder')

const inputCanvas = document.createElement('canvas')
const outputCanvas = document.createElement('canvas')
const maskCanvas = document.createElement('canvas')
const blurredMaskCanvas = document.createElement('canvas')
const selectedMaskCanvas = document.createElement('canvas')
const protectedMaskCanvas = document.createElement('canvas')
const captureCanvas = document.createElement('canvas')
const width = 640
const frameCheckTimeout = 55_000
const frameCheckBodyLimit = 3.8 * 1024 * 1024

let model
let savedBackground
let currentPeople = []
let allowedPeople = []
let currentAssignments = []
let removalHold
let lastLightMap
let backgroundCandidates
let backgroundCandidateAge
let running = false
let lastCommittedFrame
let sceneRevision = 0
let checkingFrame = false
let capturingBackground = false
let consecutiveProcessingErrors = 0
let cameraGeneration = 0
let backgroundCaptureId = 0
let frameCheckId = 0
let activeFrameCheckController

function refreshCheckButton() {
  const frameIsCurrent = lastCommittedFrame?.revision === sceneRevision
  checkButton.disabled = checkingFrame
    || capturingBackground
    || !running
    || !savedBackground
    || allowedPeople.length === 0
    || !frameIsCurrent
  checkButton.setAttribute('aria-busy', String(checkingFrame))
}

function markSceneChanged() {
  frameCheckId++
  activeFrameCheckController?.abort()
  activeFrameCheckController = undefined
  checkingFrame = false
  sceneRevision++
  checkResult.textContent = ''
  refreshCheckButton()
}

function releaseCamera() {
  cameraGeneration++
  backgroundCaptureId++
  frameCheckId++
  activeFrameCheckController?.abort()
  activeFrameCheckController = undefined
  running = false

  const stream = video.srcObject
  if (stream) stream.getTracks().forEach((track) => track.stop())
  video.srcObject = null
  model = undefined
  savedBackground = undefined
  allowedPeople = []
  currentPeople = []
  currentAssignments = []
  lastCommittedFrame = undefined
  lastLightMap = undefined
  removalHold = undefined
  backgroundCandidates = undefined
  backgroundCandidateAge = undefined
  capturingBackground = false
  checkingFrame = false
  sceneRevision++
  checkResult.textContent = ''

  canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height)
  placeholder.hidden = false
  startButton.disabled = false
  backgroundButton.disabled = true
  resetButton.disabled = true
  refreshCheckButton()
}

function getCenter(person) {
  let totalX = 0
  let totalY = 0
  let count = 0

  for (let y = 0; y < person.height; y += 8) {
    for (let x = 0; x < person.width; x += 8) {
      if (person.data[y * person.width + x]) {
        totalX += x
        totalY += y
        count++
      }
    }
  }

  if (count === 0) return null
  return { x: totalX / count, y: totalY / count }
}

function getAnchor(person) {
  const nose = person.pose?.keypoints.find((point) => point.part === 'nose' && point.score > 0.3)
  return nose?.position || getCenter(person)
}

function countMask(mask) {
  let count = 0
  for (let pixel = 0; pixel < mask.length; pixel++) {
    if (mask[pixel]) count++
  }
  return count
}

function getOwnerMask(person, entry, othersNearby) {
  const currentAnchor = getAnchor(person)
  const currentSize = countMask(person.data)

  if (!entry.ownerMask || !entry.ownerAnchor || !entry.ownerSize) {
    entry.ownerMask = new Uint8Array(person.data)
    entry.ownerAnchor = currentAnchor
    entry.ownerSize = currentSize
    return person.data
  }

  if (!othersNearby || currentSize < entry.ownerSize * 1.35) {
    entry.ownerMask = new Uint8Array(person.data)
    entry.ownerAnchor = currentAnchor
    entry.ownerSize = entry.ownerSize * 0.9 + currentSize * 0.1
    return person.data
  }

  entry.ownerSize = entry.ownerSize * 0.98 + currentSize * 0.02

  const shiftedMask = new Uint8Array(person.data.length)
  const moveX = Math.round(currentAnchor.x - entry.ownerAnchor.x)
  const moveY = Math.round(currentAnchor.y - entry.ownerAnchor.y)
  const offsets = [
    [0, 0], [-12, 0], [12, 0], [0, -12], [0, 12],
    [-12, -12], [12, -12], [-12, 12], [12, 12],
  ]

  for (let pixel = 0; pixel < entry.ownerMask.length; pixel++) {
    if (!entry.ownerMask[pixel]) continue
    const oldX = pixel % width
    const oldY = Math.floor(pixel / width)

    offsets.forEach(([extraX, extraY]) => {
      const x = oldX + moveX + extraX
      const y = oldY + moveY + extraY
      if (x < 0 || x >= width || y < 0 || y >= inputCanvas.height) return
      shiftedMask[y * width + x] = 1
    })
  }

  for (let pixel = 0; pixel < shiftedMask.length; pixel++) {
    shiftedMask[pixel] = shiftedMask[pixel] && person.data[pixel] ? 1 : 0
  }

  return shiftedMask
}

function getColors(person, frame) {
  const colors = new Array(64).fill(0)
  let count = 0

  for (let pixel = 0; pixel < person.data.length; pixel += 10) {
    if (!person.data[pixel]) continue

    const color = pixel * 4
    const red = Math.floor(frame.data[color] / 64)
    const green = Math.floor(frame.data[color + 1] / 64)
    const blue = Math.floor(frame.data[color + 2] / 64)
    colors[red * 16 + green * 4 + blue]++
    count++
  }

  if (count === 0) return colors
  return colors.map((amount) => amount / count)
}

function colorMatch(first, second) {
  let match = 0
  for (let i = 0; i < first.length; i++) {
    match += Math.min(first[i], second[i])
  }
  return match
}

function matchAllowedPeople(people, frame) {
  const assignments = new Array(people.length).fill(null)
  if (!allowedPeople.length || !people.length) {
    allowedPeople.forEach((entry) => entry.lostFrames++)
    return assignments
  }

  const personColors = people.map((person) => getColors(person, frame))
  const personAnchors = people.map((person) => getAnchor(person))
  const candidates = []

  allowedPeople.forEach((entry) => {
    people.forEach((person, index) => {
      const anchor = personAnchors[index]
      if (!anchor) return

      const match = colorMatch(entry.colors, personColors[index])
      const recentlySeen = entry.lostFrames <= 15

      if (recentlySeen) {
        const distance = Math.hypot(anchor.x - entry.point.x, anchor.y - entry.point.y)
        const score = match - Math.min(distance / width, 1) * 0.3
        if (match >= 0.45 && score >= 0.35) candidates.push({ entry, index, score, match })
      } else if (match >= 0.6) {
        candidates.push({ entry, index, score: match, match })
      }
    })
  })

  candidates.sort((first, second) => second.score - first.score)
  const usedEntries = new Set()

  candidates.forEach((candidate) => {
    if (usedEntries.has(candidate.entry) || assignments[candidate.index]) return
    usedEntries.add(candidate.entry)
    assignments[candidate.index] = candidate.entry
    candidate.entry.point = personAnchors[candidate.index]
    candidate.entry.lostFrames = 0

    if (candidate.match > 0.7) {
      candidate.entry.colors = candidate.entry.colors.map((amount, index) => {
        return amount * 0.95 + personColors[candidate.index][index] * 0.05
      })
    }
  })

  allowedPeople.forEach((entry) => {
    if (!usedEntries.has(entry)) entry.lostFrames++
  })

  return assignments
}

function makeRemovalMask(people, assignments) {
  const maskContext = maskCanvas.getContext('2d')
  const blurredContext = blurredMaskCanvas.getContext('2d')
  const selectedContext = selectedMaskCanvas.getContext('2d')
  const protectedContext = protectedMaskCanvas.getContext('2d')
  const mask = maskContext.createImageData(maskCanvas.width, maskCanvas.height)
  const selectedMask = selectedContext.createImageData(selectedMaskCanvas.width, selectedMaskCanvas.height)
  const matchedCount = assignments.filter(Boolean).length
  const othersNearby = people.length > matchedCount

  people.forEach((person, index) => {
    const entry = assignments[index]
    const protectedOwner = entry ? getOwnerMask(person, entry, othersNearby) : null

    for (let pixel = 0; pixel < person.data.length; pixel++) {
      if (!person.data[pixel]) continue
      if (protectedOwner?.[pixel]) continue
      const color = pixel * 4
      mask.data[color] = 255
      mask.data[color + 1] = 255
      mask.data[color + 2] = 255
      mask.data[color + 3] = 255
    }

    if (!protectedOwner) return

    for (let pixel = 0; pixel < protectedOwner.length; pixel++) {
      if (!protectedOwner[pixel]) continue
      const color = pixel * 4
      selectedMask.data[color] = 255
      selectedMask.data[color + 1] = 255
      selectedMask.data[color + 2] = 255
      selectedMask.data[color + 3] = 255
    }
  })

  for (let pixel = 0; pixel < removalHold.length; pixel++) {
    const alpha = pixel * 4 + 3

    if (mask.data[alpha]) {
      removalHold[pixel] = 1
    } else if (removalHold[pixel]) {
      mask.data[alpha - 3] = 255
      mask.data[alpha - 2] = 255
      mask.data[alpha - 1] = 255
      mask.data[alpha] = 255
      removalHold[pixel]--
    }
  }

  maskContext.putImageData(mask, 0, 0)
  selectedContext.putImageData(selectedMask, 0, 0)
  blurredContext.clearRect(0, 0, blurredMaskCanvas.width, blurredMaskCanvas.height)
  protectedContext.clearRect(0, 0, protectedMaskCanvas.width, protectedMaskCanvas.height)
  blurredContext.filter = 'blur(8px)'

  const spread = 10
  const offsets = [
    [0, 0],
    [-spread, 0],
    [spread, 0],
    [0, -spread],
    [0, spread],
    [-spread, -spread],
    [spread, -spread],
    [-spread, spread],
    [spread, spread],
  ]

  offsets.forEach(([x, y]) => blurredContext.drawImage(maskCanvas, x, y))
  blurredContext.filter = 'none'
  blurredContext.drawImage(maskCanvas, 0, 0)

  protectedContext.filter = 'blur(2px)'
  protectedContext.drawImage(selectedMaskCanvas, -2, 0)
  protectedContext.drawImage(selectedMaskCanvas, 2, 0)
  protectedContext.drawImage(selectedMaskCanvas, 0, -2)
  protectedContext.drawImage(selectedMaskCanvas, 0, 2)
  protectedContext.drawImage(selectedMaskCanvas, 0, 0)
  protectedContext.filter = 'none'

  const removal = blurredContext.getImageData(0, 0, blurredMaskCanvas.width, blurredMaskCanvas.height)
  const protection = protectedContext.getImageData(0, 0, protectedMaskCanvas.width, protectedMaskCanvas.height)

  return { removal, protection }
}

function getColorCorrection(liveFrame, people, removalMask) {
  const channels = [0, 1, 2].map(() => ({ x: 0, y: 0, xx: 0, xy: 0, count: 0 }))

  for (let y = 0; y < inputCanvas.height; y += 8) {
    for (let x = 0; x < width; x += 8) {
      const pixel = y * width + x
      if (people.some((person) => person.data[pixel])) continue
      if (removalMask.data[pixel * 4 + 3] > 8) continue

      const color = pixel * 4
      channels.forEach((channel, index) => {
        const oldValue = savedBackground.data[color + index]
        const liveValue = liveFrame.data[color + index]
        channel.x += oldValue
        channel.y += liveValue
        channel.xx += oldValue * oldValue
        channel.xy += oldValue * liveValue
        channel.count++
      })
    }
  }

  return channels.map((channel) => {
    const bottom = channel.count * channel.xx - channel.x * channel.x
    let gain = bottom ? (channel.count * channel.xy - channel.x * channel.y) / bottom : 1
    gain = Math.max(0.75, Math.min(1.25, gain))
    let offset = channel.count ? (channel.y - gain * channel.x) / channel.count : 0
    offset = Math.max(-50, Math.min(50, offset))
    return { gain, offset }
  })
}

function getLightMap(liveFrame, people, correction, removalMask) {
  const columns = 8
  const rows = 5
  const cells = []
  let totalRed = 0
  let totalGreen = 0
  let totalBlue = 0
  let totalCount = 0

  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      let red = 0
      let green = 0
      let blue = 0
      let count = 0
      const startX = Math.floor(column * width / columns)
      const endX = Math.floor((column + 1) * width / columns)
      const startY = Math.floor(row * inputCanvas.height / rows)
      const endY = Math.floor((row + 1) * inputCanvas.height / rows)

      for (let y = startY; y < endY; y += 6) {
        for (let x = startX; x < endX; x += 6) {
          const pixel = y * width + x
          if (people.some((person) => person.data[pixel])) continue
          if (removalMask.data[pixel * 4 + 3] > 8) continue

          const color = pixel * 4
          red += liveFrame.data[color] - (savedBackground.data[color] * correction[0].gain + correction[0].offset)
          green += liveFrame.data[color + 1] - (savedBackground.data[color + 1] * correction[1].gain + correction[1].offset)
          blue += liveFrame.data[color + 2] - (savedBackground.data[color + 2] * correction[2].gain + correction[2].offset)
          count++
        }
      }

      if (count) {
        totalRed += red
        totalGreen += green
        totalBlue += blue
        totalCount += count
      }

      cells.push(count ? { red: red / count, green: green / count, blue: blue / count } : null)
    }
  }

  const fallback = totalCount ? {
    red: totalRed / totalCount,
    green: totalGreen / totalCount,
    blue: totalBlue / totalCount,
  } : { red: 0, green: 0, blue: 0 }

  const lightMap = { columns, rows, cells: cells.map((cell) => cell || fallback) }

  if (lastLightMap) {
    lightMap.cells = lightMap.cells.map((cell, index) => {
      const previous = lastLightMap.cells[index]
      return {
        red: previous.red * 0.8 + cell.red * 0.2,
        green: previous.green * 0.8 + cell.green * 0.2,
        blue: previous.blue * 0.8 + cell.blue * 0.2,
      }
    })
  }

  lastLightMap = lightMap
  return lightMap
}

function updateBackground(liveFrame, people, removalMask, correction) {
  const covered = new Uint8Array(width * inputCanvas.height)

  people.forEach((person) => {
    for (let pixel = 0; pixel < person.data.length; pixel++) {
      if (person.data[pixel]) covered[pixel] = 1
    }
  })

  for (let pixel = 0; pixel < covered.length; pixel++) {
    if (covered[pixel] || removalMask.data[pixel * 4 + 3] > 8) {
      backgroundCandidateAge[pixel] = 0
      continue
    }

    const color = pixel * 4
    const candidate = pixel * 3

    const redDifference = Math.abs(liveFrame.data[color] - (savedBackground.data[color] * correction[0].gain + correction[0].offset))
    const greenDifference = Math.abs(liveFrame.data[color + 1] - (savedBackground.data[color + 1] * correction[1].gain + correction[1].offset))
    const blueDifference = Math.abs(liveFrame.data[color + 2] - (savedBackground.data[color + 2] * correction[2].gain + correction[2].offset))
    const averageDifference = (redDifference + greenDifference + blueDifference) / 3

    const targetRed = (liveFrame.data[color] - correction[0].offset) / correction[0].gain
    const targetGreen = (liveFrame.data[color + 1] - correction[1].offset) / correction[1].gain
    const targetBlue = (liveFrame.data[color + 2] - correction[2].offset) / correction[2].gain

    if (averageDifference <= 20 && redDifference <= 30 && greenDifference <= 30 && blueDifference <= 30) {
      savedBackground.data[color] = savedBackground.data[color] * 0.997 + targetRed * 0.003
      savedBackground.data[color + 1] = savedBackground.data[color + 1] * 0.997 + targetGreen * 0.003
      savedBackground.data[color + 2] = savedBackground.data[color + 2] * 0.997 + targetBlue * 0.003
      backgroundCandidateAge[pixel] = 0
      continue
    }

    const matchesCandidate = backgroundCandidateAge[pixel] > 0
      && Math.abs(liveFrame.data[color] - backgroundCandidates[candidate]) < 10
      && Math.abs(liveFrame.data[color + 1] - backgroundCandidates[candidate + 1]) < 10
      && Math.abs(liveFrame.data[color + 2] - backgroundCandidates[candidate + 2]) < 10

    if (matchesCandidate) {
      backgroundCandidateAge[pixel] = Math.min(255, backgroundCandidateAge[pixel] + 1)
    } else {
      backgroundCandidates[candidate] = liveFrame.data[color]
      backgroundCandidates[candidate + 1] = liveFrame.data[color + 1]
      backgroundCandidates[candidate + 2] = liveFrame.data[color + 2]
      backgroundCandidateAge[pixel] = 1
    }

    if (backgroundCandidateAge[pixel] >= 5) {
      savedBackground.data[color] = savedBackground.data[color] * 0.65 + targetRed * 0.35
      savedBackground.data[color + 1] = savedBackground.data[color + 1] * 0.65 + targetGreen * 0.35
      savedBackground.data[color + 2] = savedBackground.data[color + 2] * 0.65 + targetBlue * 0.35
    }
  }
}

function getLocalLight(x, y, lightMap) {
  const columnPosition = x / (width - 1) * (lightMap.columns - 1)
  const rowPosition = y / (inputCanvas.height - 1) * (lightMap.rows - 1)
  const left = Math.floor(columnPosition)
  const right = Math.min(lightMap.columns - 1, left + 1)
  const top = Math.floor(rowPosition)
  const bottom = Math.min(lightMap.rows - 1, top + 1)
  const horizontalAmount = columnPosition - left
  const verticalAmount = rowPosition - top

  const topLeft = lightMap.cells[top * lightMap.columns + left]
  const topRight = lightMap.cells[top * lightMap.columns + right]
  const bottomLeft = lightMap.cells[bottom * lightMap.columns + left]
  const bottomRight = lightMap.cells[bottom * lightMap.columns + right]

  function blend(name) {
    const topValue = topLeft[name] * (1 - horizontalAmount) + topRight[name] * horizontalAmount
    const bottomValue = bottomLeft[name] * (1 - horizontalAmount) + bottomRight[name] * horizontalAmount
    return topValue * (1 - verticalAmount) + bottomValue * verticalAmount
  }

  return {
    red: Math.max(-40, Math.min(40, blend('red'))),
    green: Math.max(-40, Math.min(40, blend('green'))),
    blue: Math.max(-40, Math.min(40, blend('blue'))),
  }
}

async function processFrame(generation) {
  if (!running || generation !== cameraGeneration) return

  let nextFrameDelay = 30

  try {
    const inputContext = inputCanvas.getContext('2d', { willReadFrequently: true })
    const outputContext = outputCanvas.getContext('2d')
    const canvasContext = canvas.getContext('2d')

    inputContext.drawImage(video, 0, 0, inputCanvas.width, inputCanvas.height)
    const people = await model.segmentMultiPerson(inputCanvas, {
      internalResolution: 'high',
      segmentationThreshold: 0.53,
      maxDetections: 5,
      scoreThreshold: 0.2,
      nmsRadius: 20,
    })

    if (!running || generation !== cameraGeneration) return

    const liveFrame = inputContext.getImageData(0, 0, inputCanvas.width, inputCanvas.height)
    const result = new ImageData(new Uint8ClampedArray(liveFrame.data), liveFrame.width, liveFrame.height)
    const assignments = matchAllowedPeople(people, liveFrame)
    const processedRevision = sceneRevision

    if (savedBackground && allowedPeople.length > 0) {
      const masks = makeRemovalMask(people, assignments)
      const mask = masks.removal

      for (let pixel = 0; pixel < mask.width * mask.height; pixel++) {
        const alpha = pixel * 4 + 3
        mask.data[alpha] *= 1 - masks.protection.data[alpha] / 255
      }

      const correction = getColorCorrection(liveFrame, people, mask)
      const lightMap = getLightMap(liveFrame, people, correction, mask)

      for (let pixel = 0; pixel < mask.width * mask.height; pixel++) {
        const color = pixel * 4
        const amount = mask.data[color + 3] / 255
        if (amount === 0) continue

        const x = pixel % width
        const y = Math.floor(pixel / width)
        const light = getLocalLight(x, y, lightMap)

        const backgroundRed = savedBackground.data[color] * correction[0].gain + correction[0].offset + light.red
        const backgroundGreen = savedBackground.data[color + 1] * correction[1].gain + correction[1].offset + light.green
        const backgroundBlue = savedBackground.data[color + 2] * correction[2].gain + correction[2].offset + light.blue

        result.data[color] = liveFrame.data[color] * (1 - amount) + backgroundRed * amount
        result.data[color + 1] = liveFrame.data[color + 1] * (1 - amount) + backgroundGreen * amount
        result.data[color + 2] = liveFrame.data[color + 2] * (1 - amount) + backgroundBlue * amount
      }

      updateBackground(liveFrame, people, mask, correction)
    }

    outputContext.putImageData(result, 0, 0)
    canvasContext.save()
    canvasContext.translate(canvas.width, 0)
    canvasContext.scale(-1, 1)
    canvasContext.drawImage(outputCanvas, 0, 0, canvas.width, canvas.height)
    canvasContext.restore()

    currentPeople = people
    currentAssignments = assignments
    lastCommittedFrame = { raw: liveFrame, processed: result, revision: processedRevision }
    refreshCheckButton()

    if (consecutiveProcessingErrors) statusText.textContent = 'Camera processing recovered'
    consecutiveProcessingErrors = 0
  } catch (error) {
    if (generation !== cameraGeneration) return
    console.error(error)
    consecutiveProcessingErrors++

    if (consecutiveProcessingErrors >= 5) {
      releaseCamera()
      statusText.textContent = 'Camera processing stopped after repeated errors. Start the camera to retry.'
    } else {
      statusText.textContent = 'Camera processing was interrupted. Retrying...'
      nextFrameDelay = Math.min(1_000, 100 * (2 ** (consecutiveProcessingErrors - 1)))
    }
  } finally {
    if (running && generation === cameraGeneration) {
      setTimeout(() => processFrame(generation), nextFrameDelay)
    }
  }
}

async function startCamera() {
  const generation = ++cameraGeneration
  statusText.textContent = 'Starting camera...'
  startButton.disabled = true
  let stream

  try {
    if (!navigator.mediaDevices) {
      throw new Error('Camera access only works on localhost or HTTPS')
    }

    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 1280, height: 720, facingMode: 'user' },
      audio: false,
    })

    video.srcObject = stream
    await video.play()

    const ratio = video.videoHeight / video.videoWidth || 9 / 16
    const height = Math.round(width * ratio)
    inputCanvas.width = width
    inputCanvas.height = height
    outputCanvas.width = width
    outputCanvas.height = height
    maskCanvas.width = width
    maskCanvas.height = height
    blurredMaskCanvas.width = width
    blurredMaskCanvas.height = height
    selectedMaskCanvas.width = width
    selectedMaskCanvas.height = height
    protectedMaskCanvas.width = width
    protectedMaskCanvas.height = height
    captureCanvas.width = width
    captureCanvas.height = height
    removalHold = new Uint8Array(width * height)
    backgroundCandidates = new Uint8ClampedArray(width * height * 3)
    backgroundCandidateAge = new Uint8Array(width * height)
    canvas.width = 1280
    canvas.height = Math.round(1280 * ratio)

    statusText.textContent = 'Loading person detection'
    await import('@tensorflow/tfjs')
    await import('@tensorflow/tfjs-backend-webgl')
    const bodyPix = await import('@tensorflow-models/body-pix')
    model = await bodyPix.load({
      architecture: 'MobileNetV1',
      outputStride: 16,
      multiplier: 0.75,
      quantBytes: 2,
    })

    if (!stream.active || stream.getVideoTracks()[0]?.readyState !== 'live') {
      throw new Error('The camera stopped while person detection was loading. Start it again to retry.')
    }

    stream.getVideoTracks()[0]?.addEventListener('ended', () => {
      if (video.srcObject !== stream) return
      releaseCamera()
      statusText.textContent = 'Camera stopped. Start it again to continue.'
    })

    running = true
    consecutiveProcessingErrors = 0
    startButton.disabled = true
    backgroundButton.disabled = false
    placeholder.hidden = true
    statusText.textContent = 'Camera is ready'
    refreshCheckButton()
    processFrame(generation)
  } catch (error) {
    stream?.getTracks().forEach((track) => track.stop())
    if (video.srcObject === stream) video.srcObject = null
    model = undefined
    running = false
    statusText.textContent = error.message || 'Could not start the camera'
    startButton.disabled = false
    backgroundButton.disabled = true
    refreshCheckButton()
  }
}

async function captureBackground() {
  const operationId = ++backgroundCaptureId
  const generation = cameraGeneration
  const startingRevision = sceneRevision
  capturingBackground = true
  backgroundButton.disabled = true
  refreshCheckButton()
  statusText.textContent = 'Capturing background. Keep the room empty...'

  try {
    const stream = video.srcObject
    if (!running || !stream?.active || video.readyState < 2) {
      throw new Error('The camera is not ready. Start it again and retry.')
    }

    const context = captureCanvas.getContext('2d', { willReadFrequently: true })
    const totals = new Float32Array(width * inputCanvas.height * 4)
    const frameCount = 12

    for (let frameNumber = 0; frameNumber < frameCount; frameNumber++) {
      if (operationId !== backgroundCaptureId
        || generation !== cameraGeneration
        || startingRevision !== sceneRevision
        || !running) {
        throw new Error('Background capture was cancelled')
      }

      context.drawImage(video, 0, 0, captureCanvas.width, captureCanvas.height)
      const frame = context.getImageData(0, 0, captureCanvas.width, captureCanvas.height)

      for (let i = 0; i < frame.data.length; i++) {
        totals[i] += frame.data[i]
      }

      await new Promise((resolve) => setTimeout(resolve, 40))
    }

    if (operationId !== backgroundCaptureId
      || generation !== cameraGeneration
      || startingRevision !== sceneRevision
      || !running) {
      throw new Error('Background capture was cancelled')
    }

    const average = new Uint8ClampedArray(totals.length)
    for (let i = 0; i < totals.length; i++) {
      average[i] = totals[i] / frameCount
    }

    const nextBackground = new ImageData(average, width, inputCanvas.height)
    removalHold.fill(0)
    backgroundCandidateAge.fill(0)
    allowedPeople = []
    currentPeople = []
    currentAssignments = []
    lastCommittedFrame = undefined
    lastLightMap = undefined
    savedBackground = nextBackground
    resetButton.disabled = false
    markSceneChanged()
    statusText.textContent = 'Background saved. Step back in and click each person allowed on camera.'
  } catch (error) {
    const operationIsCurrent = operationId === backgroundCaptureId
      && generation === cameraGeneration
      && startingRevision === sceneRevision
    if (operationIsCurrent) statusText.textContent = error.message || 'Could not capture the background'
  } finally {
    if (operationId === backgroundCaptureId) {
      capturingBackground = false
      backgroundButton.disabled = !running
      refreshCheckButton()
    }
  }
}

function selectPerson(event) {
  if (!model || !lastCommittedFrame) return

  const box = canvas.getBoundingClientRect()
  const shownX = Math.floor(((event.clientX - box.left) / box.width) * width)
  const shownY = Math.floor(((event.clientY - box.top) / box.height) * inputCanvas.height)
  const x = Math.max(0, Math.min(width - 1, width - 1 - shownX))
  const y = Math.max(0, Math.min(inputCanvas.height - 1, shownY))
  const personIndex = currentPeople.findIndex((item) => item.data[y * item.width + x])

  if (personIndex === -1) {
    statusText.textContent = 'No person found there. Try clicking their body.'
    return
  }

  const existing = currentAssignments[personIndex]

  if (existing) {
    allowedPeople = allowedPeople.filter((entry) => entry !== existing)
    currentAssignments[personIndex] = null
    markSceneChanged()
    statusText.textContent = allowedPeople.length
      ? `Removed them. ${allowedPeople.length} allowed on camera`
      : 'Nobody selected — showing everyone. Click people to allow them.'
    return
  }

  const person = currentPeople[personIndex]
  const anchor = getAnchor(person) || { x, y }
  const frame = lastCommittedFrame.raw
  const entry = {
    colors: getColors(person, frame),
    point: anchor,
    lostFrames: 0,
    ownerMask: new Uint8Array(person.data),
    ownerAnchor: anchor,
    ownerSize: countMask(person.data),
  }

  allowedPeople.push(entry)
  currentAssignments[personIndex] = entry
  resetButton.disabled = false
  markSceneChanged()
  statusText.textContent = `${allowedPeople.length} allowed on camera. Everyone else is removed`
}

function reset() {
  savedBackground = undefined
  allowedPeople = []
  currentAssignments = []
  removalHold?.fill(0)
  backgroundCandidateAge?.fill(0)
  lastLightMap = undefined
  resetButton.disabled = true
  markSceneChanged()
  statusText.textContent = 'Capture a new empty background'
}

function createMirroredCanvas(imageData) {
  const source = document.createElement('canvas')
  source.width = imageData.width
  source.height = imageData.height
  source.getContext('2d').putImageData(imageData, 0, 0)

  const mirrored = document.createElement('canvas')
  mirrored.width = imageData.width
  mirrored.height = imageData.height
  const context = mirrored.getContext('2d')
  context.translate(mirrored.width, 0)
  context.scale(-1, 1)
  context.drawImage(source, 0, 0)
  return mirrored
}

async function checkFrame() {
  const snapshot = lastCommittedFrame
  if (!snapshot || snapshot.revision !== sceneRevision || !savedBackground || !allowedPeople.length) {
    checkResult.textContent = 'Capture a background, select an allowed person, and wait for the next frame.'
    refreshCheckButton()
    return
  }

  checkingFrame = true
  refreshCheckButton()
  checkResult.textContent = 'Checking frame...'
  const operationId = ++frameCheckId
  const controller = new AbortController()
  activeFrameCheckController = controller
  const timeout = setTimeout(() => controller.abort(), frameCheckTimeout)

  try {
    const processedCanvas = createMirroredCanvas(snapshot.processed)
    const rawCanvas = createMirroredCanvas(snapshot.raw)

    const images = [
      processedCanvas.toDataURL('image/jpeg', 0.82),
      rawCanvas.toDataURL('image/jpeg', 0.82),
    ]
    const detailCanvas = document.createElement('canvas')
    const detailContext = detailCanvas.getContext('2d')
    const sourceWidth = Math.floor(processedCanvas.width / 2)
    const sourceHeight = Math.floor(processedCanvas.height / 2)
    detailCanvas.width = processedCanvas.width
    detailCanvas.height = processedCanvas.height

    for (let row = 0; row < 2; row++) {
      for (let column = 0; column < 2; column++) {
        detailContext.clearRect(0, 0, detailCanvas.width, detailCanvas.height)
        detailContext.drawImage(
          processedCanvas,
          column * sourceWidth,
          row * sourceHeight,
          sourceWidth,
          sourceHeight,
          0,
          0,
          detailCanvas.width,
          detailCanvas.height,
        )
        images.push(detailCanvas.toDataURL('image/jpeg', 0.82))
      }
    }

    const requestBody = JSON.stringify({ images })
    if (new TextEncoder().encode(requestBody).byteLength > frameCheckBodyLimit) {
      throw new Error('The frame images are too large to upload. Try again with a less detailed scene.')
    }

    const response = await fetch('/api/check-frame', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: requestBody,
      signal: controller.signal,
    })

    const responseText = await response.text()
    let result

    try {
      result = JSON.parse(responseText)
    } catch {
      throw new Error(`AI check returned an invalid response (${response.status})`)
    }

    if (!response.ok) {
      throw new Error(typeof result?.error === 'string' ? result.error : 'Frame check failed')
    }

    if (typeof result?.message !== 'string' || !result.message.trim()) {
      throw new Error('AI check returned an empty response')
    }

    if (operationId === frameCheckId && sceneRevision === snapshot.revision) {
      checkResult.textContent = result.message.trim()
    }
  } catch (error) {
    if (operationId === frameCheckId && sceneRevision === snapshot.revision) {
      checkResult.textContent = error.name === 'AbortError'
        ? 'The AI frame check timed out. Please try again.'
        : error.message || 'The frame check failed'
    }
  } finally {
    clearTimeout(timeout)
    if (operationId === frameCheckId) {
      activeFrameCheckController = undefined
      checkingFrame = false
      refreshCheckButton()
    }
  }
}

startButton.addEventListener('click', startCamera)
backgroundButton.addEventListener('click', captureBackground)
resetButton.addEventListener('click', reset)
checkButton.addEventListener('click', checkFrame)
canvas.addEventListener('click', selectPerson)
