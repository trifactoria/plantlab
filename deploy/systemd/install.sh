#!/usr/bin/env bash
# Installs the PlantLab web and camera/scheduler services as user-level
# systemd units. Run once per machine: ./deploy/systemd/install.sh
#
# This only writes unit files - it does not enable, start, build, or
# install dependencies. See DEPLOYMENT.md for the full sequence.
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
  local unit_path="$UNIT_DIR/${name}.service"

  sed \
    -e "s#__REPO_PATH__#$REPO_PATH#g" \
    -e "s#__RUN_BIN__#$RUN_BIN#g" \
    "$template_path" > "$unit_path"

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
