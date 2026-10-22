/**
 * QUAY DISPLAY ROUTES
 * ===================
 *
 * Read-only endpoints that expose a project's quay status to the CloudCLI UI:
 * - `GET /api/quay/:projectId/status`   — Tier 1, whether `.quay/config.yml` exists.
 * - `GET /api/quay/:projectId/snapshot` — Tier 2, task/goal/ADR/driver counts.
 *
 * The routes only parse the id, call the service and format the response; all
 * filesystem and subprocess work lives in `quay.service.ts`. There is no write
 * route here by design — this is a display surface, not a control plane.
 */

import express from 'express';

import { asyncHandler } from '@/shared/utils.js';

import type { createQuayService } from './quay.service.js';

type QuayRouterDependencies = {
  quayService: ReturnType<typeof createQuayService>;
};

/** Creates the read-only Quay routes; mounted by the server entrypoint behind auth. */
export function createQuayRouter(dependencies: QuayRouterDependencies): express.Router {
  const { quayService } = dependencies;
  const router = express.Router();

  router.get(
    '/:projectId/status',
    asyncHandler(async (req, res) => {
      const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
      const status = quayService.getQuayStatus(projectId);
      if (!status) {
        return res.status(404).json({ error: 'Project not found', projectId });
      }

      return res.json(status);
    }),
  );

  router.get(
    '/:projectId/snapshot',
    asyncHandler(async (req, res) => {
      const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
      const forceRefresh = req.query.refresh === '1' || req.query.refresh === 'true';
      const snapshot = await quayService.getQuaySnapshot(projectId, { forceRefresh });
      if (!snapshot) {
        return res.status(404).json({ error: 'Project not found', projectId });
      }

      return res.json(snapshot);
    }),
  );

  return router;
}
