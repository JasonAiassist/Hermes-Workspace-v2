import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { AgentSessionStatusEntry, TeamMember } from '@/screens/gateway/components/team-panel'
import type { HubTask, TaskStatus } from '@/screens/gateway/components/task-board'
import { isTaskCategory } from '@/screens/gateway/components/task-board'
import type { SavedTeamConfig } from '@/screens/gateway/components/hub-constants'
import type { AgentMetrics } from '@/server/planner/performance-tracker'
import {
  archiveMissionToHistory,
  loadMissionHistory,
  type MissionCheckpoint,
} from '@/screens/gateway/lib/mission-checkpoint'

export type MissionProcessType = 'sequential' | 'hierarchical' | 'parallel'
export type MissionLifecycleState =
  | 'idle'
  | 'running'
  | 'paused'
  | 'completed'
  | 'aborted'

export type MissionArtifact = {
  id: string
  agentId: string
  agentName: string
  type: 'html' | 'markdown' | 'code' | 'text'
  title: string
  content: string
  timestamp: number
}

export type MissionFeedEvent = {
  id: string
  type: string
  message: string
  agentName?: string
  taskTitle?: string
  timestamp: number
}

export type ActiveMission = {
  id: string
  goal: string
  name: string
  plan?: Array<{ title: string; description: string; agent?: string; enabled: boolean }>
  state: MissionLifecycleState
  team: TeamMember[]
  tasks: HubTask[]
  agentSessionMap: Record<string, string>
  agentSessionModelMap: Record<string, string>
  agentSessionStatus: Record<string, AgentSessionStatusEntry>
  processType: MissionProcessType
  budgetLimit: string
  startedAt: number
  artifacts: MissionArtifact[]
  agentMetrics: Record<string, AgentMetrics>
  feedEvents: MissionFeedEvent[]
}

export type MissionHistory = {
  reports: MissionCheckpoint[]
}

type Updater<T> = T | ((previous: T) => T)

export type StartMissionInput = Omit<
  ActiveMission,
  'state' | 'agentSessionMap' | 'agentSessionModelMap' | 'agentSessionStatus' | 'artifacts' | 'feedEvents'
> & {
  agentSessionMap?: Record<string, string>
  agentSessionModelMap?: Record<string, string>
  agentSessionStatus?: Record<string, AgentSessionStatusEntry>
  artifacts?: MissionArtifact[]
  feedEvents?: MissionFeedEvent[]
}

export type MissionStore = {
  activeMission: ActiveMission | null
  missionActive: boolean
  missionGoal: string
  activeMissionName: string
  activeMissionGoal: string
  missionState: 'running' | 'paused' | 'stopped'
  missionTasks: HubTask[]
  boardTasks: HubTask[]
  dispatchedTaskIdsByAgent: Record<string, string[]>
  agentSessionMap: Record<string, string>
  agentSessionModelMap: Record<string, string>
  agentSessionStatus: Record<string, AgentSessionStatusEntry>
  artifacts: MissionArtifact[]
  agentMetrics: Record<string, AgentMetrics>
  feedEvents: MissionFeedEvent[]
  restoreCheckpoint: MissionCheckpoint | null
  missionHistory: MissionHistory
  beforeUnloadRegistered: boolean
  savedTeams: SavedTeamConfig[]
  streamText: string
  workerOutputs: Record<string, string>
  startMission: (mission: StartMissionInput) => void
  completeMission: () => void
  abortMission: () => void
  resetMission: () => void
  updateTaskStatus: (taskId: string, status: TaskStatus) => void
  updateAgentStatus: (
    agentId: string,
    entry: AgentSessionStatusEntry | null,
    options?: { sessionKey?: string | null; model?: string | null },
  ) => void
  addArtifact: (artifact: MissionArtifact | MissionArtifact[]) => void
  addFeedEvent: (event: MissionFeedEvent) => void
  setMissionState: (
    state: Updater<MissionStore['missionState']>,
  ) => void
  setAgentMetrics: (metrics: Updater<Record<string, AgentMetrics>>) => void
  restoreMission: (checkpoint: MissionCheckpoint) => void
  setMissionGoal: (goal: string) => void
  setRestoreCheckpoint: (checkpoint: MissionCheckpoint | null) => void
  setBoardTasks: (tasks: Updater<HubTask[]>) => void
  setDispatchedTaskIdsByAgent: (
    value: Updater<Record<string, string[]>>,
  ) => void
  setMissionTasks: (tasks: Updater<HubTask[]>) => void
  setAgentSessionMap: (value: Updater<Record<string, string>>) => void
  setAgentSessionModelMap: (value: Updater<Record<string, string>>) => void
  setAgentSessionStatus: (
    value: Updater<Record<string, AgentSessionStatusEntry>>,
  ) => void
  setArtifacts: (value: Updater<MissionArtifact[]>) => void
  setFeedEvents: (value: Updater<MissionFeedEvent[]>) => void
  setActiveMissionMeta: (value: { name?: string; goal?: string }) => void
  saveCheckpoint: () => void
  markBeforeUnloadRegistered: (registered: boolean) => void
  saveTeam: (config: SavedTeamConfig) => void
  deleteTeam: (id: string) => void
  updateSavedTeam: (id: string, updates: Partial<SavedTeamConfig>) => void
  attachFilesToTasks: (taskIds: string[], files: string[]) => void
  appendStreamText: (text: string) => void
  setWorkerOutput: (sessionKey: string, output: string) => void
  clearStream: () => void
}

