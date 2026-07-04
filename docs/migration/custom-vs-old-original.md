# Custom Fork vs Upstream — Functional Spec & Migration Audit

**Working directory of analysis**: `/home/kraythorne/hermes-workspace` (our fork, branch `feat/sprint-6` at `b1c2d46`)
**Old reference**: `/home/kraythorne/hermes-workspace-original` (snapshot at `a074cf6d`)
**New reference**: `/home/kraythorne/hermes-workspace-original` `origin/main` at `d04e1f36` (current upstream HEAD)

## How to read this doc

Each feature below has three states:
- **CUSTOM ONLY** — exists in our fork, NOT in new upstream. MUST be migrated.
- **PARTIALLY OVERLAPPING** — both have it but with different scope/design. Migration scope is the delta.
- **UPSTREAM EQUIVALENT** — upstream has a functionally equivalent feature (maybe renamed). DO NOT migrate; upstream version supersedes.

Section A is structured that way. After all features are audited, the **Migration Work List** at the bottom is the residual — the actual work to do.

---

## A1. Multi-Profile Gateway System

**Custom capability**: Runs multiple isolated Hermes gateway processes in parallel, one per profile. Each gateway gets its own port (HTTP 8642-8699, WS 18789-18899), env, model, and skills. Workspace multiplexes transparently via `AsyncLocalStorage` context.

**Key custom files**:
- `src/server/gateway-orchestrator.ts` — spawn/stop/monitor per-profile processes
- `src/server/gateway-registry.ts` — persistent registry
- `src/server/gateway-pool.ts` — singleton pool of WS clients
- `src/server/gateway-client.ts` — per-profile WS client
- `src/server/gateway-health.ts`, `gateway-monitor.ts`, `gateway-errors.ts`
- `src/server/profile-context.ts` — AsyncLocalStorage routing
- `src/server/active-profile.ts`, `profile-clone.ts`, `profile-cache.ts`
- `src/server/profile-validation.ts`, `profile-config-validator.ts`, `profile-service-writer.ts`, `profile-workspace-config.ts`

**Custom API endpoints**: `/api/profiles/{list,status,status-all,create,start,stop,restart,delete,rename,activate,$name.clone,config-read,config-write,soul-read,soul-write,update}`

**Upstream equivalent**: PARTIAL.
- Upstream has `/api/profiles/{list,create,read,update,delete,rename,activate,skills,toggle-skill}` — same CRUD surface
- Upstream uses `swarm-profile-config.ts` to PATCH the config.yaml on disk (model sync)
- Upstream has NO multi-gateway orchestration, no port allocation, no WS pool, no AsyncLocalStorage routing

**State**: **PARTIALLY OVERLAPPING** — CRUD is in upstream, multi-gateway orchestration is our delta.

