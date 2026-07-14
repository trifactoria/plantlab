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
USER_BIN_DIR="${PLANTLAB_EDGE_USER_BIN_DIR:-$HOME/.local/bin}"
VENV_DIR="$INSTALL_DIR/.venv"
WHEELHOUSE_DIR="$INSTALL_DIR/wheelhouse"
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
mkdir -p "$WHEELHOUSE_DIR"

base_python="${PLANTLAB_EDGE_BASE_PYTHON:-/usr/bin/python3}"
if [ ! -x "$base_python" ]; then
  base_python="$PYTHON_BIN"
fi

venv_valid=false
if [ -x "$VENV_DIR/bin/python" ] && [ -f "$VENV_DIR/pyvenv.cfg" ] && grep -qi '^include-system-site-packages *= *true' "$VENV_DIR/pyvenv.cfg" 2>/dev/null; then
  if "$VENV_DIR/bin/python" - <<'PY' >/dev/null 2>&1
import platform, sys
raise SystemExit(0 if sys.prefix != sys.base_prefix and platform.machine() else 1)
PY
  then
    venv_valid=true
  fi
fi

if [ "$venv_valid" = false ]; then
  echo "Preparing dedicated edge-agent venv at $VENV_DIR ..."
  rm -rf "$VENV_DIR"
  if command -v uv >/dev/null 2>&1; then
    uv venv --python "$base_python" --system-site-packages "$VENV_DIR"
  else
    "$base_python" -m venv --system-site-packages "$VENV_DIR"
  fi
else
  echo "PASS: reusing healthy edge-agent venv at $VENV_DIR."
fi
EDGE_PYTHON="$VENV_DIR/bin/python"
if [ ! -x "$EDGE_PYTHON" ]; then
  echo "FATAL: edge-agent venv interpreter was not created at $EDGE_PYTHON" >&2
  exit 1
fi
if ! grep -qi '^include-system-site-packages *= *true' "$VENV_DIR/pyvenv.cfg" 2>/dev/null; then
  echo "FATAL: edge-agent venv is missing system site packages; pigpio must remain importable from the OS package." >&2
  exit 1
fi
echo "PASS: edge Python is $EDGE_PYTHON ($($EDGE_PYTHON --version 2>&1))."
if "$EDGE_PYTHON" - <<'PY' >/dev/null 2>&1
import pigpio
PY
then
  echo "PASS: pigpio imports through the edge venv."
else
  echo "WARN: pigpio does not import through the edge venv. DHT22 support will remain unavailable until python3-pigpio/pigpiod are installed."
fi
PACKAGE_SOURCE="$SCRIPT_DIR/plantlab_edge_agent"
PACKAGE_TARGET="$INSTALL_DIR/plantlab_edge_agent"
PACKAGE_TMP="$INSTALL_DIR/plantlab_edge_agent.tmp.$$"
SOURCE_COMMIT="${PLANTLAB_EDGE_SOURCE_COMMIT:-unknown}"

package_hash() {
  "$PYTHON_BIN" - "$1" <<'PY'
import hashlib
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
digest = hashlib.sha256()
for path in sorted(root.rglob("*")):
    if not path.is_file():
        continue
    rel = path.relative_to(root).as_posix()
    if "__pycache__" in path.parts or rel.endswith(".pyc") or rel == "_install_meta.py":
        continue
    digest.update(rel.encode("utf-8"))
    digest.update(b"\0")
    digest.update(path.read_bytes())
    digest.update(b"\0")
print(digest.hexdigest())
PY
}

SOURCE_HASH="$(package_hash "$PACKAGE_SOURCE")"
if [ -n "${PLANTLAB_EDGE_SOURCE_HASH:-}" ] && [ "$SOURCE_HASH" != "$PLANTLAB_EDGE_SOURCE_HASH" ]; then
  echo "FATAL: source package hash changed before install: expected $PLANTLAB_EDGE_SOURCE_HASH, found $SOURCE_HASH" >&2
  exit 1
fi

# Reinstall must be an exact mirror of this package. Remove only the
# installed Python package directory; config, credential, spool, and logs
# live outside this package path and are deliberately preserved.
rm -rf "$PACKAGE_TARGET" "$PACKAGE_TMP"
cp -R "$PACKAGE_SOURCE" "$PACKAGE_TMP"
find "$PACKAGE_TMP" -type d -name __pycache__ -prune -exec rm -rf {} +
cat > "$PACKAGE_TMP/_install_meta.py" <<EOF
SOURCE_COMMIT = "$SOURCE_COMMIT"
SOURCE_HASH = "$SOURCE_HASH"
EOF
STAGED_HASH="$(package_hash "$PACKAGE_TMP")"
if [ "$STAGED_HASH" != "$SOURCE_HASH" ]; then
  echo "FATAL: staged package hash differs from source: source=$SOURCE_HASH staged=$STAGED_HASH" >&2
  rm -rf "$PACKAGE_TMP"
  exit 1
fi
mv "$PACKAGE_TMP" "$PACKAGE_TARGET"
find "$PACKAGE_TARGET" -type d -name __pycache__ -prune -exec rm -rf {} +
INSTALLED_HASH="$(package_hash "$PACKAGE_TARGET")"
if [ "$INSTALLED_HASH" != "$SOURCE_HASH" ]; then
  echo "FATAL: installed package hash differs from source: source=$SOURCE_HASH installed=$INSTALLED_HASH" >&2
  exit 1