const MAX_HISTORY = 20

export function applyUpdater<T>(previous: T, next: Updater<T>): T {
  return typeof next === 'function'
    ? (next as (value: T) => T)(previous)
    : next
}

export function clampHistory(reports: MissionCheckpoint[]): MissionCheckpoint[] {
  return reports.slice(0, MAX_HISTORY)
}

export function buildCheckpoint(state: MissionStore): MissionCheckpoint | null {
  const mission = state.activeMission
  if (!mission) return null

  return {
    id: mission.id,
    label: mission.name || mission.goal || 'Untitled mission',
    name: mission.name,
    goal: mission.goal,
    processType: mission.processType,
    team: mission.team.map((member) => ({
      ...member,
    })),
    tasks: mission.tasks.map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      assignedTo: task.agentId,
      // NEW — Sprint 1 planning fields
      dependencies: task.dependencies,
      requiredSkills: task.requiredSkills,
      estimatedComplexity: task.estimatedComplexity,
      category: task.category,
    })),
    agentSessionMap: { ...mission.agentSessionMap },
    agentSessions: { ...mission.agentSessionMap },
    agentSessionModelMap: { ...mission.agentSessionModelMap },
    status:
      mission.state === 'idle'
        ? 'paused'
        : mission.state === 'completed'
          ? 'completed'
          : mission.state === 'aborted'
            ? 'aborted'
            : mission.state,
    startedAt: mission.startedAt,
    updatedAt: Date.now(),
    budgetLimit: mission.budgetLimit,
    agentMetrics: state.agentMetrics,
    feedEvents: mission.feedEvents,
  }
}

export function syncActiveMission(state: MissionStore): Partial<MissionStore> {
  if (!state.activeMission) {
    return {
      missionActive: false,
      activeMissionName: '',
      activeMissionGoal: '',
      missionTasks: [],
      agentSessionMap: {},
      agentSessionModelMap: {},
      agentSessionStatus: {},
      artifacts: [],
      agentMetrics: {},
    }
  }

  return {
    missionActive:
      state.activeMission.state === 'running' || state.activeMission.state === 'paused',
    activeMissionName: state.activeMission.name,
    activeMissionGoal: state.activeMission.goal,
    missionTasks: state.activeMission.tasks,
    agentSessionMap: state.activeMission.agentSessionMap,
    agentSessionModelMap: state.activeMission.agentSessionModelMap,
    agentSessionStatus: state.activeMission.agentSessionStatus,
    artifacts: state.activeMission.artifacts,
    agentMetrics: state.activeMission.agentMetrics ?? {},
    feedEvents: state.activeMission.feedEvents ?? [],
  }
}

export function updateCheckpointSnapshot(state: MissionStore): Partial<MissionStore> {
  const checkpoint = buildCheckpoint(state)
  return {
    restoreCheckpoint:
      checkpoint && (state.missionState === 'running' || state.missionState === 'paused')
        ? checkpoint
        : null,
  }
}

const initialHistory = clampHistory(loadMissionHistory())

