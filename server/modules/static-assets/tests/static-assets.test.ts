import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';

import express from 'express';

import { createStaticAssetsMiddleware } from '@/modules/static-assets/index.js';

// compression only compresses bodies at or above this size (its default `threshold`).
// Fixture bodies are kept above it so a "not compressed" assertion is attributable to
// the content-type filter rather than to the size floor.
const COMPRESSION_THRESHOLD_BYTES = 1024;

type StaticAssetsFixture = {
  root: string;
  distDir: string;
  publicDir: string;
  scriptName: string;
  scriptBytes: Buffer;
  indexBytes: Buffer;
  pngBytes: Buffer;
};

type RawResponse = {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
};

// --------------------------- PNG fixture ---------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = -1;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const payload = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(payload));
  return Buffer.concat([length, payload, crc]);
}

/**
 * Builds a genuine PNG whose pixels are pseudo-random, so its IDAT stays
 * incompressible and the fixture really is an already-compressed asset.
 */
function createPngFixture(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: truecolour
  // bytes 10-12 stay zero: deflate compression, adaptive filtering, no interlace.

  // Each scanline is prefixed with its filter type byte (0 = None).
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (1 + width * 3);
    raw[rowStart] = 0;
    for (let x = 0; x < width * 3; x += 1) {
      raw[rowStart + 1 + x] = (y * 31 + x * 17 + ((y * x) % 251)) % 256;
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// --------------------------- fixture ---------------------------

function createFixture(): StaticAssetsFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'static-assets-'));
  const distDir = path.join(root, 'dist');
  const publicDir = path.join(root, 'public');
  fs.mkdirSync(path.join(distDir, 'assets'), { recursive: true });
  fs.mkdirSync(publicDir, { recursive: true });

  // >200 KB of highly compressible JS, standing in for the ~3 MB production bundle.
  const scriptLines: string[] = [];
  for (let index = 0; index < 4000; index += 1) {
    scriptLines.push(`export const staticAssetLine${index} = 'fixture line ${index} for compression coverage';`);
  }
  const scriptBytes = Buffer.from(scriptLines.join('\n'), 'utf8');
  assert.ok(scriptBytes.length > 200 * 1024, 'fixture script must exceed 200 KB');

  // The real dist/index.html is ~2.5 KB, i.e. above compression's 1 KB threshold;
  // the fixture mirrors that so the SPA-entry assertion is not vacuous.
  const scriptName = 'index-C0mpr3ss.js';
  const indexBytes = Buffer.from(
    [
      '<!doctype html>',
      '<html lang="en">',
      '  <head>',
      '    <meta charset="UTF-8" />',
      '    <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
      '    <title>Static Asset Compression Fixture</title>',
      '    <link rel="modulepreload" crossorigin href="/assets/vendor-C0mpr3ss.js" />',
      '    <link rel="modulepreload" crossorigin href="/assets/react-C0mpr3ss.js" />',
      '    <link rel="stylesheet" crossorigin href="/assets/index-C0mpr3ss.css" />',
      `    <script type="module" crossorigin src="/assets/${scriptName}"></script>`,
      '  </head>',
      '  <body>',
      '    <div id="root"></div>',
      '    <!-- Padding keeps this fixture above compression’s 1 KB body threshold,',
      '         matching the real built index.html this server serves in production. -->',
      `    <p>${'index entry padding '.repeat(40)}</p>`,
      '  </body>',
      '</html>',
      '',
    ].join('\n'),
    'utf8',
  );
  assert.ok(indexBytes.length > COMPRESSION_THRESHOLD_BYTES, 'fixture HTML must exceed the 1 KB threshold');

  const pngBytes = createPngFixture(64, 64);
  assert.ok(pngBytes.length > COMPRESSION_THRESHOLD_BYTES, 'fixture PNG must exceed the 1 KB threshold');

  fs.writeFileSync(path.join(distDir, 'assets', scriptName), scriptBytes);
  fs.writeFileSync(path.join(distDir, 'index.html'), indexBytes);
  fs.writeFileSync(path.join(distDir, 'assets', 'logo.png'), pngBytes);
  fs.writeFileSync(path.join(publicDir, 'api-docs.html'), '<!doctype html><title>public fixture</title>');

  return { root, distDir, publicDir, scriptName, scriptBytes, indexBytes, pngBytes };
}

// --------------------------- request helpers ---------------------------

function requestPath(baseUrl: string, requestPathValue: string, acceptEncoding?: string): Promise<RawResponse> {
  return new Promise<RawResponse>((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (acceptEncoding !== undefined) {
      headers['Accept-Encoding'] = acceptEncoding;
    }

    const request = http.request(new URL(requestPathValue, baseUrl), { method: 'GET', headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => {
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks),
        });
      });
    });
    request.on('error', reject);
    request.end();
  });
}

/** Decodes a response body according to its `Content-Encoding`, if any. */
function decodeBody(response: RawResponse): Buffer {
  const encoding = String(response.headers['content-encoding'] ?? 'identity').toLowerCase();
  if (encoding === 'gzip') {
    return zlib.gunzipSync(response.body);
  }
  if (encoding === 'br') {
    return zlib.brotliDecompressSync(response.body);
  }
  if (encoding === 'deflate') {
    return zlib.inflateSync(response.body);
  }
  return response.body;
}

