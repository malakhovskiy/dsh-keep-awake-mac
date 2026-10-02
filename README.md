# dsh-keep-awake

A macOS plugin for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness)
that keeps the Mac from sleeping while an agent is working.

## The problem

When the MacBook goes to sleep, the agent stops working: the session freezes
mid-task, open connections are dropped, and the work is lost or has to be
redone after the machine wakes. Long agent runs are fragile every time you
step away from the machine.

This plugin holds a power assertion for exactly the time at least one DSH
agent is running — no timer windows, no manual toggling.

## How it works

- The plugin subscribes to the host's `agent/status` transitions
  (`running` / `idle`) and keeps a refcount of running agents.
- On the first `running` it spawns one long-lived
  `caffeinate <flags> -w <host-pid>`; when the last running agent goes idle
  (or is disposed) it terminates it.
- `-w <host-pid>` is the deadman switch: the assertion is released when the
  DSH host process exits, so the process can never outlive the harness even
  if teardown is missed.
- macOS only: on other platforms the plugin loads as a no-op.
- No external dependencies — plain Node ESM built on the standard DSH plugin
  surface (`agent/status`, `agent/disposed`, the `subprocess` service).

## Install

```sh
# default: $DSH_HOME (or ~/.dsh), profile "web"
./install.sh

# explicit home and profile
./install.sh /path/to/home desktop
```

The installer copies `keep-awake.mjs` into `<home>/keep-awake/` and
registers the plugin in `<home>/profiles/<profile>/cordis.patch.yml` as a
file-path insert with its default config:

```yaml
- insert:
  - id: keep-awake
    name: "/path/to/home/keep-awake/keep-awake.mjs"
    config:
      enabled: true
      flags:
        idle: true
        system: true
        display: false
        disk: false
```

The installer is idempotent — an existing `keep-awake` entry is left
untouched (edit that block in place to change the settings).

A fresh install needs a DSH restart. On a running instance with the DSH HMR
plugin enabled, later changes to the `config:` block apply live; replacing
the plugin file itself (an update) needs a restart, since the current
hot-swap reloads the entry in place and may leave the previous assertion
process behind.

## Configuration

Everything is configured in the `config:` block of the patch entry — a
master toggle plus one checkbox per `caffeinate` flag. Omitted values fall
back to the defaults shown above (`idle` + `system` on).

| Key              | Flag | Assertion                       | Default | Notes                          |
|------------------|------|---------------------------------|---------|--------------------------------|
| `enabled`        | —    | the plugin is active            | `true`  | the master toggle              |
| `flags.idle`     | `-i` | prevent **idle** system sleep   | `true`  | the core use case              |
| `flags.system`   | `-s` | prevent **system** sleep        | `true`  | AC power only; lid-closed flag |
| `flags.display`  | `-d` | prevent display sleep           | `false` | optional                       |
| `flags.disk`     | `-m` | prevent disk idle sleep         | `false` | optional                       |

Example (idle + lid-closed coverage on AC power — the default):

```yaml
    config:
      enabled: true
      flags:
        idle: true
        system: true
```

Turning the plugin off:

```yaml
    config:
      enabled: false
```

### Lid-closed (clamshell)

`caffeinate` alone does not cover every macOS sleep path:

- **With an external display + AC + external input**: closing the lid keeps
  the Mac awake (clamshell mode) regardless of this plugin.
- **Without an external display**: `-s` (AC power only) is the flag that
  claims to prevent lid-close sleep; independent guides are not unanimous —
  some report that no `caffeinate` flag overrides lid-close sleep and
  `sudo pmset -a disablesleep 1` (restored with `0` when done) is needed.
- Test it safely: on AC power, close the lid for a couple of minutes and open
  it again — if the agent's session survived, `-s` covers your machine.

## Verify

While an agent is working:

```sh
pgrep -fl caffeinate
# → <pid> /usr/bin/caffeinate -i -s -w <host-pid>

pmset -g assertions | grep -A2 caffeinate
# → PreventUserIdleSystemSleep / PreventSystemSleep, "on behalf of Process ID <host-pid>"
```

After the last agent goes idle the process disappears on its own.

## Uninstall

```sh
# remove the "id: keep-awake" block from <home>/profiles/<profile>/cordis.patch.yml
rm -rf <home>/keep-awake
pkill -f "caffeinate -i"   # only the plugin's own instance, if one is live
```

## Notes

- The toggle and the flag checkboxes live in the profile patch, not in the
  Settings UI: the current DSH build has no generic per-plugin settings form
  for file-path plugins (each Settings page is a hand-written client
  plugin). The config shape above is the standard DSH plugin-config channel,
  so moving it into a real settings surface is trivial once one exists.
- This is a **file-path plugin**, not an npm package: it is not registered in
  any DSH bundle and ships no schema, which keeps it a pure local opt-in. If
  you want it as a first-class package (Schemastery config, tests, bundle
  registration), the `apply()` body carries over almost verbatim.
- The plugin assumes `caffeinate` at `/usr/bin/caffeinate` (every macOS).
- Multiple agents (including subagent-driven work) share one assertion:
  refcounted, so overlapping turns never stack processes.
