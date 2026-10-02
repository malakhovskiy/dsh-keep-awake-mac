#!/bin/sh
# dsh-keep-awake sleep guard.
#
# Holds `pmset <scope> disablesleep 1` for as long as the DSH host process
# (last argument) stays alive. When the host dies the inner `caffeinate -w`
# exits, the script reaches its end and the EXIT trap resets disablesleep=0 —
# so the clamshell override can never outlive the host, even on a hard host
# crash. Only gap: SIGKILL of this process itself (nothing traps that).
#
# usage: sleep-guard.sh <pmset-scope> <host-pid>     e.g. sleep-guard.sh -c 12345
#
# Requires the one-time sudoers rule from the repo README ("Lid-closed");
# without it the first `sudo pmset` fails and this script exits 1.

set -u

scope="${1:--c}"
host_pid="${2:?usage: sleep-guard.sh <pmset-scope> <host-pid>}"

cleanup() {
    # Best effort: never fail the exit path because of the reset.
    sudo -n /usr/bin/pmset "$scope" disablesleep 0 >/dev/null 2>&1 || :
}
trap cleanup EXIT INT TERM

if ! sudo -n /usr/bin/pmset "$scope" disablesleep 1 >/dev/null 2>&1; then
    echo "sleep-guard: cannot run: sudo -n pmset $scope disablesleep 1 — is the sudoers rule installed?" >&2
    exit 1
fi

# Stay alive exactly as long as the host does.
/usr/bin/caffeinate -i -w "$host_pid"
