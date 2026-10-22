// settingsRoutes: used by the server entrypoint to mount protected application-settings endpoints.
export { settingsRoutes } from './settings.module.js';
// createSettingsRouter: used by the settings criteria to mount the production route
// factory on a real express server without importing the assembled module singleton.
export { createSettingsRouter } from './settings.routes.js';
// createSettingsService: used by the settings criteria to assemble the production
// service with injected dependencies (including the OAuth access-token port).
export { createSettingsService } from './settings.service.js';
