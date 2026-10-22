export { default as Sidebar } from '@/modules/sidebar/Sidebar';
export { default as ResidentMark } from '@/modules/sidebar/ResidentMark';
// The Conversations/sidebar controller, exported so the module's own tests can
// drive the live feed through the same entry point the barrel exposes (tests
// import cross-module symbols through barrels; see AGENTS.md).
export { useSidebarController } from '@/modules/sidebar/hooks/useSidebarController';
// Browser-local "show hidden sessions" preference, read by project-workspace when it loads session pages.
export { readShownHiddenProjectIds, writeShownHiddenProjectIds } from '@/modules/sidebar/utils/sidebarStoredPreferences';
