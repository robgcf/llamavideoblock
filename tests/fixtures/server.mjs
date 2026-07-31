/**
 * Fixture server for the LlamaAutoPlayBlock test suite.
 *
 * Local and dependency-free on purpose: tests must not depend on YouTube or Facebook
 * being reachable, unchanged, or in the mood.
 *
 * The test media is a WAV generated here rather than a committed binary. WAV is the one
 * media container that can be written from scratch with no encoder, and a `<video>`
 * element playing an audio-only source still exercises the whole `HTMLMediaElement` path
 * — `paused`, `currentTime`, the `play` event, and the `play()` promise all behave
 * exactly as they would with an encoded video.
 *
 * Run directly (`node tests/fixtures/server.mjs`); playwright.config.js starts it.
 */

import { createServer } from 'node:http';

const PORT = Number(process.env.LLAMAAUTOPLAYBLOCK_FIXTURE_PORT ?? 8787);
const HOST = '127.0.0.1';

/**
 * A silent 16-bit mono PCM WAV. Long enough that a test can never mistake "finished" for
 * "never started", silent so a headed run is not annoying.
 *
 * @param {number} seconds
 * @returns {Buffer}
 */
function silentWav(seconds) {
  const sampleRate = 8000;
  const bytesPerSample = 2;
  const dataBytes = sampleRate * bytesPerSample * seconds;

  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * bytesPerSample, 28); // byte rate
  header.writeUInt16LE(bytesPerSample, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataBytes, 40);

  return Buffer.concat([header, Buffer.alloc(dataBytes)]);
}

const MEDIA = silentWav(30);

/**
 * @param {string} body
 * @returns {string}
 */
function page(body) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>LlamaAutoPlayBlock fixture</title></head>
<body>
${body}
</body>
</html>`;
}

/**
 * Records how a `play()` promise settled so tests can assert on the rejection *reason*,
 * not just on the paused state. Blocking with the wrong error would still leave the video
 * paused, but would break real sites.
 */
const PLAY_PROBE = `
  window.__playResult = { settled: false };
  function probe(promise) {
    if (!promise || typeof promise.then !== 'function') {
      window.__playResult = { settled: true, ok: true, name: 'no-promise' };
      return;
    }
    promise.then(
      () => { window.__playResult = { settled: true, ok: true, name: null }; },
      (error) => { window.__playResult = { settled: true, ok: false, name: error && error.name }; },
    );
  }
`;

/** @type {Record<string, string>} */
const PAGES = {
  // Declarative autoplay — the plain `<video autoplay>` case.
  '/attr-video': page(`
    <video id="media" src="/media.wav" autoplay></video>
  `),

  // Declarative autoplay on an audio element (spec §3).
  '/attr-audio': page(`
    <audio id="media" src="/media.wav" autoplay></audio>
  `),

  // JS-initiated autoplay — how YouTube, Facebook, and every modern player start media.
  '/js-play': page(`
    <video id="media" src="/media.wav"></video>
    <script>
      ${PLAY_PROBE}
      probe(document.getElementById('media').play());
    </script>
  `),

  // SPA case: media injected well after load, which is what YouTube does when you
  // navigate between videos without a page reload.
  '/dynamic': page(`
    <div id="host"></div>
    <script>
      setTimeout(function () {
        var video = document.createElement('video');
        video.id = 'media';
        video.src = '/media.wav';
        video.autoplay = true;
        document.getElementById('host').appendChild(video);
      }, 300);
    </script>
  `),

  // A real click must still start playback.
  '/user-click': page(`
    <video id="media" src="/media.wav"></video>
    <button id="go" type="button">Play</button>
    <script>
      ${PLAY_PROBE}
      document.getElementById('go').addEventListener('click', function () {
        probe(document.getElementById('media').play());
      });
    </script>
  `),

  // A click, then playback attempted long afterwards — the shape of "user clicked a
  // thumbnail, navigation happened, and the player autoplayed seconds later". The click is
  // real, but by the time play() arrives it is stale and must not count as consent.
  '/delayed-play': page(`
    <video id="media" src="/media.wav"></video>
    <button id="go" type="button">Click me</button>
    <script>
      ${PLAY_PROBE}
      document.getElementById('go').addEventListener('click', function () {
        setTimeout(function () {
          probe(document.getElementById('media').play());
        }, 2500);
      });
    </script>
  `),

  // Two elements, so the blocked tally has something to add up.
  '/two-videos': page(`
    <video id="media" src="/media.wav" autoplay></video>
    <video id="media-2" src="/media.wav" autoplay></video>
  `),

  // Media inside a same-origin iframe, to prove all_frames injection works.
  '/framed': page(`
    <iframe id="frame" src="/attr-video" width="320" height="180"></iframe>
  `),
};

const server = createServer((request, response) => {
  const path = new URL(request.url ?? '/', `http://${HOST}:${PORT}`).pathname;

  // Chrome asks for this on every navigation; answering keeps console checks clean.
  if (path === '/favicon.ico') {
    response.writeHead(204);
    response.end();
    return;
  }

  if (path === '/health') {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('ok');
    return;
  }

  if (path === '/media.wav') {
    response.writeHead(200, {
      'content-type': 'audio/wav',
      'content-length': String(MEDIA.length),
      'accept-ranges': 'none',
      'cache-control': 'no-store',
    });
    response.end(MEDIA);
    return;
  }

  const html = PAGES[path];
  if (html !== undefined) {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(html);
    return;
  }

  response.writeHead(404, { 'content-type': 'text/plain' });
  response.end('not found');
});

server.listen(PORT, HOST, () => {
  console.log(`LlamaAutoPlayBlock fixtures on http://${HOST}:${PORT}`);
});
