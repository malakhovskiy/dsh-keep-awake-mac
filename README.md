# dsh-keep-awake

A macOS plugin for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness)
that keeps the Mac from sleeping while an agent is working — including with the
lid closed (optional, via a one-time `sudoers` setup).

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
- Optional lid-closed override (see [Lid-closed](#lid-closed-clamshell)) runs
  `pmset -c disablesleep 1` through a small guard script with its own deadman.
- macOS only: on other platforms the plugin loads as a no-op.
- No external dependencies — plain Node ESM built on the standard DSH plugin
  surface (`agent/status`, `agent/disposed`, the `subprocess` service) plus
  `caffeinate` and `pmset` from the system.

## Install

```sh
# default: $DSH_HOME (or ~/.dsh), profile "web"
./install.sh

# explicit home and profile
./install.sh /path/to/home desktop
```

The installer copies `keep-awake.mjs` and `sleep-guard.sh` into
`<home>/keep-awake/` and registers the plugin in
`<home>/profiles/<profile>/cordis.patch.yml` as a file-path insert with its
default config:

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
      lid: false   # opt-in: requires the one-time sudoers rule below
```

The installer is idempotent — an existing `keep-awake` entry is left
untouched (edit that block in place to change the settings).

A fresh install needs a DSH restart. On a running instance with the DSH HMR
plugin enabled, later changes to the `config:` block may apply live;
replacing the plugin file itself (an update) needs a restart, since the
current hot-swap reloads the entry in place and may leave the previous
assertion process behind.

## Configuration

Everything is configured in the `config:` block of the patch entry — a
master toggle, one checkbox per `caffeinate` flag, and the lid override.
Omitted values fall back to the defaults shown above (`idle` + `system` on).

| Key              | Effect                                        | Default | Notes                          |
|------------------|-----------------------------------------------|---------|--------------------------------|
| `enabled`        | the plugin is active                          | `true`  | the master toggle              |
| `flags.idle`     | `-i` prevent **idle** system sleep            | `true`  | the core use case              |
| `flags.system`   | `-s` prevent **system** sleep                 | `true`  | AC power only                  |
| `flags.display`  | `-d` prevent display sleep                    | `false` | optional                       |
| `flags.disk`     | `-m` prevent disk idle sleep                  | `false` | optional                       |
| `lid`            | clamshell (lid-closed) override via `pmset`   | `false` | requires the sudoers rule      |

Example (idle + system sleep on AC power — the default):

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

Closing the lid on a MacBook **without an external display** puts the machine
to sleep (macOS "Clamshell Sleep"). This was verified on an M2 Pro MacBook Pro
running macOS 26.6.2 with active `caffeinate -i -s -d` assertions: the
machine still slept (`pmset -g log` shows `Sleep … due to 'Clamshell Sleep'`
while all three assertions were held). **No `caffeinate` flag overrides
lid-close sleep**; with an external display + AC + external input, clamshell
mode works without any of this.

The `lid: true` option closes that gap with the only built-in switch,
`pmset -c disablesleep 1` (AC power only — on battery the machine must still
be allowed to sleep). It is applied while at least one agent runs and reset
immediately when the last agent goes idle:

1. The plugin probes the `sudoers` rule once per session (non-interactive
   `sudo -n pmset -c disablesleep 0`, which is a no-op and also clears stale
   state). Without the rule it logs a warning and keeps working with the
   `caffeinate` flags only.
2. On the first `running` agent it starts `sleep-guard.sh`, which sets
   `disablesleep 1` and then stays alive via `caffeinate -i -w <host-pid>`.
3. When the host exits — cleanly or by crash — the inner `caffeinate -w`
   dies, the script's `EXIT` trap resets `disablesleep 0`, and the override
   can never outlive the harness. (Only gap: a direct `SIGKILL` of the guard
   process; nothing can trap that. Reset manually with
   `sudo pmset -c disablesleep 0` if you ever suspect stale state.)

#### One-time sudoers setup

The guard needs passwordless access to exactly two `pmset` commands. Run
this once (as yourself; it asks for your password once):

```sh
cat > /tmp/dsh-keep-awake.sudoers <<'EOF'
# dsh-keep-awake plugin: passwordless clamshell-sleep override (exact commands only)
Cmnd_Alias DSH_KEEPAWAKE = /usr/bin/pmset -c disablesleep 0, /usr/bin/pmset -c disablesleep 1
YOUR_LOGIN_NAME ALL=(root) NOPASSWD: DSH_KEEPAWAKE
EOF
sudo visudo -cf /tmp/dsh-keep-awake.sudoers \
  && sudo install -m 440 /tmp/dsh-keep-awake.sudoers /etc/sudoers.d/dsh-keep-awake \
  && rm /tmp/dsh-keep-awake.sudoers
sudo -n pmset -c disablesleep 0   # must succeed silently
```

Replace `YOUR_LOGIN_NAME` with your account name. The rule is scoped to the
two exact commands; remove it with `sudo rm /etc/sudoers.d/dsh-keep-awake`.

Caveats: with the lid closed the machine stays fully awake (screen off) and
runs warmer than in sleep — fine for an agent session, not for all day
unattended. `disablesleep` is AC-only here (`-c`), so on battery with the
lid closed the machine still sleeps and the session still drops.

## Verify

While an agent is working:

```sh
pgrep -fl caffeinate
# → <pid> /usr/bin/caffeinate -i -s -w <host-pid>
# → (with lid: true) the sleep-guard and its inner caffeinate -i -w <host-pid>

pmset -g assertions | grep -A2 caffeinate
# → PreventUserIdleSystemSleep / PreventSystemSleep, "on behalf of Process ID <host-pid>"
```

After the last agent goes idle both the assertion processes disappear on
their own and the lid override is reset. The behavioral lid test: on AC
power with an agent running, close the lid for a couple of minutes and open
it — with `lid: true` (and the rule installed) the session survives.

## Uninstall

```sh
# remove the "id: keep-awake" block from <home>/profiles/<profile>/cordis.patch.yml
rm -rf <home>/keep-awake
pkill -f "caffeinate -i"   # only the plugin's own instances, if any are live
sudo rm /etc/sudoers.d/dsh-keep-awake   # if you installed the rule
sudo pmset -c disablesleep 0           # clear any stale override state
```

## Notes

- The toggle and the checkboxes live in the profile patch, not in the
  Settings UI: the current DSH build has no generic per-plugin settings form
  for file-path plugins (each Settings page is a hand-written client
  plugin). The config shape above is the standard DSH plugin-config channel,
  so moving it into a real settings surface is trivial once one exists.
- This is a **file-path plugin**, not an npm package: it is not registered in
  any DSH bundle and ships no schema, which keeps it a pure local opt-in —
  and is also why it does not appear in the DSH *Plugins* manager screen
  (that list shows bundle plugins); it is visible in the read-only plugin
  inventory under Settings. If you want it as a first-class package
  (schema'd config, tests, bundle registration), the `apply()` body carries
  over almost verbatim.
- The plugin assumes `caffeinate` at `/usr/bin/caffeinate` and `pmset` at
  `/usr/bin/pmset` (every macOS).
- Multiple agents (including subagent-driven work) share one assertion and
  one guard: refcounted, so overlapping turns never stack processes.
