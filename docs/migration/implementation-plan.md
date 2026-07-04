# Implementation Plan — Custom Fork → New Upstream

**Companion doc**: `custom-vs-old-original.md` (the functional spec audit)
**Working branch**: `feat/sprint-6` (our dev branch)
**Target base**: `upstream/main` at `d04e1f36` (current new upstream HEAD)
**Strategy**: Forward-port our custom deltas onto upstream's architecture. NOT merge upstream into our dirty fork.

---

## Goals

1. Get our custom fork's unique value (multi-gateway orchestration, mission orchestrator deltas, skill catalog, agent comms, file tag parser, mission control UI) running on top of new upstream.
2. Discard our copies of features upstream now provides natively (kanban, streaming, session storage, local providers, onboarding, MCP, hermes core layer).
3. Preserve all of upstream's improvements since our fork (HermesWorld embed, COOP/COEP, dashboard, Echo Studio, swarm runtime fixes, etc.).

## Non-goals

- Refactor our custom code beyond what's needed to integrate.
- Re-implement features upstream has already built.
- Migrate test files for features we're discarding (they go too).
- Touch `Missions/` outputs or docs from old sprints.

---

## Pre-flight verification (3 items — must do before any code)

These gate the rest of the work. Each is a quick grep/diff that takes <30 minutes.

### V1. Does upstream `send-stream.ts` (1553 lines) include our streaming hardening?

Check for these specific behaviors we built:
- SSE heartbeat on long silent runs
- Mid-run tool polling for vanilla Hermes Agent
- Prompt dedup after compaction
- Recovery buffer for vanished last message

Method:
```
cd /home/kraythorne/hermes-workspace-original
grep -n "heartbeat\|keepalive\|dedup\|tool.poll\|recovery" src/routes/api/send-stream.ts
```

Outcome:
- If all 4 present → drop our send-stream-handler.ts entirely
- If some missing → plan a patch to add them to upstream's send-stream.ts after base port

### V2. Is `disk-session-store.ts` redundant with upstream's `local-session-store.ts` + `run-store.ts`?

Read both, compare behaviors, decide:
- If fully redundant → drop ours
- If unique logic exists → port the delta into a new small module, drop ours

### V3. Does upstream have `/api/crew-status`?

```
ls /home/kraythorne/hermes-workspace-original/src/routes/api/ | grep -E "crew|agent-status"
```

- Yes → drop our version
- No → keep ours

---

## Execution phases

Each phase ends with: working build + tests green + committed to `feat/sprint-6`. Don't start next phase until previous is green.

### Phase 1: Fresh branch off upstream (no fork history)

**Branch**: `upgrade/v2.3.0-custom-port` based on `upstream/main` at `d04e1f36`

```
cd /home/kraythorne/hermes-workspace
git fetch upstream
git checkout -b upgrade/v2.3.0-custom-port upstream/main
git push -u origin upgrade/v2.3.0-custom-port
```

**Outcome**: Clean branch tracking upstream HEAD, ready to add our deltas without conflicting with old fork history.

### Phase 2: Tier 3 replacements (lowest risk, 7 features, ~half day)

For each Tier 3 item, delete our files, find upstream's counterpart, update all import sites.

#### 2a. Hermes Core Layer
- Delete: `src/server/hermes-agent.ts`, `hermes-api.ts`, `hermes-dashboard-api.ts`, `hermes-home.ts`
- Update imports across codebase: `from '../server/hermes-agent'` → `from '../server/claude-agent'` (etc.)
- Verify: build + smoke test sessions endpoint

#### 2b. Kanban Backend
- Delete: entire `src/server/kanban/` directory (9 files), our `src/server/tasks-store.ts`
- Keep upstream's `kanban-backend.ts`, `swarm-kanban-store.ts`, `kanban-dashboard-proxy.ts`
- Update imports: any `from '@/server/kanban/...'` → upstream equivalent
- Verify: kanban screen renders, task CRUD works

#### 2c. Local Provider Discovery
- Delete: our `src/server/local-provider-discovery.ts`, `src/server/provider-extractor.ts`, `src/routes/api/local-providers.ts`
- Keep upstream's equivalents
- Update imports
- Verify: model picker shows locally-discovered models

#### 2d. Session Storage
- Delete: our `src/server/disk-session-store.ts`, `src/server/local-session-store.ts`, `src/server/run-store.ts`
- Use upstream's
- Verify: sessions persist across reloads

#### 2e. Onboarding
- Delete: our `src/components/onboarding/hermes-onboarding.tsx`
- Use upstream's `claude-onboarding.tsx` + `onboarding-wizard.tsx` + `onboarding-tour.tsx`
- Verify: onboarding tour plays for new users

#### 2f. Settings + MCP
- Delete: our `src/screens/settings/mcp-settings-screen.tsx`, `src/screens/settings/providers-screen.tsx`, `src/screens/settings/components/provider-wizard.tsx`
- Use upstream's settings + MCP screen
- Verify: settings loads, MCP screen works

