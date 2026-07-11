const video = document.querySelector('#video')
const canvas = document.querySelector('#canvas')
const startButton = document.querySelector('#start')
const backgroundButton = document.querySelector('#background')
const resetButton = document.querySelector('#reset')
const statusText = document.querySelector('#status')
const placeholder = document.querySelector('#placeholder')

const inputCanvas = document.createElement('canvas')
const outputCanvas = document.createElement('canvas')
const width = 640

let model
let savedBackground
let currentPeople = []
let selectedPoint
let running = false

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

function findSelectedPerson(people) {
  if (!selectedPoint) return -1

  let closestIndex = -1
  let closestDistance = Infinity

  people.forEach((person, index) => {
    const center = getCenter(person)
    if (!center) return

    const distance = Math.hypot(center.x - selectedPoint.x, center.y - selectedPoint.y)
    if (distance < closestDistance) {
      closestIndex = index
      closestDistance = distance
    }
  })

  if (closestIndex !== -1) {
    selectedPoint = getCenter(people[closestIndex])
  }

  return closestIndex
}

async function processFrame() {
  if (!running) return

  const inputContext = inputCanvas.getContext('2d', { willReadFrequently: true })
  const outputContext = outputCanvas.getContext('2d')
  const canvasContext = canvas.getContext('2d')

  inputContext.drawImage(video, 0, 0, inputCanvas.width, inputCanvas.height)

  try {
    currentPeople = await model.segmentMultiPerson(inputCanvas, {
      internalResolution: 'medium',
      segmentationThreshold: 0.68,
      maxDetections: 5,
      scoreThreshold: 0.2,
      nmsRadius: 20,
    })

    const liveFrame = inputContext.getImageData(0, 0, inputCanvas.width, inputCanvas.height)
    const result = new ImageData(new Uint8ClampedArray(liveFrame.data), liveFrame.width, liveFrame.height)
    const selectedIndex = findSelectedPerson(currentPeople)

    if (savedBackground && selectedIndex !== -1) {
      currentPeople.forEach((person, index) => {
        if (index === selectedIndex) return

        for (let pixel = 0; pixel < person.data.length; pixel++) {
          if (!person.data[pixel]) continue

          const color = pixel * 4
          result.data[color] = savedBackground.data[color]
          result.data[color + 1] = savedBackground.data[color + 1]
          result.data[color + 2] = savedBackground.data[color + 2]
        }
      })
    }

    outputContext.putImageData(result, 0, 0)
    canvasContext.save()
    canvasContext.translate(canvas.width, 0)
    canvasContext.scale(-1, 1)
    canvasContext.drawImage(outputCanvas, 0, 0, canvas.width, canvas.height)
    canvasContext.restore()
  } catch (error) {
    console.error(error)
  }

  setTimeout(processFrame, 30)
}

async function startCamera() {
  statusText.textContent = 'Starting camera...'
  startButton.disabled = true

  try {
    if (!navigator.mediaDevices) {
      throw new Error('Camera access only works on localhost or HTTPS')
    }

    const stream = await navigator.mediaDevices.getUserMedia({
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

    running = true
    startButton.disabled = true
    backgroundButton.disabled = false
    placeholder.hidden = true
    statusText.textContent = 'Camera is ready'
    processFrame()
  } catch (error) {
    statusText.textContent = error.message || 'Could not start the camera'
    startButton.disabled = false
  }
}

function captureBackground() {
  const context = inputCanvas.getContext('2d', { willReadFrequently: true })
  context.drawImage(video, 0, 0, inputCanvas.width, inputCanvas.height)
  savedBackground = context.getImageData(0, 0, inputCanvas.width, inputCanvas.height)
  resetButton.disabled = false
  statusText.textContent = 'Background saved. Step back in and click yourself.'
}

function selectPerson(event) {
  if (!model) return

  const box = canvas.getBoundingClientRect()
  const shownX = ((event.clientX - box.left) / box.width) * width
  const x = Math.floor(width - shownX)
  const y = Math.floor(((event.clientY - box.top) / box.height) * inputCanvas.height)
  const person = currentPeople.find((item) => item.data[y * item.width + x])

  if (!person) {
    statusText.textContent = 'No person found there. Try clicking your body.'
    return
  }

  selectedPoint = getCenter(person) || { x, y }
  resetButton.disabled = false
  statusText.textContent = 'Other detected people are now being removed'
}

function reset() {
  savedBackground = undefined
  selectedPoint = undefined
  resetButton.disabled = true
  statusText.textContent = 'Capture a new empty background'
}

startButton.addEventListener('click', startCamera)
backgroundButton.addEventListener('click', captureBackground)
resetButton.addEventListener('click', reset)
canvas.addEventListener('click', selectPerson)
