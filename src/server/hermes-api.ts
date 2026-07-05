/**
 * Hermes API facade.
 *
 * Barrel re-export of the split modules. New code should prefer
 * importing from the specific module (e.g. `./hermes-sessions`) so
 * the bundler can tree-shake; this facade exists for backward
 * compatibility with existing consumers (e.g. agent-inbox-deliverer,
 * routes/api/agents/*).
 *
 * Module map:
 *   - hermes-api-client: HTTP verbs + auth + base URL + domain types
 *   - hermes-sessions:   session CRUD + messages + search + fork + conversions
 *   - hermes-stream:     SSE chat streaming + non-streaming chat
 *   - hermes-meta:       config / models / skills / memory + health
 */

export {
  authHeaders,
  hermesDelete,
  hermesGet,
  hermesPatch,
  hermesPost,
  resolveBaseUrl,
  withProfile,
  type HermesConfig,
  type HermesMessage,
  type HermesSession,
} from './hermes-api-client'

// Re-export gateway-capabilities passthroughs for backward compatibility
// (callers expect these from the hermes-api facade).
export { ensureGatewayProbed } from './gateway-capabilities'

export {
  createSession,
  deleteSession,
  forkSession,
  getMessages,
  getSession,
  listSessions,
  localSessionToHermes,
  searchSessions,
  shouldUseLocalStore,
  toChatMessage,
  toSessionSummary,
  updateSession,
} from './hermes-sessions'

export {
  sendChat,
  streamChat,
  type StreamChatEvent,
  type StreamChatOptions,
} from './hermes-stream'

export {
  checkHealth,
  getConfig,
  getMemory,
  getSkill,
  getSkillCategories,
  isHermesAvailable,
  listModels,
  listSkills,
  patchConfig,
  type ListModelsResponse,
} from './hermes-meta'