#### 2g. Chat Streaming (gated on V1 outcome)
- If V1 says upstream covers our behaviors → delete our `send-stream-handler.ts`, `send-run-tracker.ts`, `concurrency-semaphore.ts`, `batch-async.ts`, `lib/sse-activity-stream.ts`
- If V1 says patch needed → keep ours as starting reference, port diff
- Verify: long silent runs survive, tool cards render, no prompt dupes

**Phase 2 commit pattern**:
```
git commit -m "chore(upgrade): adopt upstream's <feature> implementation

- Drop our custom <feature>.ts (upstream has equivalent/superset)
- Update N import sites across codebase
- Verified: <list of behaviors still working>"
```

### Phase 3: Tier 2 partial migrations (5 features, ~3-4 days)

These require careful per-feature work. Do them one at a time.

#### 3a. File Tag Parser (smallest, 30 min)
- Add: our `src/lib/file-tag-parser.ts` (1 file, ~150 lines)
- Wire into existing `send-stream.ts` (or new extraction point): when agent output contains `<file>` tags, write to disk and emit a UI signal
- Test: run an agent that outputs `<file>` tags, verify file appears and preview route renders it
- Commit: `feat(file-tags): port <file> tag parser from old custom fork`

#### 3b. Multi-Profile Gateway (largest, 1-2 days)
This is the biggest piece of custom code. Strategy: take upstream's profile system + layer our orchestrator on top.

1. First, study upstream's profile model:
   - `src/server/profiles-browser.ts`
   - `src/server/swarm-profile-config.ts`
   - `src/server/hermes-cron-profiles.ts`
   - `src/routes/api/profiles/*`
2. Identify what upstream does NOT have: port allocation across multiple running gateways, WS pool per profile, AsyncLocalStorage routing, registry of live processes
3. Port our custom files (15+ files), adjusting for upstream's data shapes:
   - `src/server/gateway-orchestrator.ts` (port allocation: HTTP 8642-8699, WS 18789-18899)
   - `src/server/gateway-registry.ts`
   - `src/server/gateway-pool.ts`
   - `src/server/gateway-client.ts`
   - `src/server/gateway-health.ts`
   - `src/server/gateway-monitor.ts`
   - `src/server/gateway-errors.ts`
   - `src/server/profile-context.ts` (AsyncLocalStorage)
   - `src/server/active-profile.ts`
   - `src/server/profile-clone.ts`
   - `src/server/profile-cache.ts`
   - `src/server/profile-validation.ts`
   - `src/server/profile-config-validator.ts`
   - `src/server/profile-service-writer.ts`
   - `src/server/profile-workspace-config.ts`
4. Add multi-gateway variants of profile endpoints (`status-all`, `start`, `stop`, `restart`)
5. Test: spawn 2 gateways with different profiles, verify multiplexing works, WS connections route correctly
6. Commit: `feat(multi-gateway): port per-profile gateway orchestrator from old custom fork`

#### 3c. Mission Orchestrator Deltas (~1 day)
Upstream has `swarm-missions.ts` for the state machine. We add the persistence + interview + per-agent control layer.

