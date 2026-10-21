import { z } from 'zod';

import { ACCESS_TOKEN_SCOPES } from '@/modules/oauth/index.js';
import type { createProjectWithinWorkspaceRoot } from '@/modules/projects/index.js';
import { AppError } from '@/shared/utils.js';

import { McpToolError } from './mcp-error-envelope.js';
import type { McpWriteToolSeam } from './mcp-gateway.write-tools.js';

/** Production write-tool composition supplies the projects module's rooted entry. */
export type McpProjectCreateDeps = {
  createProject: (input: Parameters<typeof createProjectWithinWorkspaceRoot>[0]) => ReturnType<typeof createProjectWithinWorkspaceRoot>;
};

/** Registers a sibling of the pinned session-write table on its audited seam. */
export function registerMcpProjectCreateTool(seam: McpWriteToolSeam, deps?: McpProjectCreateDeps): void {
  seam({
    name: 'project_create',
    handlerBound: deps !== undefined,
    description: 'Create a project under the device-configured root and return its real id. Set requireFresh to require an exclusively new directory and project row, confirmed by freshDirectoryCreated. Repeated active paths conflict. Reconcile lost responses; absence from projects_list does not prove no directory was created.',
    requiredScope: ACCESS_TOKEN_SCOPES[2],
    inputSchema: {
      projectPath: z.string().trim().min(1).max(4096).describe('Absolute project directory under this device workspace root; the caller cannot override the root.'),
      customName: z.string().trim().max(256).nullable().optional().describe('Optional project display name; defaults to the directory name.'),
      requireFresh: z.boolean().default(false).describe('When true, atomically require a new final directory and new project row; refuse every existing or archived target.'),
    },
    outputSchema: {
      projectId: z.string(), path: z.string(), displayName: z.string(),
      isArchived: z.boolean(), outcome: z.enum(['created', 'reactivated_archived']),
      freshDirectoryCreated: z.boolean(),
    },
    handler: async (args) => {
      if (!deps) throw new McpToolError('MCP_TOOL_NOT_IMPLEMENTED', 'Project creation is not wired on this gateway.');
      try {
        const result = await deps.createProject({ projectPath: args.projectPath as string, customName: args.customName as string | null | undefined, requireFresh: args.requireFresh as boolean });
        return {
          projectId: result.project.projectId,
          path: result.project.path,
          displayName: result.project.displayName,
          isArchived: result.project.isArchived,
          outcome: result.outcome,
          freshDirectoryCreated: result.freshDirectoryCreated,
        };
      } catch (error) {
        if (error instanceof AppError) {
          throw new McpToolError(error.code, error.message, false,
            error.details === undefined ? undefined : { reason: error.details });
        }
        throw error;
      }
    },
  });
}
