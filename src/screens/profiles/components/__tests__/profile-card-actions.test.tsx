// @vitest-environment jsdom
/**
 * Behavior tests for ProfileCardActions.
 *
 * Verifies:
 *  - Runtime status badge reflects healthy / unhealthy / stopped / loading.
 *  - Start vs Stop toggle is driven by status === 'healthy'.
 *  - Port info renders when present.
 *  - Each action button fires its callback on click.
 *  - Activate + Delete are disabled when the profile is already active.
 *  - Mutating actions are disabled while isBusy is true.
 *  - RuntimeStatusBadge maps every status to the expected label.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'

// Mock @hugeicons/react so the SVG <HugeiconsIcon> wrapper renders a plain
// <svg> with the icon size — keeps assertions DOM-readable.
vi.mock('@hugeicons/react', () => ({
  HugeiconsIcon: (props: { icon: unknown; size?: number }) =>
    React.createElement('svg', {
      'data-testid': 'hugeicon',
      'data-icon': typeof props.icon === 'string' ? String(props.icon) : 'icon',
      width: props.size ?? 16,
      height: props.size ?? 16,
    }),
}))

// Mock @hugeicons/core-free-icons to importable string tokens so the icon
// identity can be asserted if needed (we mainly care that rendering works).
vi.mock('@hugeicons/core-free-icons', () => {
  const stub = (name: string) => name
  return {
    PlayIcon: stub('Play'),
    StopIcon: stub('Stop'),
    SparklesIcon: stub('Sparkles'),
    Folder01Icon: stub('Folder01'),
    Edit02Icon: stub('Edit02'),
    Copy01Icon: stub('Copy01'),
    Delete02Icon: stub('Delete02'),
  }
})

vi.mock('@/lib/utils', () => ({
  cn: (...inputs: Array<unknown>) =>
    inputs.filter(Boolean).join(' '),
}))

import {
  ProfileCardActions,
  type ProfileCardActionsProps,
} from '../profile-card-actions'
import type { ProfileGatewayStatus } from '../../hooks/use-profile-gateway-status'

async function renderInto(element: React.ReactElement) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await React.act(async () => {
    root.render(element)
  })
  return {
    container,
    unmount: async () => {
      await React.act(async () => {
        root.unmount()
      })
      document.body.removeChild(container)
    },
  }
}

function baseProps(overrides: Partial<ProfileCardActionsProps> = {}): ProfileCardActionsProps {
  return {
    profileName: 'default',
    isActive: false,
    isBusy: false,
    status: undefined,
    statusLoading: false,
    onActivate: vi.fn(),
    onDetails: vi.fn(),
    onRename: vi.fn(),
    onClone: vi.fn(),
    onDelete: vi.fn(),
    onStart: vi.fn(),
    onStop: vi.fn(),
    onRequestStopConfirm: vi.fn(),
    ...overrides,
  }
}

/** Find the first <button> whose trimmed textContent equals `label`. */
function findButton(container: HTMLElement, label: string): HTMLButtonElement {
  const buttons = Array.from(
    container.querySelectorAll('button'),
  ) as HTMLButtonElement[]
  const match = buttons.find(
    (b) => b.textContent?.replace(/\s+/g, ' ').trim() === label,
  )
  if (!match) {
    throw new Error(
      `No button with text "${label}". Found: ${buttons
        .map((b) => `"${b.textContent?.trim()}"`)
        .join(', ')}`,
    )
  }
  return match
}

beforeEach(() => vi.restoreAllMocks())
afterEach(() => vi.restoreAllMocks())

describe('ProfileCardActions — runtime status badge', () => {
  it('renders "Running" badge when status is healthy', async () => {
    const status: ProfileGatewayStatus = { status: 'healthy' }
    const { container, unmount } = await renderInto(
      React.createElement(ProfileCardActions, baseProps({ status })),
    )
    expect(container.textContent).toContain('Running')
    await unmount()
  })

  it('renders "Unhealthy" badge when status is unhealthy', async () => {
    const status: ProfileGatewayStatus = {
      status: 'unhealthy',
      health: { latencyMs: 0, error: 'boom' },
    }
    const { container, unmount } = await renderInto(
      React.createElement(ProfileCardActions, baseProps({ status })),
    )
    expect(container.textContent).toContain('Unhealthy')
    await unmount()
  })

  it('falls back to "Stopped" badge when no status is present', async () => {
    const { container, unmount } = await renderInto(
      React.createElement(ProfileCardActions, baseProps({ status: undefined })),
    )
    expect(container.textContent).toContain('Stopped')
    await unmount()
  })

  it('shows "Checking…" while loading and status is not yet available', async () => {
    const { container, unmount } = await renderInto(
      React.createElement(
        ProfileCardActions,
        baseProps({ statusLoading: true, status: undefined }),
      ),
    )
    expect(container.textContent).toContain('Checking…')
    await unmount()
  })

  it('renders http/ws ports when status.ports is present', async () => {
    const status: ProfileGatewayStatus = {
      status: 'healthy',
      ports: { http: 8642, ws: 18789 },
    }
    const { container, unmount } = await renderInto(
      React.createElement(ProfileCardActions, baseProps({ status })),
    )
    expect(container.textContent).toContain(':8642 / WS:18789')
    await unmount()
  })

  it('omits the port span when status has no ports', async () => {
    const status: ProfileGatewayStatus = { status: 'healthy' }
    const { container, unmount } = await renderInto(
      React.createElement(ProfileCardActions, baseProps({ status })),
    )
    expect(container.textContent).not.toContain('/ WS:')
    await unmount()
  })
})

