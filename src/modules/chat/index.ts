export { default as ChatInterface } from '@/modules/chat/ChatInterface';
export { getClaudeSettings } from '@/modules/chat/utils/chatStorage';
export { default as ModelLibraryPanel } from '@/modules/chat/modals/ModelLibraryPanel';
export { default as ResidentSessionBadge } from '@/modules/chat/transcript/ResidentSessionBadge';
/** Used by the settings module's voice panel to show the on-device recogniser's download and give-ups. */
export { useVoiceClientAsrStatus } from '@/modules/chat/hooks/useVoiceAvailable';
export type { VoiceClientAsrPanel } from '@/modules/chat/hooks/useVoiceAvailable';
