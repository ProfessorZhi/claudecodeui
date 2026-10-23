export {
  generateDisplayName,
  getProjectsWithSessions,
} from './services/projects-with-sessions-fetch.service.js';
// getProjectSessionsPage / getArchivedProjectsWithSessions: the MCP gateway's
// read tools answer `projects_list` (with `includeArchived`) and the
// project-scoped `sessions_list` from these two readers — the same paginated
// project view the REST surface serves, so an MCP client and the sidebar cannot
// disagree about which sessions a project has.
export {
  getArchivedProjectsWithSessions,
  getProjectSessionsPage,
} from './services/projects-with-sessions-fetch.service.js';
export { updateProjectDisplayName } from './services/project-management.service.js';
// createProject: used by the worktrees module to register a worktree directory as a switchable project.
export { createProject } from './services/project-management.service.js';
// deleteOrArchiveProject: used by Projects routes and Worktrees cleanup to hide or permanently remove a project.
export { deleteOrArchiveProject, deleteSessionJsonlFilesForProjectPath } from './services/project-delete.service.js';
// restoreArchivedProject: used by the worktrees module to re-activate an archived project when its worktree is reopened.
export { restoreArchivedProject } from './services/project-delete.service.js';
// compileStoredSessionFilter: used by the providers module to apply each project's session-name hide rules to recent-session and search results.
export { compileStoredSessionFilter } from './services/session-name-filter.service.js';
