/**
 * macOS keep-awake: hold a power assertion while any DSH agent is working.
 *
 * Loads as a no-op off macOS. The assertion lives as long as at least one
 * agent reports `running` (the `agent/status` transitions) and is released the
 * moment the last running agent goes idle or is disposed — no timer windows.
 *
 * The caffeinate process is tied to the host PID with `-w`, so it cannot
 * outlive the harness process even if the managed-range teardown is missed.
 *
 * Flags come from `flags.json` next to this file when present (an array of
 * single-letter caffeinate flags, e.g. `["-i", "-s"]`; `-s` adds the
 * AC-power system-sleep assertion for lid-closed work). Missing or invalid
 * file: the idle-sleep-only default `-i`.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'keep-awake'
export const inject = ['agents', 'subprocess']

const here = dirname(fileURLToPath(import.meta.url))
const CAFFEINATE = '/usr/bin/caffeinate'
const GRACE_MS = 3000

function readFlags() {
  const file = join(here, 'flags.json')
  if (!existsSync(file)) return ['-i']
  try {
    const flags = JSON.parse(readFileSync(file, 'utf8'))
    if (Array.isArray(flags) && flags.length > 0 && flags.every((flag) => typeof flag === 'string' && /^-[disum]$/.test(flag))) {
      return flags
    }
  } catch {
    // A malformed flags file falls back to the idle-sleep-only default.
  }
  return ['-i']
}

export function apply(ctx) {
  if (process.platform !== 'darwin' || !existsSync(CAFFEINATE)) return
  const flags = readFlags()
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

  // Agents that were already running when this plugin loaded (live reload
  // mid-session must not release a needed hold).
  for (const agent of ctx.agents.list()) note(agent, agent.status)

  ctx.on('agent/status', ({ agent, status }) => note(agent, status))
  ctx.on('agent/disposed', ({ agent }) => note(agent, 'idle'))
  ctx.effect(() => { stop() }, 'keep-awake.caffeinate()')
}
