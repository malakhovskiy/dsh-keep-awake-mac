/**
 * macOS keep-awake (v2, config-driven): hold a power assertion while any DSH
 * agent is working.
 *
 * Loads as a no-op off macOS, or when `enabled` is false. The assertion lives
 * as long as at least one agent reports `running` (the `agent/status`
 * transitions) and is released the moment the last running agent goes idle or
 * is disposed — no timer windows.
 *
 * The caffeinate process is tied to the host PID with `-w`, so it cannot
 * outlive the harness process even if the managed-range teardown is missed.
 *
 * Configuration (the profile patch `config:` block, all optional — defaults
 * are merged for omitted values):
 *
 *   config:
 *     enabled: true
 *     flags:
 *       idle: true      # -i  prevent idle system sleep (the core use case)
 *       system: true    # -s  prevent system sleep; AC power only (lid-closed)
 *       display: false  # -d  prevent display sleep
 *       disk: false     # -m  prevent disk idle sleep
 */
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'keep-awake'
export const inject = ['agents', 'subprocess']

const here = dirname(fileURLToPath(import.meta.url))
const CAFFEINATE = '/usr/bin/caffeinate'
const GRACE_MS = 3000
const DEFAULTS = {
  enabled: true,
  flags: { idle: true, system: true, display: false, disk: false },
}
const FLAG_LETTERS = { idle: 'i', system: 's', display: 'd', disk: 'm' }

/** Merge the (optional, partial) patch config onto the defaults. */
function resolveConfig(config) {
  const flags = { ...DEFAULTS.flags, ...(config?.flags ?? {}) }
  return {
    enabled: config?.enabled ?? DEFAULTS.enabled,
    flags,
  }
}

export function apply(ctx, config) {
  const resolved = resolveConfig(config)
  if (process.platform !== 'darwin' || !existsSync(CAFFEINATE)) return
  if (!resolved.enabled) return
  const flags = Object.keys(FLAG_LETTERS).filter(key => resolved.flags[key]).map(key => `-${FLAG_LETTERS[key]}`)
  if (flags.length === 0) return
  const running = new Set()
  let handle = undefined

  const start = () => {
    if (handle !== undefined) return
    try {
      handle = ctx.subprocess.spawn({
        argv: [CAFFEINATE, ...flags, '-w', String(process.pid)],
        cwd: here,
        stdio: { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' },
        graceMs: GRACE_MS,
      })
    } catch (error) {
      ctx.logger.warn(`keep-awake: caffeinate start failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const stop = () => {
    if (handle === undefined) return
    const current = handle
    handle = undefined
    current.terminate()
  }

  const note = (agent, status) => {
    if (status === 'running') {
      running.add(agent.id)
      start()
    } else {
      running.delete(agent.id)
      if (running.size === 0) stop()
    }
  }

  // Agents that were already running when this plugin loaded (a live reload
  // mid-session must not release a needed hold).
  for (const agent of ctx.agents.list()) note(agent, agent.status)

  ctx.on('agent/status', ({ agent, status }) => note(agent, status))
  ctx.on('agent/disposed', ({ agent }) => note(agent, 'idle'))
  ctx.effect(() => { stop() }, 'keep-awake.caffeinate()')
}
