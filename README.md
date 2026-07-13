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

`npm run preview` builds the frontend and serves both `dist` and `/api/check-frame` through
Express. `npm start` serves an existing `dist` directory and respects `PORT`.
