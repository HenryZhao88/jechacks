# ClearFrame

ClearFrame is a browser demo that removes passersby from a webcam feed. TensorFlow.js and
BodyPix perform the live segmentation locally. An optional still-frame quality check uses the
Featherless vision API through a server-side proxy, so the API key is never sent to the browser.

## Local development

Requires Node.js 18 or newer.

```sh
npm install
```

Copy `.env.example` to `.env`, add your Featherless key, then run:

```sh
npm run dev
```

Open `http://localhost:5173`. The camera API works on localhost or HTTPS.

## Verification and production preview

```sh
npm test
npm run build
npm run preview
```

`npm run preview` builds the frontend and serves both `dist` and `/api/check-frame` through
Express. `npm start` serves an existing `dist` directory and respects `PORT`.

## Deployment

The `api/check-frame.js` function is ready for Vercel. Configure `FEATHERLESS_API_KEY` in the
deployment environment and optionally set `SITE_URL` and `FEATHERLESS_MODEL`. Frame-check
requests are intentionally limited to six compressed JPEGs and kept below Vercel's function
request limit.

The continuous camera feed stays in the browser. Clicking **Check frame with AI** uploads one
matched raw/processed still-frame pair and four processed crops to Featherless for analysis.

Before exposing the demo publicly, configure durable rate limiting, authentication, or bot
protection at the hosting edge. Request validation protects the provider contract, but a public
API proxy still needs an abuse-control policy tied to your deployment.
