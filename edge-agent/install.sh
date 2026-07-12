#!/bin/sh
# PlantLab Edge Agent installer - for low-resource devices (Raspberry Pi
# Zero and similar) that the coordinator's Pi Zero feasibility check
# recommends the lightweight agent for (see remoteNode.ts
# computeFullAgentSupport()). Deliberately shell + Python stdlib only - no
# Node.js, no pnpm, no repository build.
#
# Normal flow (see Part 11):
#   ./install.sh                        (run locally on the device)
#   plantlab node attach greenhouse-zero  (run from the coordinator - copies
#                                          this directory over SSH, then
#                                          runs this script remotely, then
#                                          registers the node and installs a
#                                          credential automatically)
#
# This script never creates a node credential itself - credentials are
# always coordinator-issued (see src/lib/operations/nodeCredentials.ts).
# Running ./install.sh alone gets everything else ready (config, spool,
# service) and prints the exact next command to run from the coordinator.
set -eu

INSTALL_DIR="${PLANTLAB_EDGE_INSTALL_DIR:-$HOME/.local/share/plantlab-edge-agent}"
CONFIG_DIR="$HOME/.config/plantlab"
SPOOL_ROOT="${PLANTLAB_EDGE_SPOOL_ROOT:-$HOME/.local/state/plantlab-edge-agent}"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

echo "PlantLab Edge Agent installer"
echo "=============================="

command -v python3 >/dev/null 2>&1 || {
  echo "FATAL: python3 is required but was not found. Raspberry Pi OS Lite ships python3 by default - check your image." >&2
  exit 1
}
PYTHON_BIN="$(command -v python3)"
echo "PASS: python3 found at $PYTHON_BIN ($($PYTHON_BIN --version 2>&1))"

if command -v ffmpeg >/dev/null 2>&1; then
  echo "PASS: ffmpeg is available."
else
  echo "FATAL: ffmpeg is required for camera capture and was not found." >&2
  echo "  Install it with: sudo apt-get update && sudo apt-get install -y ffmpeg" >&2
  exit 1
fi

if command -v v4l2-ctl >/dev/null 2>&1; then
  echo "PASS: v4l2-ctl is available."
else
  echo "WARN: v4l2-ctl is missing - camera inventory will be limited to bare device paths."
  echo "  Install it with: sudo apt-get install -y v4l-utils"
fi

echo ""
echo "Installing to $INSTALL_DIR ..."
mkdir -p "$INSTALL_DIR"
cp -r "$SCRIPT_DIR/plantlab_edge_agent" "$INSTALL_DIR/"
echo "PASS: package copied."

mkdir -p "$CONFIG_DIR"
chmod 700 "$CONFIG_DIR"
mkdir -p "$SPOOL_ROOT/spool/pending" "$SPOOL_ROOT/spool/uploading" "$SPOOL_ROOT/spool/acknowledged" "$SPOOL_ROOT/spool/failed" "$SPOOL_ROOT/logs"
echo "PASS: spool directories prepared at $SPOOL_ROOT."

# edge-agent.json is written here only if it doesn't already exist -
# `plantlab node attach` (via roleConvergence-equivalent remote writes) may
# overwrite it later with coordinator-known values; this is just a
# reasonable local default so `install-check`/`inventory` work standalone
# even before the node is attached.
CONFIG_PATH="$CONFIG_DIR/edge-agent.json"
if [ ! -f "$CONFIG_PATH" ]; then
  role="${PLANTLAB_EDGE_ROLE:-greenhouse-node}"
  node_name="${PLANTLAB_EDGE_NODE_NAME:-$(hostname)}"
  coordinator_url="${PLANTLAB_EDGE_COORDINATOR_URL:-}"
  config_tmp="$(mktemp "$CONFIG_DIR/edge-agent.json.tmp.XXXXXX")"
  cat > "$config_tmp" <<EOF
{
  "role": "$role",
  "nodeName": "$node_name",
  "coordinatorUrl": "$coordinator_url",
  "spoolRoot": "$SPOOL_ROOT",
  "capabilities": ["camera"],
  "heartbeatIntervalSeconds": 30,
  "pollIntervalSeconds": 5,
  "maxSpoolBytes": 536870912,
  "maxUploadBytes": 8388608
}
EOF
  mv "$config_tmp" "$CONFIG_PATH"
  echo "PASS: wrote default configuration to $CONFIG_PATH (role=$role)."
else
  echo "PASS: configuration already exists at $CONFIG_PATH - left untouched."
fi

echo ""
echo "Installing systemd --user unit ..."
UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$UNIT_DIR"
UNIT_TMP="$(mktemp "$UNIT_DIR/plantlab-edge-agent.service.tmp.XXXXXX")"
sed "s|__PYTHON_BIN__|$PYTHON_BIN|g" "$SCRIPT_DIR/systemd/plantlab-edge-agent.service.template" > "$UNIT_TMP"
# Same mktemp+mv pattern as the TS agent's systemdUnits.ts - never write
# through an existing mask symlink with a plain redirect.
mv "$UNIT_TMP" "$UNIT_DIR/plantlab-edge-agent.service"
# Point systemd's WorkingDirectory-free invocation at the installed package
# by adding it to PYTHONPATH via a drop-in, since `python3 -m
# plantlab_edge_agent` needs the package importable.
mkdir -p "$UNIT_DIR/plantlab-edge-agent.service.d"
cat > "$UNIT_DIR/plantlab-edge-agent.service.d/pythonpath.conf" <<EOF
[Service]
Environment=PYTHONPATH=$INSTALL_DIR
EOF
echo "PASS: unit installed."

# Raspberry Pi OS Lite is normally headless with no persistent login
# session, so a --user systemd unit needs linger enabled or it will stop
# the moment the SSH session that installed it disconnects - a real,
# well-known gotcha for exactly this device class (Part 11: "user or system
# service appropriate to Raspberry Pi OS Lite").
if command -v loginctl >/dev/null 2>&1; then
  if loginctl enable-linger "$(whoami)" 2>/dev/null; then
    echo "PASS: linger enabled for $(whoami) - the agent will keep running without an active login session."
  else
    echo "WARN: could not enable linger automatically. Run manually: sudo loginctl enable-linger $(whoami)"
  fi
else
  echo "WARN: loginctl not found - if this service stops when you log out, install systemd or use a system-level unit instead."
fi

systemctl --user daemon-reload 2>/dev/null || echo "WARN: systemctl --user daemon-reload failed - is a user systemd session available? Try: loginctl enable-linger \$(whoami) then log back in."

echo ""
PYTHONPATH="$INSTALL_DIR" "$PYTHON_BIN" -m plantlab_edge_agent install-check || true

echo ""
if [ -f "$CONFIG_DIR/agent.env" ]; then
  echo "A credential already exists - starting the agent now."
  systemctl --user enable --now plantlab-edge-agent.service 2>/dev/null || echo "WARN: could not start the service automatically - start it with: systemctl --user start plantlab-edge-agent.service"
else
  echo "No node credential yet - this is expected for a fresh install."
  echo "From the coordinator, run:"
  echo ""
  echo "    plantlab node attach $(hostname)"
  echo ""
  echo "This registers the node, issues a credential automatically, installs"
  echo "it here, and starts the agent - no manual token handling required."
fi
