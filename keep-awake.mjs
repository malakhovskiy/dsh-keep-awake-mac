/**
 * macOS keep-awake (v3): hold power assertions while any DSH agent is working,
 * plus an optional clamshell (lid-closed) override.
 *
 * Two mechanisms, both refcounted over agent/status:
 *  1. `caffeinate <flags> -w <host-pid>` — power assertions (idle/system/display/
 *     disk sleep). `-w` is the deadman switch: the process dies with the host.
 *  2. `lid: true` — `pmset -c disablesleep 1` while an agent runs (AC power only).
 *     No caffeinate flag overrides clamshell sleep, so this is the only built-in
 *     way to keep working with the lid closed. It requires a one-time sudoers
 *     rule (repo README, "Lid-closed"); without it a warning is logged and the
 *     caffeinate part keeps working.
 *
 * The lid override runs through sleep-guard.sh: the script sets disablesleep=1,
 * then stays alive via `caffeinate -i -w <host-pid>`; an EXIT trap resets
 * disablesleep=0, so the override cannot outlive the host — even on a hard host
 * crash (only gap: SIGKILL of the guard itself).
 *
 * Configuration (profile patch `config:` block; omitted values take defaults):
 *   enabled: true | false    master toggle
 *   flags:  { idle, system, display, disk }   caffeinate -i -s -d -m
 *   lid:    true | false     clamshell override via sudo pmset (default false)
 */
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'keep-awake'
export const inject = ['agents', 'subprocess']

const here = dirname(fileURLToPath(import.meta.url))
const CAFFEINATE = '/usr/bin/caffeinate'
const SUDO = '/usr/bin/sudo'
const PMSET = '/usr/bin/pmset'
const GUARD = join(here, 'sleep-guard.sh')
const GRACE_MS = 3000
const DEFAULTS = {
  enabled: true,
  flags: { idle: true, system: true, display: false, disk: false },
  lid: false,
}
const FLAG_LETTERS = { idle: 'i', system: 's', display: 'd', disk: 'm' }
// AC-only scope: with the lid closed on battery the machine must still be allowed
// to sleep. `disablesleep` via -c affects AC power only.
const PMSET_SCOPE = '-c'

/** Merge the (optional, partial) patch config onto the defaults. */
function resolveConfig (config) {
  const flags = { ...DEFAULTS.flags, ...(config?.flags ?? {}) }
  for (const key of Object.keys(FLAG_LETTERS)) {
    if (typeof flags[key] !== 'boolean') flags[key] = DEFAULTS.flags[key]
  }
  return {
    enabled: config?.enabled ?? DEFAULTS.enabled,
    lid: config?.lid ?? DEFAULTS.lid,
    flags,
  }
}

/**
 * Probe (and normalize) the sudoers rule synchron. `pmset -c disablesleep 0` is a
 * no-op when already 0, so a successful probe also clears stale state left behind
 * by a host that crashed with the override armed. Returns true when the rule
 * exists (sudo -n exits 0), false otherwise.
 */
function probeSudoLid () {
  try {
    execFileSync(SUDO, ['-n', PMSET, PMSET_SCOPE, 'disablesleep', '0'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

export function apply (ctx, config) {
  const resolved = resolveConfig(config)
  if (process.platform !== 'darwin' || !existsSync(CAFFEINATE)) return
  if (!resolved.enabled) return

  const flags = Object.keys(FLAG_LETTERS).filter(key => resolved.flags[key]).map(key => `-${FLAG_LETTERS[key]}`)
  if (flags.length === 0 && !resolved.lid) return
  const lidEnabled = resolved.lid && probeSudoLid()
  if (resolved.lid && !lidEnabled) {
    ctx.logger.warn(
      'keep-awake: lid override not armed: `sudo -n pmset -c disablesleep 0` failed. '
      + 'Install the one-time sudoers rule (repo README, "Lid-closed") to enable it; '
      + 'the caffeinate flags are unaffected.',
    )
  }

  const running = new Set()
  let caffeinate = undefined
  let guard = undefined

  const startCaffeinate = () => {
    if (flags.length === 0 || caffeinate !== undefined) return
    try {
      caffeinate = ctx.subprocess.spawn({
        argv: [CAFFEINATE, ...flags, '-w', String(process.pid)],
        cwd: here,
        stdio: { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' },
        graceMs: GRACE_MS,
      })
      ctx.logger.info(`keep-awake: caffeinate ${flags.join(' ')} started`)
    } catch (error) {
      ctx.logger.warn(`keep-awake: caffeinate start failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const stopCaffeinate = () => {
    if (caffeinate === undefined) return
    const current = caffeinate
    caffeinate = undefined
    current.terminate()
    ctx.logger.info('keep-awake: caffeinate released')
  }

  const startGuard = () => {
    if (!lidEnabled || guard !== undefined) return
    try {
      guard = ctx.subprocess.spawn({
        argv: ['/bin/sh', GUARD, PMSET_SCOPE, String(process.pid)],
        cwd: here,
        stdio: { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' },
        graceMs: GRACE_MS,
      })
      ctx.logger.info('keep-awake: lid override armed (sleep-guard)')
    } catch (error) {
      ctx.logger.warn(`keep-awake: sleep-guard start failed: ${error instanceof Error ? error.message : String(error)}`)
      guard = undefined
    }
  }
  const stopGuard = () => {
    if (guard === undefined) return
    const current = guard
    guard = undefined
    current.terminate()
    ctx.logger.info('keep-awake: lid override released (sleep-guard trap resets pmset)')
  }

  const note = (agent, status) => {
    if (status === 'running') {
      running.add(agent.id)
      startCaffeinate()
      startGuard()
    } else {
      running.delete(agent.id)
      if (running.size === 0) {
        stopCaffeinate()
        stopGuard()
      }
    }
  }

  // Agents that were already running when this plugin loaded (a live reload
  // mid-session must not release a needed hold).
  for (const agent of ctx.agents.list()) note(agent, agent.status)

  ctx.on('agent/status', ({ agent, status }) => note(agent, status))
  ctx.on('agent/disposed', ({ agent }) => note(agent, 'idle'))
  ctx.effect(() => {
    stopCaffeinate()
    stopGuard()
  }, 'keep-awake.teardown()')
}
