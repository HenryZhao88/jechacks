import { handleFrameCheckRequest } from '../lib/frame-check.js'

export default function handler(request, response) {
  return handleFrameCheckRequest(request, response)
}
