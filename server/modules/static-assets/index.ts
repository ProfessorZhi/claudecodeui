// createStaticAssetsMiddleware: used by the server entrypoint to mount the public/dist
// static assets and the SPA entry behind response compression, after every /api route.
export { createStaticAssetsMiddleware } from '@/modules/static-assets/static-assets.module.js';
