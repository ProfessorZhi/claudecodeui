import fs from 'node:fs/promises';
import path from 'node:path';

import { projectsDb } from '@/modules/database/index.js';
import type {
  CreateProjectPathResult,
  ProjectRepositoryRow,
  WorkspacePathValidationResult,
} from '@/shared/types.js';
import { AppError, normalizeProjectPath, validateWorkspacePath } from '@/shared/utils.js';

type CreateProjectInput = {
  projectPath: string;
  customName?: string | null;
};

type CreateProjectDependencies = {
  validatePath: (projectPath: string) => Promise<WorkspacePathValidationResult>;
  ensureWorkspaceDirectory: (projectPath: string) => Promise<void>;
  persistProjectPath: (projectPath: string, customName: string | null) => CreateProjectPathResult;
  getProjectByPath: (projectPath: string) => ProjectRepositoryRow | null;
};

type ProjectApiView = {
  projectId: string;
  path: string;
  fullPath: string;
  displayName: string;
  customName: string | null;
  isArchived: boolean;
  isStarred: boolean;
  sessions: [];
  sessionMeta: {
    hasMore: false;
    total: 0;
  };
};

type CreateProjectServiceResult = {
  outcome: 'created' | 'reactivated_archived';
  project: ProjectApiView;
};

const defaultDependencies: CreateProjectDependencies = {
  validatePath: validateWorkspacePath,
  ensureWorkspaceDirectory: async (projectPath: string): Promise<void> => {
    await fs.mkdir(projectPath, { recursive: true });
    const directoryStats = await fs.stat(projectPath);
    if (!directoryStats.isDirectory()) {
      throw new AppError('Path exists but is not a directory', {
        code: 'PROJECT_PATH_NOT_DIRECTORY',
        statusCode: 400,
      });
    }
  },
  persistProjectPath: (projectPath: string, customName: string | null): CreateProjectPathResult =>
    projectsDb.createProjectPath(projectPath, customName),
  getProjectByPath: (projectPath: string): ProjectRepositoryRow | null =>
    projectsDb.getProjectPath(projectPath),
};

function resolveDisplayName(customName: string | null | undefined, projectPath: string): string {
  const trimmedCustomName = typeof customName === 'string' ? customName.trim() : '';
  if (trimmedCustomName.length > 0) {
    return trimmedCustomName;
  }

  return path.basename(projectPath) || projectPath;
}

function mapProjectRowToApiView(projectRow: ProjectRepositoryRow): ProjectApiView {
  return {
    projectId: projectRow.project_id,
    path: projectRow.project_path,
    fullPath: projectRow.project_path,
    displayName: resolveDisplayName(projectRow.custom_project_name, projectRow.project_path),
    customName: projectRow.custom_project_name,
    isArchived: Boolean(projectRow.isArchived),
    isStarred: Boolean(projectRow.isStarred),
    sessions: [],
    sessionMeta: {
      hasMore: false,
      total: 0,
    },
  };
}

export async function createProject(
  input: CreateProjectInput,
  dependencies: CreateProjectDependencies = defaultDependencies,
): Promise<CreateProjectServiceResult> {
  const normalizedPath = normalizeProjectPath(input.projectPath || '');
  if (!normalizedPath) {
    throw new AppError('path is required', {
      code: 'PROJECT_PATH_REQUIRED',
      statusCode: 400,
    });
  }

  const pathValidation = await dependencies.validatePath(normalizedPath);
  if (!pathValidation.valid || !pathValidation.resolvedPath) {
    throw new AppError('Invalid project path', {
      code: 'INVALID_PROJECT_PATH',
      statusCode: 400,
      details: pathValidation.error ?? 'Path validation failed',
    });
  }

  const resolvedProjectPath = normalizeProjectPath(pathValidation.resolvedPath);
  await dependencies.ensureWorkspaceDirectory(resolvedProjectPath);

  const normalizedCustomName = resolveDisplayName(input.customName ?? null, resolvedProjectPath);
  const persistedProject = dependencies.persistProjectPath(resolvedProjectPath, normalizedCustomName);

  if (persistedProject.outcome === 'active_conflict') {
    throw new AppError('Project path already exists and is active', {
      code: 'PROJECT_ALREADY_EXISTS',
      statusCode: 409,
      details: `Project path already exists: ${resolvedProjectPath}`,
    });
  }

  const projectRow = persistedProject.project ?? dependencies.getProjectByPath(resolvedProjectPath);
  if (!projectRow) {
    throw new AppError('Failed to resolve project after creation', {
      code: 'PROJECT_CREATE_FAILED',
      statusCode: 500,
    });
  }

  // Archived rows intentionally remain archived when reused, as requested.
  return {
    outcome: persistedProject.outcome,
    project: mapProjectRowToApiView(projectRow),
  };
}

