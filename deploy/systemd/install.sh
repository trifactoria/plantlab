#!/usr/bin/env bash
# Installs the PlantLab capture service as a user-level systemd unit.
# Run once per machine: ./deploy/systemd/install.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_PATH="$(cd "$SCRIPT_DIR/../.." && pwd)"
TEMPLATE_PATH="$SCRIPT_DIR/plantlab-capture.service.template"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_PATH="$UNIT_DIR/plantlab-capture.service"

PNPM_BIN="$(command -v pnpm || true)"
if [ -z "$PNPM_BIN" ]; then
  echo "error: pnpm was not found on PATH. Install pnpm and re-run this script." >&2
  exit 1
fi

mkdir -p "$UNIT_DIR"

sed \
  -e "s#__REPO_PATH__#$REPO_PATH#g" \
  -e "s#__PNPM_BIN__#$PNPM_BIN#g" \
  "$TEMPLATE_PATH" > "$UNIT_PATH"

echo "Installed unit: $UNIT_PATH"
echo "  repo path: $REPO_PATH"
echo "  pnpm:      $PNPM_BIN"
echo ""
echo "Next steps:"
echo "  systemctl --user daemon-reload"
echo "  systemctl --user enable --now plantlab-capture.service"
echo ""
echo "If this machine has no active login session when the service should run,"
echo "also enable lingering once: loginctl enable-linger \"\$USER\""
echo ""
echo "If the camera device is only accessible to the 'video' group, add yourself"
echo "to it once and log out/in: sudo usermod -aG video \"\$USER\""