async function withStaticAssetsServer(
  fixture: StaticAssetsFixture,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(createStaticAssetsMiddleware({
    distDir: fixture.distDir,
    publicDir: fixture.publicDir,
    // The entrypoint owns the dev-server redirect; the module only reports the miss.
    onMissingIndex: (_req, res) => {
      res.status(503).send('no built bundle');
    },
  }));

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

async function withFixture(run: (fixture: StaticAssetsFixture, baseUrl: string) => Promise<void>): Promise<void> {
  const fixture = createFixture();
  try {
    await withStaticAssetsServer(fixture, (baseUrl) => run(fixture, baseUrl));
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

// --------------------------- compression ---------------------------

test('gzip request for the bundle is compressed and decompresses byte-for-byte', async () => {
  await withFixture(async (fixture, baseUrl) => {
    const response = await requestPath(baseUrl, `/assets/${fixture.scriptName}`, 'gzip');

    assert.equal(response.status, 200);
    assert.equal(response.headers['content-encoding'], 'gzip');
    // `compression` drops Content-Length in favour of chunked transfer, so the
    // "much smaller" invariant is measured on the bytes actually transferred.
    assert.equal(response.headers['content-length'], undefined);
    assert.deepEqual(decodeBody(response), fixture.scriptBytes);
    assert.ok(
      response.body.length < fixture.scriptBytes.length / 2,
      `expected compressed body well below ${fixture.scriptBytes.length} bytes, got ${response.body.length}`,
    );
  });
});

test('compressed responses advertise Vary: Accept-Encoding', async () => {
  await withFixture(async (fixture, baseUrl) => {
    const response = await requestPath(baseUrl, `/assets/${fixture.scriptName}`, 'gzip');

    assert.equal(String(response.headers.vary).toLowerCase(), 'accept-encoding');
  });
});

test('a client that does not offer an encoding receives the raw file', async () => {
  await withFixture(async (fixture, baseUrl) => {
    const response = await requestPath(baseUrl, `/assets/${fixture.scriptName}`);

    assert.equal(response.status, 200);
    assert.equal(response.headers['content-encoding'], undefined);
    assert.deepEqual(response.body, fixture.scriptBytes);
  });
});

test('brotli is negotiated when the client offers it', async () => {
  await withFixture(async (fixture, baseUrl) => {
    const response = await requestPath(baseUrl, `/assets/${fixture.scriptName}`, 'br');

    // Node >= 18 always has brotli, so `compression` prefers `br` over gzip here.
    assert.equal(response.headers['content-encoding'], 'br');
    assert.deepEqual(decodeBody(response), fixture.scriptBytes);
  });
});

test('an already-compressed PNG is not recompressed', async () => {
  await withFixture(async (fixture, baseUrl) => {
    const response = await requestPath(baseUrl, '/assets/logo.png', 'gzip');

    assert.equal(response.status, 200);
    assert.equal(response.headers['content-encoding'], undefined);
    assert.deepEqual(response.body, fixture.pngBytes);
  });
});

// --------------------------- cache headers ---------------------------

test('hashed assets keep their immutable cache header while compressed', async () => {
  await withFixture(async (fixture, baseUrl) => {
    const response = await requestPath(baseUrl, `/assets/${fixture.scriptName}`, 'gzip');

    assert.equal(response.headers['content-encoding'], 'gzip');
    assert.equal(response.headers['cache-control'], 'public, max-age=31536000, immutable');
  });
});

test('index.html served as a static file keeps its no-store cache header', async () => {
  await withFixture(async (fixture, baseUrl) => {
    const response = await requestPath(baseUrl, '/index.html');

    assert.equal(response.status, 200);
    assert.equal(response.headers['cache-control'], 'no-cache, no-store, must-revalidate');
    assert.equal(response.headers['pragma'], 'no-cache');
    assert.equal(response.headers['expires'], '0');
  });
});

test('SPA entry responses keep their no-store cache header', async () => {
  await withFixture(async (fixture, baseUrl) => {
    const response = await requestPath(baseUrl, '/some/route', 'gzip');

    assert.equal(response.status, 200);
    assert.equal(response.headers['cache-control'], 'no-cache, no-store, must-revalidate');
    assert.equal(response.headers['pragma'], 'no-cache');
    assert.equal(response.headers['expires'], '0');
  });
});

// --------------------------- SPA entry ---------------------------

test('the SPA entry is compressed and decompresses to dist/index.html', async () => {
  await withFixture(async (fixture, baseUrl) => {
    const response = await requestPath(baseUrl, '/some/route', 'gzip');

    assert.equal(response.status, 200);
    assert.equal(response.headers['content-encoding'], 'gzip');
    assert.deepEqual(decodeBody(response), fixture.indexBytes);
  });
});

test('a missing file with an extension is not answered with the SPA entry', async () => {
  await withFixture(async (_fixture, baseUrl) => {
    const response = await requestPath(baseUrl, '/assets/missing.js', 'gzip');

    assert.equal(response.status, 404);
  });
});

// --------------------------- public files ---------------------------

test('files from the public directory are still served', async () => {
  await withFixture(async (_fixture, baseUrl) => {
    const response = await requestPath(baseUrl, '/api-docs.html', 'gzip');

    assert.equal(response.status, 200);
    assert.equal(decodeBody(response).toString('utf8'), '<!doctype html><title>public fixture</title>');
  });
});