/**
 * Sets `projects.custom_project_name` for the given `projectId` (or clears it when empty).
 */
export function updateProjectDisplayName(projectId: string, newDisplayName: unknown): void {
  const trimmed = typeof newDisplayName === 'string' ? newDisplayName.trim() : '';
  projectsDb.updateCustomProjectNameById(projectId, trimmed.length > 0 ? trimmed : null);
}

/**
 * MCP composition uses an explicitly configured device root, never a caller root
 * or the legacy HOME fallback. REST and Worktrees retain createProject defaults.
 * Reject every descendant symlink, including one above multiple missing levels.
 * This is containment validation, not a sandbox against privileged local races.
 */
export async function createProjectWithinWorkspaceRoot(
  input: CreateProjectInput & { requireFresh?: boolean },
  workspaceRoot: string | undefined,
): Promise<CreateProjectServiceResult & { freshDirectoryCreated: boolean }> {
  if (!workspaceRoot || !path.isAbsolute(workspaceRoot)) {
    throw new AppError('Configure an absolute WORKSPACES_ROOT before creating projects through MCP.', {
      code: 'PROJECT_WORKSPACE_ROOT_REQUIRED', statusCode: 403,
    });
  }
  const invalidPath = (message: string): AppError => new AppError(message, {
    code: 'INVALID_PROJECT_PATH', statusCode: 400,
  });
  if (!path.isAbsolute(input.projectPath) || input.projectPath.includes('\0')) {
    throw invalidPath('Project path must be an absolute directory within WORKSPACES_ROOT.');
  }
  const configuredRoot = path.resolve(workspaceRoot);
  const realRoot = await fs.realpath(configuredRoot);
  if (!(await fs.stat(realRoot)).isDirectory()) {
    throw invalidPath('Configured workspace root is not a directory.');
  }
  const requested = path.resolve(input.projectPath);
  const isDescendant = (relative: string): boolean =>
    relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  // The configured root may itself be a device-owned symlink. Either spelling
  // is accepted; symlinks supplied below that root are never followed.
  let relative = path.relative(configuredRoot, requested);
  if (!isDescendant(relative)) relative = path.relative(realRoot, requested);
  if (!isDescendant(relative)) throw invalidPath('Project path must be a descendant of WORKSPACES_ROOT.');
  const projectPath = path.join(realRoot, relative);
  const segments = relative.split(path.sep);
  const requireFresh = input.requireFresh === true;
  const conflict = (reason: string): AppError => new AppError('Project path already exists; a fresh directory is required.', {
    code: 'PROJECT_ALREADY_EXISTS', statusCode: 409, details: reason,
  });
  let freshDirectoryCreated = false;

  const walk = async (createMissing: boolean): Promise<void> => {
    if (await fs.realpath(realRoot) !== realRoot) throw invalidPath('Workspace root changed during creation.');
    let current = realRoot;
    for (const [index, segment] of segments.entries()) {
      current = path.join(current, segment);
      try {
        if (createMissing) {
          // Never recursively traverse unchecked ancestors. EEXIST is checked
          // with lstat below, including a concurrent creator of this directory.
          const exclusiveLeaf = requireFresh && index === segments.length - 1;
          try {
            await fs.mkdir(current);
            if (exclusiveLeaf) freshDirectoryCreated = true;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            if (exclusiveLeaf) throw conflict('directory_exists');
          }
        }
        const stat = await fs.lstat(current);
        if (stat.isSymbolicLink() || !stat.isDirectory() || await fs.realpath(current) !== current) {
          throw invalidPath('Project paths cannot traverse symlinks or non-directory entries.');
        }
      } catch (error) {
        if (!createMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
    }
  };
  await walk(false);
  if (requireFresh) {
    if (projectsDb.getProjectPath(projectPath)) throw conflict('project_already_registered');
    try {
      await fs.lstat(projectPath);
      throw conflict('directory_exists');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const result = await createProject({ ...input, projectPath }, {
    ...defaultDependencies,
    persistProjectPath: (resolvedPath, customName) => {
      const persisted = projectsDb.createProjectPath(resolvedPath, customName, { requireFresh });
      if (requireFresh && persisted.outcome !== 'created') throw conflict('project_already_registered');
      return persisted;
    },
    validatePath: async () => {
      // Keep the existing system-directory restrictions in addition to the
      // stricter MCP-only root/ancestor validation, without changing REST.
      const validation = await validateWorkspacePath(projectPath);
      if (!validation.valid) return validation;
      await walk(false);
      return { valid: true, resolvedPath: projectPath };
    },
    ensureWorkspaceDirectory: async () => {
      await walk(true);
      await walk(false);
    },
  });
  return { ...result, freshDirectoryCreated };
}