fi
echo "PASS: package mirrored exactly (hash $INSTALLED_HASH)."

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
echo "Installing local command ..."
mkdir -p "$USER_BIN_DIR"
WRAPPER_TMP="$(mktemp "$USER_BIN_DIR/plantlab-edge.tmp.XXXXXX")"
cat > "$WRAPPER_TMP" <<EOF
#!/bin/sh
PYTHONPATH="$INSTALL_DIR" PLANTLAB_EDGE_CONFIG_DIR="$CONFIG_DIR" exec "$EDGE_PYTHON" -m plantlab_edge_agent "\$@"
EOF
mv "$WRAPPER_TMP" "$USER_BIN_DIR/plantlab-edge"
chmod 755 "$USER_BIN_DIR/plantlab-edge"
echo "PASS: plantlab-edge installed at $USER_BIN_DIR/plantlab-edge."

# Best-effort: /usr/local/bin is on PATH for every session type (login,
# non-login, interactive, non-interactive - e.g. a plain `ssh host cmd`)
# with zero shell-startup-file dependency. Only used when already writable
# by this user - never via sudo, never assumed.
if [ -w /usr/local/bin ] 2>/dev/null; then
  ln -sf "$USER_BIN_DIR/plantlab-edge" /usr/local/bin/plantlab-edge 2>/dev/null \
    && echo "PASS: also linked from /usr/local/bin/plantlab-edge (writable without sudo)."
fi

# Idempotently ensure $HOME/.local/bin is on the *login* PATH (Part 3) -
# the real greenhouse-zero bug: the wrapper above was created, but
# ~/.local/bin was never on PATH for a plain `ssh host plantlab-edge ...`
# (a non-interactive, non-login shell - bash reads neither ~/.profile nor
# ~/.bashrc for that invocation style; only a real login shell does).
# Never silently edits an "arbitrary" file - only the two standard,
# well-known Debian/Raspberry Pi OS shell startup files
# (~/.profile for login shells, ~/.bashrc for interactive non-login
# shells), each touched at most once (a unique marker comment makes this
# safe to re-run).
PLANTLAB_PATH_MARKER="# Added by the PlantLab edge-agent installer - see edge-agent/install.sh"
ensure_local_bin_on_path() {
  target_file="$1"
  if [ -f "$target_file" ] && grep -qF "$PLANTLAB_PATH_MARKER" "$target_file" 2>/dev/null; then
    return 0
  fi
  {
    echo ""
    echo "$PLANTLAB_PATH_MARKER"
    echo 'if [ -d "$HOME/.local/bin" ] && ! case ":$PATH:" in *":$HOME/.local/bin:"*) true ;; *) false ;; esac; then'
    echo '  PATH="$HOME/.local/bin:$PATH"'
    echo '  export PATH'
    echo 'fi'
  } >> "$target_file"
}
ensure_local_bin_on_path "$HOME/.profile"
ensure_local_bin_on_path "$HOME/.bashrc"
echo "PASS: ensured \$HOME/.local/bin is on PATH in \$HOME/.profile and \$HOME/.bashrc (idempotent - safe to re-run)."

# Verify through a fresh, non-interactive LOGIN shell - never assumes the
# freshly-appended PATH line took effect, actually re-execs a real login
# shell (bash -l) to prove `command -v plantlab-edge` resolves, exactly
# the way Part 3 requires this to be checked.
if command -v bash >/dev/null 2>&1 && VERIFIED_PATH="$(bash -lc 'command -v plantlab-edge' 2>/dev/null)" && [ -n "$VERIFIED_PATH" ]; then
  echo "PASS: plantlab-edge resolves on PATH in a fresh login shell: $VERIFIED_PATH"
else
  echo ""
  echo "Installed successfully."
  echo "Reconnect your SSH session, or run:"
  echo "  $USER_BIN_DIR/plantlab-edge doctor"
fi

echo ""
echo "Installing systemd --user unit ..."
UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$UNIT_DIR"
UNIT_TMP="$(mktemp "$UNIT_DIR/plantlab-edge-agent.service.tmp.XXXXXX")"
sed "s|__PYTHON_BIN__|$EDGE_PYTHON|g" "$SCRIPT_DIR/systemd/plantlab-edge-agent.service.template" > "$UNIT_TMP"
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
Environment=PLANTLAB_EDGE_CONFIG_DIR=$CONFIG_DIR
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
PYTHONPATH="$INSTALL_DIR" "$EDGE_PYTHON" -m plantlab_edge_agent version
PYTHONPATH="$INSTALL_DIR" "$EDGE_PYTHON" -m plantlab_edge_agent install-check || true

echo ""
echo "Edge agent installed."
echo ""
echo "Local diagnostics:"
echo "  plantlab-edge doctor"
echo "  plantlab-edge status"
echo ""
echo "Finish enrollment from the coordinator:"
echo "  plantlab node attach $(hostname)"
echo ""
if [ -f "$CONFIG_DIR/agent.env" ]; then
  echo "A credential already exists - starting the agent now."
  systemctl --user enable --now plantlab-edge-agent.service 2>/dev/null || echo "WARN: could not start the service automatically - start it with: systemctl --user start plantlab-edge-agent.service"
else
  echo "No node credential yet - this is expected for a fresh install."
  echo "Coordinator attachment registers the node, issues a credential automatically, installs it here, and starts the agent - no manual token handling required."
fi
