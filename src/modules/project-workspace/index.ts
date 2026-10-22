export { default as ProjectWorkspaceRoute } from '@/modules/project-workspace/ProjectWorkspaceRoute';
export {
  useProjectSessionFilter,
  // The rule predicate, exported so the sidebar's live Conversations feed can be
  // handed the same implementation through props (see SessionHiddenByProjectFilter).
  isSessionHiddenByProjectFilter,
} from '@/modules/project-workspace/hooks/useProjectSessionFilter';
export { useProjectsState } from '@/modules/project-workspace/hooks/useProjectsState';
