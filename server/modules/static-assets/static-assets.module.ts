import fs from 'node:fs';
import path from 'node:path';

import compression from 'compression';
import express, { type Request, type RequestHandler, type Response } from 'express';

/**
 * Extensions whose files carry content hashes in their names, so they can be
 * cached forever. Kept as an explicit allowlist: anything not listed falls
 * through to Express's default (no `Cache-Control`), which is what the previous
 * inline mounting in `server/index.ts` did.
 */
const IMMUTABLE_ASSET_EXTENSIONS = /\.(js|css|woff2?|ttf|eot|svg|png|jpg|jpeg|gif|ico)$/;

/**
 * Sets the same cache headers the server entrypoint used before this module
 * existed: HTML must never be cached (a stale `index.html` pins the browser to
 * old hashed bundles and breaks service-worker updates), hashed assets may be
 * cached forever.
 */
function setStaticAssetCacheHeaders(res: Response, filePath: string): void {
  if (filePath.endsWith('.html')) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  } else if (IMMUTABLE_ASSET_EXTENSIONS.test(filePath)) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  }
}

/**
 * createStaticAssetsMiddleware: used by the server entrypoint (`server/index.ts`)
 * to serve the `public/` directory, the built `dist/` bundle and the SPA entry.
 *
 * Mount the returned router only after every `/api/*` route: the router installs
 * response compression first, and `/api/*` carries streaming (SSE, TTS audio)
 * and already-compressed responses that must not be buffered by the compressor.
 * Mounting it later also leaves `Vary: Accept-Encoding` off API responses.
 *
 * @param options.distDir Directory holding the built bundle (`index.html` plus hashed assets).
 * @param options.publicDir Directory holding unhashed public files such as `api-docs.html`.
 * @param options.onMissingIndex Called when no built `dist/index.html` exists, so the
 * caller can redirect to the dev server it owns. The module deliberately does not read
 * the dev-server port itself: that configuration belongs to the entrypoint.
 */
export function createStaticAssetsMiddleware(options: {
  distDir: string;
  publicDir: string;
  onMissingIndex: (req: Request, res: Response) => void;
}): RequestHandler {
  const { distDir, publicDir, onMissingIndex } = options;
  const indexPath = path.join(distDir, 'index.html');
  const router = express.Router();

  // `compression` negotiates the encoding from `Accept-Encoding` (brotli, then
  // gzip) and only compresses bodies it considers compressible, so the
  // already-compressed PNG/JPG/WOFF2 assets are excluded by its default filter.
  router.use(compression());

  router.use(express.static(publicDir));

  router.use(
    express.static(distDir, {
      setHeaders: setStaticAssetCacheHeaders,
    }),
  );

  // SPA entry: every non-asset path renders `index.html` so client-side routing
  // can take over. Requests with an extension are real missing files -> 404.
  router.get('*', (req, res) => {
    if (path.extname(req.path)) {
      return res.status(404).send('Not found');
    }

    if (fs.existsSync(indexPath)) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.sendFile(indexPath);
    } else {
      onMissingIndex(req, res);
    }
  });

  return router;
}