1. Read upstream's `src/server/swarm-missions.ts` and `src/routes/api/swarm-missions.ts` end-to-end
2. Port our files, adapting to upstream's data shapes:
   - `src/server/mission-state-store.ts` — persist upstream's SwarmMission shape to `~/.hermes/mission-state.json`
   - `src/server/mission-cleanup.ts` — pre-mission pruning (keep compatible with upstream's mission storage path)
   - `src/lib/mission-state-api.ts`
3. Add new endpoints (these don't exist in upstream):
   - `src/routes/api/mission-state.ts` (GET/PUT/DELETE)
   - `src/routes/api/mission-diagnostics.ts`
   - `src/routes/api/grill-plan.ts` — the LLM-driven interview via `grill-with-mission-plan` skill (requires the skill file too: `~/.hermes/skills/grill-with-mission-plan/SKILL.md` if not already present)
   - `src/routes/api/agent-dispatch.ts`
   - `src/routes/api/agent-pause.ts`
   - `src/routes/api/agent-steer.ts`
   - `src/routes/api/agent-kill.ts`
4. Test: trigger grill-plan, walk through interview, dispatch agents, pause/steer/kill
5. Commit: `feat(mission-orchestrator): port mission state persistence + grill-plan + per-agent lifecycle endpoints`

#### 3d. Profiles Multi-Gateway UI Hooks (~2 hours)
1. Add our 3 files:
   - `src/screens/profiles/components/profile-card-actions.tsx`
   - `src/screens/profiles/hooks/use-profile-gateway-status.ts`
   - `src/screens/profiles/hooks/use-profile-mutations.ts`
2. Wire into upstream's `profiles-screen.tsx` (insert our hooks into profile card components)
3. Test: profile cards show gateway status, can restart/clone from UI
4. Commit: `feat(profiles-ui): add multi-gateway profile management hooks`

#### 3e. Mission Control UI Components (~half day)
1. Add our 7 files (verify they're not already in upstream):
   - `src/screens/gateway/components/grill-interview.tsx`
   - `src/screens/gateway/components/mission-analytics.tsx`
   - `src/screens/gateway/components/mission-plan-preview.tsx`
   - `src/screens/gateway/lib/mission-checkpoint.ts`
   - `src/screens/gateway/hooks/use-mission-orchestrator.ts`
   - `src/screens/gateway/hooks/use-running-agents.ts`
   - `src/screens/gateway/conductor.tsx` (verify presence in upstream)
2. Wire into upstream's `agent-hub.tsx` (add menu items, modals, panels)
3. Test: open Agent Hub, see Grill Plan button, trigger preview, view analytics
4. Commit: `feat(agent-hub): port mission control UI components from old custom fork`

### Phase 4: Tier 1 fresh features (2 features, ~half day to 1 day)

These need porting onto upstream's architecture. Our existing code is the reference; expect to adjust for upstream's changed module shapes.

#### 4a. Skill Catalog (~2 hours)
1. Copy our 5 files into upstream tree:
   - `src/server/skill-catalog/{index,generate-catalog,parse-frontmatter,search-skills,types}.ts`
2. Add API endpoint wrapper (if needed) — check what upstream expects at `src/routes/api/skills-catalog.ts`
3. Wire into upstream's skills screen (`src/screens/skills/`)
4. Test: skills screen shows catalog with source paths, origin badges
5. Commit: `feat(skill-catalog): port skill catalog system from old custom fork`

#### 4b. Agent Communication & Inbox (~half day)
1. Read upstream's `src/routes/api/agent-bus.ts` end-to-end to understand what NOT to conflict with
2. Port our files:
   - `src/server/agent-message-store.ts`
   - `src/server/agent-message-types.ts`
   - `src/server/agent-messaging.ts`
   - `src/server/agent-inbox-deliverer.ts`
   - `src/server/agent-file-extractor.ts` (already counted in 3a)
   - `src/lib/agent-message-types.ts`
   - `src/lib/sse-activity-stream.ts`
   - `src/routes/api/agents/message.ts`
   - `src/routes/api/agents/messages.ts`
   - `src/routes/api/agents/conversation.ts`
3. Decide: coexist with upstream's `agent-bus.ts` (different designs, both work) or merge (out of scope — leave coexist for now)
4. Test: trigger agent-to-agent message, verify inbox receives it, SSE stream updates
5. Commit: `feat(agent-comms): port agent message store and inbox from old custom fork`

### Phase 5: Validation, integration tests, push

1. **Full build**: `pnpm install && pnpm build` from clean — must succeed
2. **Test suite**: `npx vitest run` — must pass
3. **E2E (if present)**: `pnpm test:e2e`
4. **Manual smoke**:
   - Boot workspace: `pnpm dev`
   - Boot gateway: `hermes gateway run`
   - Boot dashboard: `hermes dashboard --port 9119`
   - Walk through: onboarding → create profile → spawn gateway → grill plan → dispatch → agent communication → mission cleanup
5. **Update package.json** version to `2.4.0-custom-port.1` or similar
6. **Update CHANGELOG.md** with the migration notes
7. **Merge `upgrade/v2.3.0-custom-port` into `feat/sprint-6`** after all green, push

---

## Risks and mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Upstream renamed types upstream's code uses our changes depend on | High | Phase V1+V2 verification before any code moves; small Phase 2 commits surface breakage immediately |
| `gateway-orchestrator.ts` (849 lines) porting breaks the AsyncLocalStorage flow upstream expects | Medium | Write integration test first (multi-profile WS round-trip) before porting |
| `mission-state-store.ts` data shape doesn't match upstream's `SwarmMission` | Medium | Read upstream `swarm-missions.ts` end-to-end in Phase 3c before writing any code |
| 435 commits of upstream changes include subtle renames our imports depend on | High | Run `tsc --noEmit` after each Phase 2 commit; fix imports immediately |
| Upstream's test suite has new tests that fail against our ported code | Medium | Run full `npx vitest run` after each phase; don't proceed with failing tests |
| Two .env files / path constants differ between old fork and new upstream | High | Compare `.env.example` and `claude-paths.ts` in Phase 1, fix all paths in first port commit |

## Estimated effort

| Phase | Effort |
|---|---|
| Pre-flight V1-V3 | 1-2 hours |
| Phase 1 (fresh branch) | 15 minutes |
| Phase 2 (Tier 3 replacements) | half day |
| Phase 3 (Tier 2 partial) | 3-4 days |
| Phase 4 (Tier 1 fresh) | half day to 1 day |
| Phase 5 (validation) | half day |
| **Total** | **5-7 working days** |

## Definition of done

- [ ] All Phase 1-5 commits land on `upgrade/v2.3.0-custom-port`
- [ ] `pnpm build` succeeds clean
- [ ] `npx vitest run` passes
- [ ] Manual smoke test passes (full workflow)
- [ ] No leftover imports of our deleted Tier 3 files (`grep -r "from.*hermes-agent\|from.*hermes-api" src/` returns clean)
- [ ] Branch merged to `feat/sprint-6`, pushed to `JasonAiassist/Hermes-Workspace`
- [ ] CHANGELOG.md updated
- [ ] This doc updated with any deviations from plan