export const useMissionStore = create<MissionStore>()(
  persist(
    (set, get) => ({
      activeMission: null,
      missionActive: false,
      missionGoal: '',
      activeMissionName: '',
      activeMissionGoal: '',
      missionState: 'stopped',
      missionTasks: [],
      boardTasks: [],
      dispatchedTaskIdsByAgent: {},
      agentSessionMap: {},
      agentSessionModelMap: {},
      agentSessionStatus: {},
      artifacts: [],
      agentMetrics: {},
      feedEvents: [],
      restoreCheckpoint: null,
      missionHistory: { reports: initialHistory },
      beforeUnloadRegistered: false,
      savedTeams: [],
      streamText: '',
      workerOutputs: {},

      startMission: (mission) => {
        const activeMission: ActiveMission = {
          ...mission,
          plan: mission.plan?.map((task) => ({ ...task })),
          state: 'running',
          agentSessionMap: { ...(mission.agentSessionMap ?? {}) },
          agentSessionModelMap: { ...(mission.agentSessionModelMap ?? {}) },
          agentSessionStatus: { ...(mission.agentSessionStatus ?? {}) },
          artifacts: [...(mission.artifacts ?? [])],
          agentMetrics: {},
          tasks: [...mission.tasks],
          team: mission.team.map((member) => ({ ...member })),
          feedEvents: [],
        }

        set((state) => {
          const nextState: MissionStore = {
            ...state,
            activeMission,
            missionActive: true,
            missionGoal: mission.goal,
            activeMissionName: mission.name,
            activeMissionGoal: mission.goal,
            missionState: 'running',
            missionTasks: activeMission.tasks,
            agentSessionMap: activeMission.agentSessionMap,
            agentSessionModelMap: activeMission.agentSessionModelMap,
            agentSessionStatus: activeMission.agentSessionStatus,
            artifacts: activeMission.artifacts,
            feedEvents: activeMission.feedEvents,
            dispatchedTaskIdsByAgent: {},
            restoreCheckpoint: null,
            streamText: '',
            workerOutputs: {},
          }
          return {
            ...nextState,
            ...updateCheckpointSnapshot(nextState),
          }
        })
      },

      completeMission: () => {
        const state = get()
        if (!state.activeMission) return
        const completedMission: ActiveMission = {
          ...state.activeMission,
          state: 'completed',
        }
        const checkpoint = buildCheckpoint({
          ...state,
          activeMission: completedMission,
        })
        const reports = checkpoint
          ? clampHistory([checkpoint, ...state.missionHistory.reports.filter((entry) => entry.id !== checkpoint.id)])
          : state.missionHistory.reports
        if (checkpoint) {
          archiveMissionToHistory(checkpoint)
        }
        set({
          activeMission: completedMission,
          missionActive: false,
          missionState: 'stopped',
          missionTasks: [],
          dispatchedTaskIdsByAgent: {},
          restoreCheckpoint: null,
          missionHistory: { reports },
        })
      },

      abortMission: () => {
        const state = get()
        if (!state.activeMission) return
        const abortedMission: ActiveMission = {
          ...state.activeMission,
          state: 'aborted',
        }
        const checkpoint = buildCheckpoint({
          ...state,
          activeMission: abortedMission,
        })
        const reports = checkpoint
          ? clampHistory([checkpoint, ...state.missionHistory.reports.filter((entry) => entry.id !== checkpoint.id)])
          : state.missionHistory.reports
        if (checkpoint) {
          archiveMissionToHistory(checkpoint)
        }
        set({
          activeMission: abortedMission,
          missionActive: false,
          missionState: 'stopped',
          missionTasks: [],
          dispatchedTaskIdsByAgent: {},
          restoreCheckpoint: null,
          missionHistory: { reports },
        })
      },

      resetMission: () => {
        set({
          activeMission: null,
          missionActive: false,
          missionGoal: '',
          activeMissionName: '',
          activeMissionGoal: '',
          missionState: 'stopped',
          missionTasks: [],
          boardTasks: [],
          dispatchedTaskIdsByAgent: {},
          agentSessionMap: {},
          agentSessionModelMap: {},
          agentSessionStatus: {},
          artifacts: [],
          restoreCheckpoint: null,
          streamText: '',
          workerOutputs: {},
        })
      },

      updateTaskStatus: (taskId, status) => {
        set((state) => {
          if (!state.activeMission) return state
          const tasks = state.activeMission.tasks.map((task) =>
            task.id === taskId && task.status !== status
              ? { ...task, status, updatedAt: Date.now() }
              : task,
          )
          const activeMission = {
            ...state.activeMission,
            tasks,
          }
          const nextState: MissionStore = {
            ...state,
            activeMission,
            missionTasks: tasks,
          }
          return {
            ...nextState,
            ...updateCheckpointSnapshot(nextState),
          }
        })
      },

      updateAgentStatus: (agentId, entry, options) => {
        set((state) => {
          if (!state.activeMission) return state
          const agentSessionStatus = { ...state.activeMission.agentSessionStatus }
          if (entry) {
            agentSessionStatus[agentId] = entry
          } else {
            delete agentSessionStatus[agentId]
          }

          const agentSessionMap = { ...state.activeMission.agentSessionMap }
          if (options?.sessionKey === null) {
            delete agentSessionMap[agentId]
          } else if (typeof options?.sessionKey === 'string') {
            agentSessionMap[agentId] = options.sessionKey
          }

          const agentSessionModelMap = { ...state.activeMission.agentSessionModelMap }
          if (options?.model === null) {
            delete agentSessionModelMap[agentId]
          } else if (typeof options?.model === 'string' && options.model.length > 0) {
            agentSessionModelMap[agentId] = options.model
          }

          const activeMission = {
            ...state.activeMission,
            agentSessionStatus,
            agentSessionMap,
            agentSessionModelMap,
          }
          const nextState: MissionStore = {
            ...state,
            activeMission,
            agentSessionStatus,
            agentSessionMap,
            agentSessionModelMap,
          }
          return {
            ...nextState,
            ...updateCheckpointSnapshot(nextState),
          }
        })
      },

      addArtifact: (artifact) => {
        const additions = Array.isArray(artifact) ? artifact : [artifact]
        set((state) => {
          if (!state.activeMission || additions.length === 0) return state
          const artifacts = [...state.activeMission.artifacts, ...additions]
          const activeMission = {
            ...state.activeMission,
            artifacts,
          }
          const nextState: MissionStore = {
            ...state,
            activeMission,
            artifacts,
          }
          return {
            ...nextState,
            ...updateCheckpointSnapshot(nextState),
          }
        })
      },

      addFeedEvent: (event) => {
        set((state) => {
          if (!state.activeMission) return state
          const feedEvents = [...state.activeMission.feedEvents, event].slice(-500)
          const activeMission = {
            ...state.activeMission,
            feedEvents,
          }
          const nextState: MissionStore = {
            ...state,
            activeMission,
            feedEvents,
          }
          return {
            ...nextState,
            ...updateCheckpointSnapshot(nextState),
          }
        })
      },

      setMissionState: (missionStateValue) => {
        set((state) => {
          const missionState = applyUpdater(state.missionState, missionStateValue)
          const activeMission = state.activeMission
            ? {
                ...state.activeMission,
                state:
                  missionState === 'stopped'
                    ? state.activeMission.state === 'aborted' ||
                      state.activeMission.state === 'completed'
                      ? state.activeMission.state
                      : 'paused'
                    : missionState,
              }
            : null
          const nextState: MissionStore = {
            ...state,
            activeMission,
            missionState,
          }
          return {
            ...nextState,
            ...syncActiveMission(nextState),
            ...updateCheckpointSnapshot(nextState),
          }
        })
      },

      setAgentMetrics: (metricsValue) => {
        set((state) => {
          const agentMetrics = applyUpdater(state.agentMetrics, metricsValue)
          const activeMission = state.activeMission
            ? { ...state.activeMission, agentMetrics }
            : null
          const nextState: MissionStore = {
            ...state,
            activeMission,
            agentMetrics,
          }
          return {
            ...nextState,
            ...syncActiveMission(nextState),
            ...updateCheckpointSnapshot(nextState),
          }
        })
      },

      restoreMission: (checkpoint) => {
        const restoredTasks: HubTask[] = checkpoint.tasks.map((task) => ({
          id: task.id,
          title: task.title,
          description: '',
          priority: 'normal',
          status: task.status as TaskStatus,
          agentId: task.assignedTo,
          missionId: checkpoint.id,
          createdAt: checkpoint.startedAt,
          updatedAt: checkpoint.updatedAt,
          // NEW — Sprint 1 planning fields
          dependencies: Array.isArray(task.dependencies) ? task.dependencies : undefined,
          requiredSkills: Array.isArray(task.requiredSkills) ? task.requiredSkills : undefined,
          estimatedComplexity:
            task.estimatedComplexity === 'trivial' ||
            task.estimatedComplexity === 'small' ||
            task.estimatedComplexity === 'medium' ||
            task.estimatedComplexity === 'large'
              ? task.estimatedComplexity
              : undefined,
          category: isTaskCategory(task.category) ? task.category : undefined,
        }))
        const activeMission: ActiveMission = {
          id: checkpoint.id,
          goal: checkpoint.goal ?? '',
          name: checkpoint.name ?? checkpoint.label ?? '',
          state: checkpoint.status === 'paused' ? 'paused' : 'running',
          team: checkpoint.team.map((member) => ({
            ...member,
            status: 'available',
            costPreference:
              member.costPreference === 'cheap' ||
              member.costPreference === 'fast' ||
              member.costPreference === 'capable'
                ? member.costPreference
                : undefined,
          })),
          tasks: restoredTasks,
          agentSessionMap: {
            ...(checkpoint.agentSessions ?? checkpoint.agentSessionMap ?? {}),
          },
          agentSessionModelMap: { ...(checkpoint.agentSessionModelMap ?? {}) },
          agentSessionStatus: {},
          processType: checkpoint.processType,
          budgetLimit: checkpoint.budgetLimit ?? '',
          startedAt: checkpoint.startedAt,
          artifacts: [],
          agentMetrics: checkpoint.agentMetrics ?? {},
          feedEvents: [],
        }
        const nextState: MissionStore = {
          ...get(),
          activeMission,
          missionActive: true,
          missionGoal: checkpoint.goal ?? '',
          activeMissionName: activeMission.name,
          activeMissionGoal: activeMission.goal,
          missionState: checkpoint.status === 'paused' ? 'paused' : 'running',
          missionTasks: restoredTasks,
          agentSessionMap: activeMission.agentSessionMap,
          agentSessionModelMap: activeMission.agentSessionModelMap,
          agentSessionStatus: {},
          artifacts: [],
          agentMetrics: checkpoint.agentMetrics ?? {},
          feedEvents: [],
          restoreCheckpoint: null,
        }
        set({
          ...nextState,
          ...updateCheckpointSnapshot(nextState),
        })
      },

      setMissionGoal: (missionGoal) => set({ missionGoal }),
      setRestoreCheckpoint: (restoreCheckpoint) => set({ restoreCheckpoint }),
      setBoardTasks: (tasks) =>
        set((state) => ({ boardTasks: applyUpdater(state.boardTasks, tasks) })),
      setDispatchedTaskIdsByAgent: (value) =>
        set((state) => ({
          dispatchedTaskIdsByAgent: applyUpdater(state.dispatchedTaskIdsByAgent, value),
        })),
      setMissionTasks: (tasks) =>
        set((state) => {
          const missionTasks = applyUpdater(state.missionTasks, tasks)
          const activeMission = state.activeMission
            ? {
                ...state.activeMission,
                tasks: missionTasks,
              }
            : null
          const nextState: MissionStore = {
            ...state,
            activeMission,
            missionTasks,
          }
          return {
            ...nextState,
            ...updateCheckpointSnapshot(nextState),
          }
        }),
      setAgentSessionMap: (value) =>
        set((state) => {
          const agentSessionMap = applyUpdater(state.agentSessionMap, value)
          const activeMission = state.activeMission
            ? {
                ...state.activeMission,
                agentSessionMap,
              }
            : null
          const nextState: MissionStore = {
            ...state,
            activeMission,
            agentSessionMap,
          }
          return {
            ...nextState,
            ...updateCheckpointSnapshot(nextState),
          }
        }),
      setAgentSessionModelMap: (value) =>
        set((state) => {
          const agentSessionModelMap = applyUpdater(state.agentSessionModelMap, value)
          const activeMission = state.activeMission
            ? {
                ...state.activeMission,
                agentSessionModelMap,
              }
            : null
          const nextState: MissionStore = {
            ...state,
            activeMission,
            agentSessionModelMap,
          }
          return {
            ...nextState,
            ...updateCheckpointSnapshot(nextState),
          }
        }),
      setAgentSessionStatus: (value) =>
        set((state) => {
          const agentSessionStatus = applyUpdater(state.agentSessionStatus, value)
          const activeMission = state.activeMission
            ? {
                ...state.activeMission,
                agentSessionStatus,
              }
            : null
          const nextState: MissionStore = {
            ...state,
            activeMission,
            agentSessionStatus,
          }
          return {
            ...nextState,
            ...updateCheckpointSnapshot(nextState),
          }
        }),
      setArtifacts: (value) =>
        set((state) => {
          const artifacts = applyUpdater(state.artifacts, value)
          const activeMission = state.activeMission
            ? {
                ...state.activeMission,
                artifacts,
              }
            : null
          const nextState: MissionStore = {
            ...state,
            activeMission,
            artifacts,
          }
          return {
            ...nextState,
            ...updateCheckpointSnapshot(nextState),
          }
        }),
      setFeedEvents: (value) =>
        set((state) => {
          const feedEvents = applyUpdater(state.feedEvents, value)
          const activeMission = state.activeMission
            ? {
                ...state.activeMission,
                feedEvents,
              }
            : null
          const nextState: MissionStore = {
            ...state,
            activeMission,
            feedEvents,
          }
          return {
            ...nextState,
            ...updateCheckpointSnapshot(nextState),
          }
        }),
      setActiveMissionMeta: (value) =>
        set((state) => {
          if (!state.activeMission) {
            return {
              activeMissionName: value.name ?? state.activeMissionName,
              activeMissionGoal: value.goal ?? state.activeMissionGoal,
            }
          }
          const activeMission = {
            ...state.activeMission,
            name: value.name ?? state.activeMission.name,
            goal: value.goal ?? state.activeMission.goal,
          }
          const nextState: MissionStore = {
            ...state,
            activeMission,
            activeMissionName: activeMission.name,
            activeMissionGoal: activeMission.goal,
          }
          return {
            ...nextState,
            ...updateCheckpointSnapshot(nextState),
          }
        }),
      saveCheckpoint: () => {
        const state = get()
        const checkpoint = buildCheckpoint(state)
        if (!checkpoint) return
        set({ restoreCheckpoint: checkpoint })
      },
      markBeforeUnloadRegistered: (beforeUnloadRegistered) =>
        set({ beforeUnloadRegistered }),

      saveTeam: (config: SavedTeamConfig) =>
        set((state) => ({
          savedTeams: [
            config,
            ...state.savedTeams.filter((t) => t.id !== config.id),
          ],
        })),

      deleteTeam: (id: string) =>
        set((state) => ({
          savedTeams: state.savedTeams.filter((t) => t.id !== id),
        })),

      updateSavedTeam: (id: string, updates: Partial<SavedTeamConfig>) =>
        set((state) => ({
          savedTeams: state.savedTeams.map((t) =>
            t.id === id ? { ...t, ...updates, updatedAt: Date.now() } : t,
          ),
        })),

      attachFilesToTasks: (taskIds, files) => {
        if (taskIds.length === 0 || files.length === 0) return
        set((state) => {
          if (!state.activeMission) return state
          const taskIdSet = new Set(taskIds)
          const tasks = state.activeMission.tasks.map((task) => {
            if (!taskIdSet.has(task.id)) return task
            const existing = task.files ?? []
            const merged = Array.from(new Set([...existing, ...files]))
            return { ...task, files: merged, updatedAt: Date.now() }
          })
          const activeMission = { ...state.activeMission, tasks }
          const nextState: MissionStore = {
            ...state,
            activeMission,
            missionTasks: tasks,
          }
          return {
            ...nextState,
            ...updateCheckpointSnapshot(nextState),
          }
        })
      },

      appendStreamText: (text) => {
        set((state) => ({
          streamText: state.streamText + text,
        }))
      },

      setWorkerOutput: (sessionKey, output) => {
        set((state) => ({
          workerOutputs: { ...state.workerOutputs, [sessionKey]: output },
        }))
      },

      clearStream: () => {
        set({ streamText: '', workerOutputs: {} })
      },
    }),
    {
      name: 'clawsuite:mission-store',
      partialize: (state) => {
        const { streamText, workerOutputs, ...persisted } = state
        return persisted
      },
      onRehydrateStorage: () => (state) => {
        if (!state) return
        if (state.activeMission && !state.restoreCheckpoint) {
          const checkpoint = buildCheckpoint(state)
          if (checkpoint && (state.missionState === 'running' || state.missionState === 'paused')) {
            state.restoreCheckpoint = checkpoint
          }
        }
        state.missionHistory = {
          reports: clampHistory(state.missionHistory?.reports ?? initialHistory),
        }
      },
    },
  ),
)

export function saveMissionStoreBeforeUnload(): void {
  const state = useMissionStore.getState()
  if (state.missionState !== 'running') return
  state.saveCheckpoint()
}
