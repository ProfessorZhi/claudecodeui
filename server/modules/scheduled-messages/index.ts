// The HTTP surface for scheduling a message to a session, mounted by the app.
export { default as scheduledMessagesRoutes } from './scheduled-messages.routes.js';

// The timer that sends them, started and stopped with the server.
export {
  initializeScheduledMessageDispatcher,
  closeScheduledMessageDispatcher,
  // dispatchDueScheduledMessages: the single dispatch pass. Re-exported for the
  // websocket module's wiring criterion
  // (`server/modules/websocket/tests/chat-control-wiring.test.ts`), which drives
  // one pass with the shared control service spy and reads that the timer
  // reaches the *same* instance the chat gateway does — an assertion that needs
  // the pass, not the interval.
  dispatchDueScheduledMessages,
} from './services/scheduled-message-dispatcher.service.js';