describe('ProfileCardActions — Start/Stop toggle', () => {
  it('shows the Start button and fires onStart when not healthy', async () => {
    const onStart = vi.fn()
    const { container, unmount } = await renderInto(
      React.createElement(
        ProfileCardActions,
        baseProps({ status: { status: 'stopped' }, onStart }),
      ),
    )
    const startBtn = findButton(container, 'Start')
    expect(startBtn.disabled).toBe(false)
    await React.act(async () => {
      startBtn.click()
    })
    expect(onStart).toHaveBeenCalledTimes(1)
    await unmount()
  })

  it('shows the Stop button and fires onRequestStopConfirm when healthy', async () => {
    const onRequestStopConfirm = vi.fn()
    const { container, unmount } = await renderInto(
      React.createElement(
        ProfileCardActions,
        baseProps({
          status: { status: 'healthy' },
          onRequestStopConfirm,
        }),
      ),
    )
    const stopBtn = findButton(container, 'Stop')
    await React.act(async () => {
      stopBtn.click()
    })
    expect(onRequestStopConfirm).toHaveBeenCalledTimes(1)
    await unmount()
  })

  it('disables the Start button while isBusy', async () => {
    const { container, unmount } = await renderInto(
      React.createElement(
        ProfileCardActions,
        baseProps({ status: { status: 'stopped' }, isBusy: true }),
      ),
    )
    expect(findButton(container, 'Start').disabled).toBe(true)
    await unmount()
  })

  it('disables the Stop button while isBusy', async () => {
    const { container, unmount } = await renderInto(
      React.createElement(
        ProfileCardActions,
        baseProps({
          status: { status: 'healthy' },
          isBusy: true,
        }),
      ),
    )
    expect(findButton(container, 'Stop').disabled).toBe(true)
    await unmount()
  })
})

describe('ProfileCardActions — action row callbacks', () => {
  it('fires onActivate, onDetails, onRename, onClone on click', async () => {
    const handlers = {
      onActivate: vi.fn(),
      onDetails: vi.fn(),
      onRename: vi.fn(),
      onClone: vi.fn(),
    }
    const { container, unmount } = await renderInto(
      React.createElement(ProfileCardActions, baseProps(handlers)),
    )

    for (const label of ['Activate', 'Details', 'Rename', 'Clone']) {
      await React.act(async () => {
        findButton(container, label).click()
      })
    }
    expect(handlers.onActivate).toHaveBeenCalledTimes(1)
    expect(handlers.onDetails).toHaveBeenCalledTimes(1)
    expect(handlers.onRename).toHaveBeenCalledTimes(1)
    expect(handlers.onClone).toHaveBeenCalledTimes(1)
    await unmount()
  })

  it('fires onDelete on click', async () => {
    const onDelete = vi.fn()
    const { container, unmount } = await renderInto(
      React.createElement(ProfileCardActions, baseProps({ onDelete })),
    )
    await React.act(async () => {
      findButton(container, 'Delete').click()
    })
    expect(onDelete).toHaveBeenCalledTimes(1)
    await unmount()
  })
})

describe('ProfileCardActions — disabled state', () => {
  it('disables Activate when isActive', async () => {
    const { container, unmount } = await renderInto(
      React.createElement(ProfileCardActions, baseProps({ isActive: true })),
    )
    expect(findButton(container, 'Activate').disabled).toBe(true)
    await unmount()
  })

  it('disables Delete when isActive', async () => {
    const { container, unmount } = await renderInto(
      React.createElement(ProfileCardActions, baseProps({ isActive: true })),
    )
    expect(findButton(container, 'Delete').disabled).toBe(true)
    await unmount()
  })

  it('disables Rename, Clone, Activate, Delete while isBusy', async () => {
    const { container, unmount } = await renderInto(
      React.createElement(ProfileCardActions, baseProps({ isBusy: true })),
    )
    for (const label of ['Rename', 'Clone', 'Activate', 'Delete']) {
      expect(findButton(container, label).disabled).toBe(true)
    }
    await unmount()
  })

  it('keeps Details enabled even when isBusy (read-only action)', async () => {
    const { container, unmount } = await renderInto(
      React.createElement(ProfileCardActions, baseProps({ isBusy: true })),
    )
    expect(findButton(container, 'Details').disabled).toBe(false)
    await unmount()
  })
})
