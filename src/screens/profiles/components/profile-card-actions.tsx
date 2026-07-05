import { HugeiconsIcon } from '@hugeicons/react'
import {
  Copy01Icon,
  Delete02Icon,
  Edit02Icon,
  Folder01Icon,
  PlayIcon,
  SparklesIcon,
  StopIcon,
} from '@hugeicons/core-free-icons'
import { cn } from '@/lib/utils'
import type { ProfileGatewayStatus } from '../hooks/use-profile-gateway-status'

export type ProfileCardActionsProps = {
  profileName: string
  isActive: boolean
  isBusy: boolean
  status?: ProfileGatewayStatus
  statusLoading: boolean
  onActivate: () => void
  onDetails: () => void
  onRename: () => void
  onClone: () => void
  onDelete: () => void
  onStart: () => void
  onStop: () => void
  onRequestStopConfirm: () => void
}

function RuntimeStatusBadge({
  status,
}: {
  status: 'stopped' | 'healthy' | 'unhealthy'
}) {
  const styles = {
    stopped:
      'bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400',
    healthy:
      'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-400',
    unhealthy:
      'bg-red-100 text-red-700 dark:bg-red-950/30 dark:text-red-400',
  }

  const labels = {
    stopped: 'Stopped',
    healthy: 'Running',
    unhealthy: 'Unhealthy',
  }

  return (
    <span
      className={cn(
        'rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider',
        styles[status],
      )}
    >
      {labels[status]}
    </span>
  )
}

/**
 * Footer of a profile card: runtime status badge + live port info, a
 * Start/Stop toggle bound to the profile's gateway, and a row of actions
 * (Activate / Details / Rename / Clone / Delete).
 *
 * Behavior rules:
 *  - When status is `healthy`, the Stop button is shown; otherwise Start.
 *  - Activate and Delete are disabled when the profile is already active.
 *  - All mutations are disabled while `isBusy` is true (a sibling mutation
 *    is in-flight) to prevent overlapping operations.
 */
export function ProfileCardActions({
  profileName: _profileName,
  isActive,
  isBusy,
  status,
  statusLoading,
  onActivate,
  onDetails,
  onRename,
  onClone,
  onDelete,
  onStart,
  onStop: _onStop,
  onRequestStopConfirm,
}: ProfileCardActionsProps) {
  const isRunning = status?.status === 'healthy'

  return (
    <>
      {/* Runtime status bar */}
      <div className="mx-4 mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          {statusLoading && !status ? (
            <span className="text-[10px] text-primary-400 dark:text-neutral-500">
              Checking…
            </span>
          ) : status ? (
            <RuntimeStatusBadge status={status.status} />
          ) : (
            <RuntimeStatusBadge status="stopped" />
          )}
          {status?.ports && (
            <span className="text-[10px] text-primary-400 dark:text-neutral-500">
              :{status.ports.http} / WS:{status.ports.ws}
            </span>
          )}
        </div>
        {isRunning ? (
          <button
            type="button"
            onClick={() => {
              onRequestStopConfirm()
            }}
            disabled={isBusy}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold text-red-600 transition-colors hover:bg-red-50 disabled:opacity-50 dark:text-red-400 dark:hover:bg-red-950/20"
          >
            <HugeiconsIcon icon={StopIcon} size={12} strokeWidth={1.8} />
            Stop
          </button>
        ) : (
          <button
            type="button"
            onClick={() => {
              onStart()
            }}
            disabled={isBusy}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold text-emerald-700 transition-colors hover:bg-emerald-50 disabled:opacity-50 dark:text-emerald-400 dark:hover:bg-emerald-950/20"
          >
            <HugeiconsIcon icon={PlayIcon} size={12} strokeWidth={1.8} />
            Start
          </button>
        )}
      </div>

      {/* Actions */}
      <div className="flex border-t border-primary-200 dark:border-neutral-800">
        <button
          type="button"
          onClick={() => void onActivate()}
          disabled={isActive || isBusy}
          className={cn(
            'flex flex-1 items-center justify-center gap-1.5 border-r border-primary-200 py-2.5 text-xs font-semibold transition-colors dark:border-neutral-800',
            isActive
              ? 'cursor-default text-primary-300 dark:text-neutral-600'
              : 'text-primary-700 hover:bg-primary-100 dark:text-neutral-300 dark:hover:bg-neutral-900',
          )}
        >
          <HugeiconsIcon icon={SparklesIcon} size={13} strokeWidth={1.8} />
          Activate
        </button>
        <button
          type="button"
          onClick={() => void onDetails()}
          className="flex flex-1 items-center justify-center gap-1.5 border-r border-primary-200 py-2.5 text-xs font-semibold text-primary-700 transition-colors hover:bg-primary-100 dark:border-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-900"
        >
          <HugeiconsIcon icon={Folder01Icon} size={13} strokeWidth={1.8} />
          Details
        </button>
        <button
          type="button"
          onClick={() => void onRename()}
          disabled={isBusy}
          className="flex flex-1 items-center justify-center gap-1.5 border-r border-primary-200 py-2.5 text-xs font-semibold text-primary-700 transition-colors hover:bg-primary-100 disabled:opacity-50 dark:border-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-900"
        >
          <HugeiconsIcon icon={Edit02Icon} size={13} strokeWidth={1.8} />
          Rename
        </button>
        <button
          type="button"
          onClick={() => void onClone()}
          disabled={isBusy}
          className="flex flex-1 items-center justify-center gap-1.5 border-r border-primary-200 py-2.5 text-xs font-semibold text-primary-700 transition-colors hover:bg-primary-100 disabled:opacity-50 dark:border-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-900"
        >
          <HugeiconsIcon icon={Copy01Icon} size={13} strokeWidth={1.8} />
          Clone
        </button>
        <button
          type="button"
          onClick={() => void onDelete()}
          disabled={isActive || isBusy}
          className={cn(
            'flex flex-1 items-center justify-center gap-1.5 py-2.5 text-xs font-semibold transition-colors',
            isActive
              ? 'cursor-default text-primary-300 dark:text-neutral-600'
              : 'text-red-500 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/20',
          )}
        >
          <HugeiconsIcon icon={Delete02Icon} size={13} strokeWidth={1.8} />
          Delete
        </button>
      </div>
    </>
  )
}
