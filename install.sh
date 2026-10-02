#!/usr/bin/env bash
# Install the dsh-keep-awake plugin into a DSH home and register it in one
# profile's cordis.patch.yml. Idempotent: an existing keep-awake entry is
# left untouched (edit it in place to change the toggle or the flags).
#
# Usage: install.sh [DSH_HOME] [PROFILE]
#   DSH_HOME  DSH home directory (default: $DSH_HOME, then ~/.dsh)
#   PROFILE   profile name (default: web)
set -euo pipefail

usage() {
  cat <<USAGE
Usage: install.sh [DSH_HOME] [PROFILE]
  DSH_HOME  DSH home directory (default: \$DSH_HOME or ~/.dsh)
  PROFILE   profile name (default: web)
USAGE
  exit 2
}

[ "$#" -le 2 ] || usage
HOME_DIR="${1:-${DSH_HOME:-$HOME/.dsh}}"
PROFILE="${2:-web}"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
DEST_DIR="$HOME_DIR/keep-awake"
PATCH_FILE="$HOME_DIR/profiles/$PROFILE/cordis.patch.yml"

[ -d "$HOME_DIR" ] || { echo "error: DSH home '$HOME_DIR' does not exist" >&2; exit 1; }

# 1) Copy the plugin files.
mkdir -p "$DEST_DIR"
cp "$SRC_DIR/keep-awake.mjs" "$DEST_DIR/keep-awake.mjs"
cp "$SRC_DIR/sleep-guard.sh" "$DEST_DIR/sleep-guard.sh"
chmod +x "$DEST_DIR/sleep-guard.sh"

# 2) Register the file-path insert (with its default config block) in the
#    profile patch. Idempotent: an existing keep-awake entry is left untouched.
mkdir -p "$(dirname "$PATCH_FILE")"
python3 - "$PATCH_FILE" "$DEST_DIR/keep-awake.mjs" <<'PY'
import sys

patch_file, plugin_path = sys.argv[1], sys.argv[2]
entry = (
    "# Keeps the Mac awake while an agent works (dsh-keep-awake plugin).\n"
    "# Toggle: enabled. Flags: idle=-i, system=-s (AC only), display=-d,\n"
    "# disk=-m. Lid-closed override (optional, needs the one-time sudoers\n"
    "# rule from the README): lid: true\n"
    "- insert:\n"
    "  - id: keep-awake\n"
    f'    name: "{plugin_path}"\n'
    "    config:\n"
    "      enabled: true\n"
    "      flags:\n"
    "        idle: true\n"
    "        system: true\n"
    "        display: false\n"
    "        disk: false\n"
    "      lid: false\n"
)
try:
    with open(patch_file) as f:
        text = f.read()
except FileNotFoundError:
    text = ""
if "id: keep-awake" in text:
    print(f"keep-awake entry already present in {patch_file} - left untouched")
    sys.exit(0)
if text.strip() in ("", "[]"):
    text = entry
else:
    text = text.rstrip() + "\n" + entry
with open(patch_file, "w") as f:
    f.write(text)
print(f"registered in {patch_file}")
PY

echo
echo "Installed: $DEST_DIR/keep-awake.mjs (+ sleep-guard.sh)"
echo "A fresh install needs a DSH restart; later config changes in the profile patch apply live"
echo "(while the DSH HMR plugin is enabled). Verify while an agent works: pgrep -fl caffeinate"
echo "Optional: install the one-time sudoers rule (README, 'Lid-closed') and set 'lid: true'"
echo "to keep the Mac awake with the lid closed while an agent runs."
