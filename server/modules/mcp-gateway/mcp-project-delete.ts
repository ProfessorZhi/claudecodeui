import { z } from 'zod';

import { ACCESS_TOKEN_SCOPES } from '@/modules/oauth/index.js';
import type { deleteOrArchiveProject } from '@/modules/projects/index.js';
import { AppError } from '@/shared/utils.js';

import { McpToolError } from './mcp-error-envelope.js';
import type { McpWriteToolSeam } from './mcp-gateway.write-tools.js';

/**
 * The project row a delete is aimed at, read before anything is removed.
 *
 * A delete that reports only "it worked" cannot be checked afterwards — the row
 * it removed is the only place its path and display name were written down — so
 * the reading is taken first and echoed in the result.
 */
export type McpProjectDeleteTarget = {
  projectId: string;
  path: string;
  isArchived: boolean;
};

/** Production write-tool composition supplies the projects module's own delete entry. */
export type McpProjectDeleteDeps = {
  /**
   * The project row, or `null` when no project has that id. Split from the
   * delete itself so the handler can refuse an unknown id as a NOT_FOUND
   * reading instead of making the service throw, and so the result can echo
   * what it removed.
   */
  readProject: (projectId: string) => McpProjectDeleteTarget | null;
  deleteProject: (projectId: string, force: boolean) => ReturnType<typeof deleteOrArchiveProject>;
};

/**
 * `project_delete` — the destructive twin of `project_create`.
 *
 * Two modes on ONE tool, because they are the two answers to the same request
 * and a caller must choose between them explicitly:
 *
 *  - `force: false` (default) archives the project row. The directory and the
 *    transcripts are untouched and a restore puts the row back; this is the
 *    mode a mistake can be undone from.
 *  - `force: true` removes the session rows and their transcript files, then
 *    the project row. The DIRECTORY ON DISK IS LEFT ALONE — that is the
 *    service's own behaviour (`deleteOrArchiveProject`) and it is restated here
 *    because "delete the project" reasonably sounds like it takes the files too.
 *    Removing a directory is not something this tool will ever do: the caller
 *    can do that itself, with its own eyes on the path.
 *
 * Scope is `cloudcli:session:control` — the destructive-stored-state scope, the
 * same one that withdraws a queued message. It is not `session:create` (this
 * mints nothing) and not `approve` (there is no agent waiting on an answer).
 */
export function registerMcpProjectDeleteTool(seam: McpWriteToolSeam, deps?: McpProjectDeleteDeps): void {
  seam({
    name: 'project_delete',
    handlerBound: deps !== undefined,
    description:
      'Archive a project (default) or permanently remove its session rows and transcript files with force: true. '
      + 'The project DIRECTORY on disk is never removed by this tool. An unknown project id is PROJECT_NOT_FOUND, '
      + 'and repeating a force delete finds nothing — read projects_list again rather than assuming the first call failed.',
    requiredScope: ACCESS_TOKEN_SCOPES[3],
    inputSchema: {
      // NOT `project`: the gateway's AC-246 gate resolves any argument by that
      // name against the ACTIVE project list before the handler runs, which
      // would (a) reject an ARCHIVED project — exactly the row a permanent
      // delete most often targets — and (b) turn a name fragment into a
      // discovery mechanism for a destructive verb. An id is the whole
      // reference here, and the row read below is the only resolution.
      projectId: z.string().trim().min(1).max(256).describe('The project id, exactly as projects_list reports it.'),
      force: z
        .boolean()
        .default(false)
        .describe('false archives the project (reversible); true permanently removes its session rows and transcript files.'),
    },
    outputSchema: {
      projectId: z.string(),
      path: z.string(),
      // The archive state as it stood BEFORE the call: the caller can tell a
      // project it just archived from one that was already archived.
      wasArchived: z.boolean(),
      archived: z.boolean(),
      deleted: z.boolean(),
      directoryRemoved: z.literal(false),
    },
    handler: async (args) => {
      if (!deps) throw new McpToolError('MCP_TOOL_NOT_IMPLEMENTED', 'Project deletion is not wired on this gateway.');
      const projectId = args.projectId as string;
      const force = args.force as boolean;
      const target = deps.readProject(projectId);
      if (target === null) {
        throw new McpToolError('PROJECT_NOT_FOUND', `No project has id "${projectId}".`, false, {
          fields: [{ path: 'projectId', problem: 'names no project' }],
        });
      }
      try {
        await deps.deleteProject(projectId, force);
      } catch (error) {
        if (error instanceof AppError) {
          throw new McpToolError(error.code, error.message, false,
            error.details === undefined ? undefined : { reason: error.details });
        }
        throw error;
      }
      return {
        projectId: target.projectId,
        path: target.path,
        wasArchived: target.isArchived,
        archived: !force,
        deleted: force,
        // Stated as a literal so a caller reading the schema cannot mistake the
        // silence for an omission: this tool does not touch directories.
        directoryRemoved: false as const,
      };
    },
  });
}