**Migration scope**: Migrate the multi-gateway orchestrator, registry, pool, client, AsyncLocalStorage context, profile-context wiring. CRUD endpoints can be dropped (use upstream's). The profile-status/start/stop/restart multi-gateway variants need to be ported or merged with upstream's single-profile operations.

---

## A2. Mission Orchestrator

**Custom capability**: Plans multi-step missions (goal + team + process), dispatches via LLM-declared dependency graph, persists mission state across browser crashes and multi-browser sessions, prunes stale artifacts on each new run.

**Key custom files**:
- `src/server/mission-state-store.ts` — server-side `~/.hermes/mission-state.json` persistence
- `src/server/mission-cleanup.ts` — pre-mission prune (mission dirs >7d, sessions >24h, keep latest 10)
- `src/server/planner/mission-planner.ts` — LLM planning
- `src/server/planner/dispatch-order.ts` — dep-graph dispatch
- `src/lib/mission-state-api.ts` — client wrapper
- `src/screens/gateway/components/mission-plan-preview.tsx`, `mission-analytics.tsx`, `grill-interview.tsx`
- `src/screens/gateway/hooks/use-mission-orchestrator.ts`

**Custom API endpoints**: `/api/plan-mission`, `/api/mission-state` (GET/PUT/DELETE), `/api/mission-diagnostics`, `/api/grill-plan`, `/api/agent-dispatch`, `/api/agent-pause`, `/api/agent-steer`, `/api/agent-kill`, `/api/crew-status`

**Upstream equivalent**: PARTIAL.
- Upstream has `src/server/swarm-missions.ts` (542 lines, full state machine: planning/dispatching/executing/reviewing/blocked/complete/cancelled; assignment states: queued/dispatched/checkpointed/blocked/needs_input/reviewing/done/cancelled; supports dependsOn checkpoints)
- Upstream has `/api/swarm-missions` endpoint
- Upstream has `src/routes/api/crew-status.ts`
- Upstream has `src/screens/swarm/` and `src/screens/swarm2/` (the swarm UI)
- Upstream MISSING:
  - `mission-state-store.ts` — server-side mission state persistence
  - `mission-cleanup.ts` — pre-mission artifact pruning
  - `/api/plan-mission` — formal plan endpoint
  - `/api/grill-plan` — LLM-driven pre-dispatch interview (uses `grill-with-mission-plan` skill)
  - `/api/mission-state`, `/api/mission-diagnostics`
  - `/api/agent-dispatch`, `/api/agent-pause`, `/api/agent-steer`, `/api/agent-kill` (per-agent control endpoints — upstream's `/api/start-agent.ts` does start but not pause/steer/kill)
  - The Grill Plan interview UX in `grill-interview.tsx`

**State**: **PARTIALLY OVERLAPPING** — upstream's swarm-missions covers the core mission state machine and dispatch. Our deltas are: persistent mission state store, pre-mission cleanup, grill-plan interview (LLM pre-dispatch with skill), per-agent lifecycle endpoints (pause/steer/kill).

**Migration scope**:
- KEEP: `mission-state-store.ts`, `mission-cleanup.ts`, `grill-plan.ts` (interview), `/api/mission-state`, `/api/mission-diagnostics`, `/api/agent-{dispatch,pause,steer,kill}` endpoints
- KEEP frontend: `mission-plan-preview.tsx`, `mission-analytics.tsx`, `grill-interview.tsx`, `use-mission-orchestrator.ts`
- DROP: `mission-planner.ts` if upstream's `swarm-missions.ts` covers planning (it does — `createOrUpdateMission`)
- DROP: `dispatch-order.ts` if upstream's swarm-missions already supports dependsOn (it does — `SwarmMissionAssignment.dependsOn`)

---

## A3. Agent Communication & Inbox

**Custom capability**: Agents can send messages to each other and to a shared inbox; workspace UI observes the conversation in real time via SSE.

**Key custom files**:
- `src/server/agent-message-store.ts` — persists inter-agent messages
- `src/server/agent-message-types.ts` — typed message shapes
- `src/server/agent-messaging.ts` — dispatch + delivery logic
- `src/server/agent-inbox-deliverer.ts` — inbox delivery
- `src/server/agent-file-extractor.ts` — extracts `<file>` tags from agent output
- `src/lib/agent-message-types.ts`, `sse-activity-stream.ts`
- API: `/api/agents/{message,messages,conversation}`

**Upstream equivalent**: DIFFERENT DESIGN.
- Upstream has `src/routes/api/agent-bus.ts` (242 lines) — external `/opt/central-inteligencia/services/hermes-agent-bus/agent_bus.py` script with hand-off contracts for specific named agents (dona-helena, larissinha, etc.). Status written to JSON file, events to JSONL.
- Upstream has `src/routes/api/start-agent.ts`
- Upstream MISSING our general agent-messaging store; the upstream bus is domain-specific (handoff contracts for a particular org)

**State**: **PARTIALLY OVERLAPPING** — concepts overlap, design is completely different. Upstream has a CLI-script-driven bus for specific named agents; ours is a general in-process store.

**Migration scope**:
- KEEP `agent-message-store.ts`, `agent-message-types.ts`, `agent-messaging.ts`, `agent-inbox-deliverer.ts`, `agent-file-extractor.ts`
- KEEP `/api/agents/{message,messages,conversation}` endpoints
- KEEP `lib/agent-message-types.ts`, `lib/sse-activity-stream.ts`
- Note: may need to bridge to upstream's agent-bus if users want both styles to coexist. Out of scope for migration; flag for review.

---

## A4. Hermes Core Layer

**Custom capability**: Abstraction over the Hermes Agent CLI / Python runtime; resolves binary paths, manages env, executes commands, talks to local Hermes API.

**Key custom files**:
- `src/server/hermes-agent.ts` — resolves `hermes` binary
- `src/server/hermes-api.ts` — HTTP client for local Hermes Agent gateway
- `src/server/hermes-dashboard-api.ts` — dashboard plugin client
- `src/server/hermes-home.ts` — `getHermesHome()` with `HERMES_HOME` override
- `src/server/hermes-config-route.ts`, `hermes-config-store.ts`, `hermes-config-migration.ts`

**Upstream equivalent**: YES.
- Upstream `src/server/claude-agent.ts` (217 lines) — binary spawn, port 8642, env loading — exactly our `hermes-agent.ts`
- Upstream `src/server/claude-api.ts` (571 lines) — HTTP client for local Hermes Agent FastAPI backend — exactly our `hermes-api.ts`
- Upstream `src/server/claude-dashboard-api.ts` — dashboard plugin client
- Upstream `src/server/claude-paths.ts` — likely similar to our `hermes-home.ts`
- Upstream `src/server/hermes-config-{migration,route,store,cron-profiles}.ts` — same as ours

**State**: **UPSTREAM EQUIVALENT** — naming differs (Hermes vs Claude) but functionally identical. We should use upstream's versions and update import paths.

**Migration scope**: NONE for the core abstraction logic.
- Update any imports in our routes/server that reference `hermes-agent`, `hermes-api`, `hermes-home`, `hermes-dashboard-api` to upstream equivalents
- Drop our copies of these 4 files

---

## A5. Skill Catalog

**Custom capability**: Parses all skills on disk into a searchable catalog with frontmatter metadata, source path, origin badges.

**Key custom files**:
- `src/server/skill-catalog/{index,generate-catalog,parse-frontmatter,search-skills,types}.ts`

**Upstream equivalent**: NO. Upstream has MCP catalog (`mcp-hub/`, `mcp-presets-store.ts`) but no skill catalog. Different concept (skill = Hermes skill file, MCP = Model Context Protocol server).

**State**: **CUSTOM ONLY** — must be migrated.

**Migration scope**: Keep entire `skill-catalog/` directory. Migrate API endpoints that use it. May coexist with upstream's MCP catalog.

---

## A6. Kanban / Tasks Backend

**Key custom files**:
- `src/server/kanban/{store,file-io,normalize,filter,assignees,constants,types,paths,index}.ts` (9 files)
- `src/server/tasks-store.ts`

**Upstream equivalent**: YES, RICHER.
- `src/server/kanban-backend.ts` (629 lines) — multi-backend abstraction with `KanbanBackendId = 'local' | 'claude' | 'hermes-proxy'`
- `src/server/swarm-kanban-store.ts` — file-based kanban with lanes including mission linking (`missionId`, `parents`, `children`)
- `src/server/kanban-dashboard-proxy.ts` — proxy to dashboard plugin
- `src/server/tasks-store.ts` — present

**State**: **UPSTREAM EQUIVALENT** — drop our kanban in favor of upstream's. Upstream's is more sophisticated (multi-backend, mission-linked, parent/child relationships).

**Migration scope**: NONE. Migrate any unique business logic if found, but file structure should use upstream's.

---

## A7. Local Provider Discovery

**Key custom files**:
- `src/server/local-provider-discovery.ts` (probes Ollama, Atomic Chat; merges into /api/models; auto-writes custom_providers)
- `src/server/provider-extractor.ts`
- API: `/api/local-providers`

**Upstream equivalent**: YES.
- Upstream has `src/server/local-provider-discovery.ts` (same file)
- Upstream has `/api/local-providers`
- Upstream has `src/server/__tests__/local-provider-discovery.test.ts`

**State**: **UPSTREAM EQUIVALENT** — drop ours.

**Migration scope**: NONE. Use upstream's. Compare for any behavior gaps but expect parity.

---

## A8. File Preview & Tag System

**Custom capability**: `<file path="...">content</file>` tags from agent output get extracted and written to mission dir; preview route renders them inline.

**Key custom files**:
- `src/lib/file-tag-parser.ts` — parses `<file>` tags
- `src/routes/api/preview-file.ts` — preview endpoint
- `src/routes/api/files.ts` — file browser API

**Upstream equivalent**: PARTIAL.
- Upstream has `src/routes/api/preview-file.ts` (104 lines) — serves mission output (e.g., `/tmp/dispatch-<slug>/index.html`) with trusted-prefix lockdown, max 5MB
- Upstream does NOT have a `<file>` tag parser

**State**: **PARTIALLY OVERLAPPING** — preview route is in upstream but our parser is unique.

**Migration scope**: KEEP `file-tag-parser.ts` and `agent-file-extractor.ts`. DROP our `preview-file.ts` (use upstream's). Update file browser to call upstream's preview route.

---

## A9. Chat Streaming Hardening

**Custom capability**: SSE heartbeat, mid-run tool polling, prompt dedup, recovery buffers, long silent-run survival.

**Key custom files**:
- `src/server/send-stream-handler.ts` (1128 lines)
- `src/server/send-run-tracker.ts`
- `src/server/concurrency-semaphore.ts` (`backendStreamSemaphore`)
- `src/server/batch-async.ts`
- `src/lib/sse-activity-stream.ts`

**Upstream equivalent**: YES, HEAVIER.
- Upstream `src/routes/api/send-stream.ts` — 1553 lines (vs our 1128)
- Upstream has `send-run-tracker.ts`

**State**: **UPSTREAM EQUIVALENT** — upstream's stream handler is a superset.

**Migration scope**: NONE for core. Compare for any unique behaviors (heartbeat, mid-run polling, dedup) and port as patches if missing in upstream. Likely already present given the 1553-line size.

---

## A10. Session Storage Variants

**Key custom files**:
- `src/server/disk-session-store.ts`
- `src/server/local-session-store.ts`
- `src/server/run-store.ts`

**Upstream equivalent**: YES.
- Upstream has `local-session-store.ts`, `run-store.ts` (+ tests), `session-utils.ts`, `terminal-sessions.ts`

**State**: **UPSTREAM EQUIVALENT** — drop ours.

**Migration scope**: NONE. Use upstream's. If `disk-session-store.ts` has unique behavior not covered by upstream's `local-session-store.ts` + `run-store.ts`, port the specific logic.

---

## A11. Onboarding

**Key custom files**:
- `src/components/onboarding/hermes-onboarding.tsx`

**Upstream equivalent**: YES, RICHER.
- `src/components/onboarding/claude-onboarding.tsx`
- `onboarding-wizard.tsx`, `onboarding-tour.tsx`, `provider-select-step.tsx`
- `setup-step-content.tsx`, `tour-steps.tsx`

**State**: **UPSTREAM EQUIVALENT** — drop ours.

**Migration scope**: NONE.

---

## A12. Profiles Screen UI

**Key custom files**:
- `src/screens/profiles/profiles-screen.tsx` (1429 lines)
- `src/screens/profiles/components/profile-card-actions.tsx`
- `src/screens/profiles/hooks/use-profile-gateway-status.ts`
- `src/screens/profiles/hooks/use-profile-mutations.ts`

**Upstream equivalent**: YES but smaller.
- Upstream `src/screens/profiles/profiles-screen.tsx` (1065 lines)

**State**: **PARTIALLY OVERLAPPING** — upstream has it, but ours is bigger (likely our multi-gateway features). Merge upstream's improvements into ours, OR start from upstream and add our deltas.

**Migration scope**: Start from upstream's 1065-line base, port our multi-gateway hooks (`use-profile-gateway-status.ts`, `use-profile-mutations.ts`) and the profile-card-actions component. Likely net result is similar line count.

---

## A13. Agent Hub / Gateway UI

**Custom capability**: Live mission control — running agents, dispatched tasks, mission timeline, analytics, mission planning preview, grill interview.

**Key custom files** (delta vs upstream):
- `src/screens/gateway/conductor.tsx` (NEW)
- `src/screens/gateway/components/grill-interview.tsx` (NEW)
- `src/screens/gateway/components/mission-analytics.tsx` (NEW)
- `src/screens/gateway/components/mission-plan-preview.tsx` (NEW)
- `src/screens/gateway/lib/mission-checkpoint.ts` (NEW)
- `src/screens/gateway/hooks/use-mission-orchestrator.ts` (NEW)
- `src/screens/gateway/hooks/use-running-agents.ts` (NEW)
- `src/screens/gateway/agent-hub.tsx` (modified)
- `src/screens/gateway/agent-hub-layout.tsx` (modified)

**Upstream equivalent**: YES, larger overall but missing our deltas.
- Upstream `src/screens/gateway/components/` has 36 component files vs our smaller set
- Upstream has `agent-hub.tsx`, `agent-hub-layout.tsx`, `agents-screen.tsx`, `conductor.tsx`
- Upstream has `approvals-bell.tsx`, `approvals-page.tsx`, `approvals-panel.tsx`, `cost-analytics.tsx`, `export-mission.tsx`, `run-compare.tsx`, `run-learnings.tsx`, `template-picker.tsx`, `use-live-feed-chat-stream.ts`, `collaboration-presence.tsx`, `presence-indicator.tsx`
- Upstream MISSING: grill-interview, mission-analytics, mission-plan-preview, mission-checkpoint

**State**: **PARTIALLY OVERLAPPING** — upstream's Agent Hub is broader (cost analytics, export, run compare, presence), but our mission planning deltas (grill-interview, mission-plan-preview, mission-analytics, mission-checkpoint) are unique.

**Migration scope**: KEEP our mission-planning deltas (4 files). Inherit upstream's broader Agent Hub base. May need to add upstream's new components (`cost-analytics`, `export-mission`, etc.) into our migration plan.

---

## A14. Settings & MCP

**Key custom files**:
- `src/screens/settings/mcp-settings-screen.tsx`
- `src/screens/settings/providers-screen.tsx`
- `src/screens/settings/components/provider-wizard.tsx`

**Upstream equivalent**: YES, RICHER.
- Upstream `src/screens/settings/providers-screen.tsx`
- Upstream `src/screens/settings/components/{provider-icon,provider-wizard}.tsx`
- Upstream has full MCP at `src/screens/mcp/mcp-screen.tsx` + `src/screens/mcp/components/{mcp-server-dialog,mcp-logs-drawer,mcp-server-card}.tsx`
- Upstream has `src/routes/api/mcp.ts`, `src/routes/mcp.tsx`
- Upstream `openai-compat-api.ts` is 318 lines vs our 242 lines

**State**: **UPSTREAM EQUIVALENT** — drop ours. Upstream has a full MCP screen + provider wizard.

**Migration scope**: NONE.

---

## Migration Work List (residual, TBD after A5-A14)

This is the actual work needed to bring our custom fork's deltas onto upstream's `origin/main`.

### Tier 1: Keep as-is (migrate as-is, no rework)

| # | Feature | Files to migrate | Notes |
|---|---|---|---|
| 1 | **Skill Catalog** | `src/server/skill-catalog/` (5 files) | Unique to us; upstream has MCP catalog but no skill catalog. May need an API endpoint wrapper. |
| 2 | **Agent Communication** | `src/server/agent-message-{store,types,messaging}.ts`, `agent-inbox-deliverer.ts`, `agent-file-extractor.ts`; `src/lib/agent-message-types.ts`, `sse-activity-stream.ts`; `src/routes/api/agents/{message,messages,conversation}.ts` | Upstream's `agent-bus.ts` is a different design (external script, domain-specific); keep our general in-process store. |

### Tier 2: Partial — keep deltas, drop redundancies

| # | Feature | KEEP (our deltas) | DROP (use upstream's) |
|---|---|---|---|
| 3 | **Multi-Profile Gateway** | `gateway-orchestrator.ts`, `gateway-registry.ts`, `gateway-pool.ts`, `gateway-client.ts`, `gateway-health.ts`, `gateway-monitor.ts`, `gateway-errors.ts`, `profile-context.ts`, `active-profile.ts`, `profile-clone.ts`, `profile-cache.ts`, `profile-validation.ts`, `profile-config-validator.ts`, `profile-service-writer.ts`, `profile-workspace-config.ts` | CRUD profile endpoints (`/api/profiles/{create,list,read,update,delete,rename,activate,skills,toggle-skill}` — upstream has these) |
| 4 | **Mission Orchestrator** | `mission-state-store.ts`, `mission-cleanup.ts`, `lib/mission-state-api.ts`, routes `/api/mission-state`, `/api/mission-diagnostics`, `/api/grill-plan`, `/api/agent-{dispatch,pause,steer,kill}`; `screens/gateway/components/{grill-interview,mission-analytics,mission-plan-preview}.tsx`, `screens/gateway/lib/mission-checkpoint.ts`, `screens/gateway/hooks/use-mission-orchestrator.ts` | `planner/mission-planner.ts`, `planner/dispatch-order.ts` (upstream's `swarm-missions.ts` already covers planning + dependsOn) |
| 5 | **File Tag Parser** | `src/lib/file-tag-parser.ts`, `src/server/agent-file-extractor.ts` (already counted in #2) | Our `src/routes/api/preview-file.ts` (upstream's is equivalent for mission output serving) |
| 6 | **Profiles UI** | `src/screens/profiles/components/profile-card-actions.tsx`, hooks `use-profile-gateway-status.ts`, `use-profile-mutations.ts` | Bulk of `profiles-screen.tsx` (start from upstream's 1065-line version, layer our deltas on top) |
| 7 | **Agent Hub / Mission Control UI** | `grill-interview.tsx`, `mission-analytics.tsx`, `mission-plan-preview.tsx`, `mission-checkpoint.ts`, `use-mission-orchestrator.ts`, `use-running-agents.ts`, `conductor.tsx` | Base `agent-hub.tsx`, `agent-hub-layout.tsx` (use upstream's broader version) |

### Tier 3: Drop entirely (upstream has equivalent or better)

| # | Feature | Use upstream instead |
|---|---|---|
| 8 | Hermes Core Layer | Upstream's `claude-agent.ts`, `claude-api.ts`, `claude-dashboard-api.ts`, `claude-paths.ts` (rename imports) |
| 9 | Kanban Backend | Upstream's `kanban-backend.ts` (629-line multi-backend), `swarm-kanban-store.ts`, `kanban-dashboard-proxy.ts` |
| 10 | Local Provider Discovery | Upstream's `local-provider-discovery.ts` (same file) |
| 11 | Chat Streaming | Upstream's `send-stream.ts` (1553 lines, likely superset of our 1128) |
| 12 | Session Storage | Upstream's `local-session-store.ts`, `run-store.ts` (verify `disk-session-store.ts` behavior isn't unique) |
| 13 | Onboarding | Upstream's `claude-onboarding.tsx`, `onboarding-wizard.tsx`, `onboarding-tour.tsx` |
| 14 | Settings + MCP | Upstream's `providers-screen.tsx`, `provider-wizard.tsx`, full MCP screen at `src/screens/mcp/` |

### Migration order recommendation

1. **Start with Tier 3** (lowest risk): drop our files, update imports to upstream's equivalents. Builds should still work after each replacement.
2. **Then Tier 2 partial migrations**: each requires careful merge, ideally one feature at a time with tests.
3. **Tier 1 last** (highest risk): unique-to-us code needs porting onto upstream's changed architecture.

### Open questions

- Does upstream's `send-stream.ts` actually include the SSE heartbeat, mid-run tool polling, and prompt dedup behaviors we built? Need diff audit.
- Does `disk-session-store.ts` have behavior not covered by `local-session-store.ts` + `run-store.ts`?
- Should agent-communication bridge to upstream's `agent-bus.ts` or stay separate? Different design philosophies.
- For Profiles UI: do we merge upstream's improvements into ours (keep our structure), or port our deltas onto upstream's (new structure)?
