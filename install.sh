#!/usr/bin/env bash
# Install the dsh-keep-awake plugin into a DSH home and register it in one
# profile's cordis.patch.yml. Idempotent: never overwrites a personal
# flags.json, never duplicates the patch entry.
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

# 1) Copy the plugin (flags.json only if absent — never clobber personal config).
mkdir -p "$DEST_DIR"
cp "$SRC_DIR/keep-awake.mjs" "$DEST_DIR/keep-awake.mjs"
if [ ! -f "$DEST_DIR/flags.json" ]; then
  cp "$SRC_DIR/flags.json.example" "$DEST_DIR/flags.json"
fi

# 2) Register the file-path insert in the profile patch (idempotent).
mkdir -p "$(dirname "$PATCH_FILE")"
python3 - "$PATCH_FILE" "$DEST_DIR/keep-awake.mjs" <<'PY'
import sys

patch_file, plugin_path = sys.argv[1], sys.argv[2]
entry = (
    "# Keeps the Mac awake while an agent works (dsh-keep-awake plugin).\n"
    "- insert:\n"
    "  - id: keep-awake\n"
    f'    name: "{plugin_path}"\n'
)
try:
    with open(patch_file) as f:
        text = f.read()
except FileNotFoundError:
    text = ""
if "id: keep-awake" in text:
    print(f"already registered in {patch_file}")
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
echo "Installed: $DEST_DIR/keep-awake.mjs"
echo "If a DSH instance with the HMR plugin is running, the profile-patch watcher picks this up live;"
echo "otherwise restart DSH. Verify while an agent works: pgrep -fl caffeinate"
