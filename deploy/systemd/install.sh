#!/usr/bin/env bash
# Low-level unit-file generation only - installs the PlantLab web,
# camera/scheduler, and agent user-level systemd unit files.
#
# `plantlab install` / `plantlab update` (which use the shared
# convergeNodeRole() operation - see src/lib/operations/roleConvergence.ts)
# are the CANONICAL way to set up or repair a machine now: they also
# select the right units for the configured role, detect and clear a
# stale mask, write plantlab.config.json, and start/stop the right
# services. This script is kept only as a manual/advanced fallback for
# regenerating bare unit files without going through role convergence -
# see DEPLOYMENT.md "Canonical deployment paths".
#
# This only writes unit files - it does not enable, start, build, or
# install dependencies.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_PATH="$(cd "$SCRIPT_DIR/../.." && pwd)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

RUN_BIN="$(command -v npm || command -v pnpm || true)"
if [ -z "$RUN_BIN" ]; then
  echo "error: neither npm nor pnpm was found on PATH. Install one and re-run this script." >&2
  exit 1
fi

mkdir -p "$UNIT_DIR"

install_unit() {
  local name="$1"
  local template_path="$SCRIPT_DIR/${name}.service.template"
  local unit_name="${name}.service"
  local unit_path="$UNIT_DIR/${unit_name}"

  # If this unit is currently masked (a `-> /dev/null` symlink), plain
  # shell redirection (`sed ... > "$unit_path"`) would silently write
  # THROUGH that symlink to /dev/null and leave the mask in place forever -
  # see DEPLOYMENT.md "Systemd mask recovery" for how this was discovered.
  # Detect and clear it first, then always write via a temp file + `mv`
  # (which replaces the directory entry itself rather than following a
  # symlink), never via `>` directly.
  if systemctl --user is-enabled "$unit_name" 2>/dev/null | grep -q '^masked'; then
    echo "Unmasking previously-masked unit: $unit_name"
    systemctl --user unmask "$unit_name" 2>/dev/null || true
  fi

  local unit_tmp
  unit_tmp="$(mktemp "$UNIT_DIR/${unit_name}.tmp.XXXXXX")"
  sed \
    -e "s#__REPO_PATH__#$REPO_PATH#g" \
    -e "s#__RUN_BIN__#$RUN_BIN#g" \
    "$template_path" > "$unit_tmp"
  mv "$unit_tmp" "$unit_path"

  echo "Installed unit: $unit_path"
}

install_unit "plantlab-web"
install_unit "plantlab-camera"
install_unit "plantlab-agent"

echo ""
echo "  repo path: $REPO_PATH"
echo "  npm/pnpm:  $RUN_BIN"
echo ""
echo "Next steps (see DEPLOYMENT.md for the full sequence, including build):"
echo "  systemctl --user daemon-reload"
echo "  systemctl --user enable --now plantlab-web.service plantlab-camera.service"
echo "  # camera nodes only:"
echo "  systemctl --user enable --now plantlab-agent.service"
echo ""
echo "If this machine has no active login session when the services should run,"
echo "also enable lingering once: loginctl enable-linger \"\$USER\""
echo ""
echo "If the camera device is only accessible to the 'video' group, add yourself"
echo "to it once and log out/in: sudo usermod -aG video \"\$USER\""
echo ""
echo "Run \"plantlab doctor\" before enabling either service to catch"
echo "configuration problems early."
