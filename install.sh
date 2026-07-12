#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="${PLANTLAB_INSTALL_BIN_DIR:-/usr/local/bin}"
VERBOSE=0
YES=0
SKIP_SYSTEMD=0
NO_BUILD=0
NO_DB_SETUP=0
ROLE=""
COORDINATOR_URL=""

usage() {
  cat <<'USAGE'
PlantLab installer

Usage:
  ./install.sh [options]

Options:
  --verbose                 Show command output while installing
  --yes                     Accept installer prompts when safe
  --role <role>             Pass a role to "plantlab install" (standalone, coordinator, camera-node)
  --coordinator-url <url>   Coordinator URL for camera-node installs
  --skip-systemd            Do not generate systemd user units
  --bin-dir <dir>           Install the plantlab command here (default: /usr/local/bin)
  --no-build                Skip the production build step
  --no-db-setup             Do not create a new SQLite schema for a missing database
  -h, --help                Show this help

The normal path is:
  git clone https://github.com/trifactoria/plantlab.git
  cd plantlab
  ./install.sh
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --verbose) VERBOSE=1; shift ;;
    --yes) YES=1; shift ;;
    --role) ROLE="${2:-}"; shift 2 ;;
    --coordinator-url) COORDINATOR_URL="${2:-}"; shift 2 ;;
    --skip-systemd) SKIP_SYSTEMD=1; shift ;;
    --bin-dir) BIN_DIR="${2:-}"; shift 2 ;;
    --no-build) NO_BUILD=1; shift ;;
    --no-db-setup) NO_DB_SETUP=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

LOG_FILE="$(mktemp -t plantlab-install.XXXXXX.log)"
trap 'rm -f "$LOG_FILE"' EXIT

step() {
  printf '\n%s\n' "$1"
}

ok() {
  printf '✓ %s\n' "$1"
}

warn() {
  printf '! %s\n' "$1"
}

fail() {
  printf 'Installation failed: %s\n' "$1" >&2
  printf 'Log: %s\n' "$LOG_FILE" >&2
  exit 1
}

run_quiet() {
  local label="$1"
  shift
  if [[ "$VERBOSE" -eq 1 ]]; then
    "$@" || fail "$label"
  else
    if ! "$@" >"$LOG_FILE" 2>&1; then
      printf '\n%s failed. Recent output:\n' "$label" >&2
      tail -n 40 "$LOG_FILE" >&2 || true
      fail "$label"
    fi
  fi
}

confirm() {
  local prompt="$1"
  if [[ "$YES" -eq 1 ]]; then
    return 0
  fi
  if [[ ! -t 0 ]]; then
    return 1
  fi
  local answer
  read -r -p "$prompt [y/N] " answer
  [[ "$answer" == "y" || "$answer" == "Y" || "$answer" == "yes" || "$answer" == "YES" ]]
}

version_major() {
  printf '%s' "$1" | sed -E 's/^v?([0-9]+).*/\1/'
}

ensure_node() {
  if ! command -v node >/dev/null 2>&1; then
    fail "Node.js was not found. Install Node.js 22 or newer, then re-run ./install.sh."
  fi

  local version major
  version="$(node --version)"
  major="$(version_major "$version")"
  if [[ "$major" -lt 22 ]]; then
    fail "Node.js $version is installed, but PlantLab requires Node.js 22 or newer."
  fi
  ok "Node.js detected ($version)"
}

ensure_pnpm() {
  if command -v pnpm >/dev/null 2>&1; then
    ok "pnpm detected ($(pnpm --version))"
    return
  fi

  if command -v corepack >/dev/null 2>&1; then
    step "pnpm was not found. Enabling pnpm with Corepack..."
    run_quiet "corepack enable" corepack enable
    run_quiet "corepack prepare pnpm" corepack prepare pnpm@latest --activate
  fi

  if ! command -v pnpm >/dev/null 2>&1; then
    fail "pnpm was not found and Corepack could not activate it. Install pnpm, then re-run ./install.sh."
  fi
  ok "pnpm detected ($(pnpm --version))"
}

ensure_env_file() {
  if [[ -f "$REPO_ROOT/.env" ]]; then
    ok "Environment file already exists"
    return
  fi
  if [[ -f "$REPO_ROOT/.env.example" ]]; then
    cp "$REPO_ROOT/.env.example" "$REPO_ROOT/.env"
  else
    printf 'DATABASE_URL="file:./dev.db"\n' > "$REPO_ROOT/.env"
  fi
  ok "Environment file created"
}

database_path() {
  node <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const envPath = path.join(process.cwd(), ".env");
const raw = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
const match = raw.match(/^DATABASE_URL=(.+)$/m);
const value = (match ? match[1].trim() : "file:./dev.db").replace(/^"|"$/g, "");
if (!value.startsWith("file:")) process.exit(0);
const sqlitePath = value.slice("file:".length).replace(/^"|"$/g, "");
console.log(path.isAbsolute(sqlitePath) ? sqlitePath : path.resolve(process.cwd(), "prisma", sqlitePath));
NODE
}

ensure_database_schema() {
  if [[ "$NO_DB_SETUP" -eq 1 ]]; then
    warn "Database setup skipped"
    return
  fi

  local db_path
  db_path="$(cd "$REPO_ROOT" && database_path)"
  if [[ -z "$db_path" ]]; then
    warn "DATABASE_URL is not a local SQLite file; schema setup skipped"
    return
  fi

  if [[ -f "$db_path" ]]; then
    # Left untouched here on purpose - `plantlab install` (run below via
    # run_plantlab_install) applies any pending/legacy migrations itself,
    # with a backup first, for roles that use the canonical domain
    # database. See DEPLOYMENT.md "Database migration policy".
    ok "Existing database detected; schema changes left untouched (plantlab install will migrate it if needed)"
    return
  fi

  # A brand-new database uses `prisma migrate deploy`, never `db push` -
  # this is what gives it real migration history (_prisma_migrations) from
  # day one, so it never needs the legacy-baselining recovery path this
  # task added (see migrations.ts) for any *future* update.
  step "Preparing local SQLite database..."
  run_quiet "database setup" bash -lc "cd '$REPO_ROOT' && pnpm db:migrate"
  ok "Database schema prepared"
}

needs_build() {
  if [[ "$NO_BUILD" -eq 1 ]]; then
    return 1
  fi
  if [[ ! -f "$REPO_ROOT/.next/BUILD_ID" ]]; then
    return 0
  fi
  if find "$REPO_ROOT/src" "$REPO_ROOT/prisma" "$REPO_ROOT/package.json" "$REPO_ROOT/next.config.ts" "$REPO_ROOT/tsconfig.json" -newer "$REPO_ROOT/.next/BUILD_ID" 2>/dev/null | grep -q .; then
    return 0
  fi
  return 1
}

install_cli() {
  local source target existing_real source_real
  source="$REPO_ROOT/bin/plantlab"
  target="$BIN_DIR/plantlab"
  source_real="$(realpath "$source")"

  chmod +x "$source"
  ok "CLI launcher is executable"

  if [[ -e "$target" || -L "$target" ]]; then
    existing_real="$(realpath "$target" 2>/dev/null || true)"
    if [[ "$existing_real" == "$source_real" ]]; then
      ok "plantlab command already points to this checkout"
      return
    fi
    printf 'Existing plantlab command: %s\n' "$target"
    printf 'Current target: %s\n' "${existing_real:-unknown}"
    if ! confirm "Update it to this checkout?"; then
      fail "CLI installation was not updated."
    fi
  fi

  if [[ ! -d "$BIN_DIR" ]]; then
    if [[ -w "$(dirname "$BIN_DIR")" ]]; then
      mkdir -p "$BIN_DIR"
    else
      sudo mkdir -p "$BIN_DIR"
    fi
  fi

  if [[ -w "$BIN_DIR" ]]; then
    ln -sfn "$source" "$target"
  else
    sudo ln -sfn "$source" "$target"
  fi
  ok "plantlab command installed at $target"
}

run_plantlab_install() {
  local cli args
  cli="$BIN_DIR/plantlab"
  if [[ ! -x "$cli" ]]; then
    cli="$REPO_ROOT/bin/plantlab"
  fi

  args=(install)
  [[ -n "$ROLE" ]] && args+=(--role "$ROLE")
  [[ -n "$COORDINATOR_URL" ]] && args+=(--coordinator-url "$COORDINATOR_URL")
  [[ "$SKIP_SYSTEMD" -eq 1 ]] && args+=(--skip-systemd)

  step "Configuring PlantLab..."
  "$cli" "${args[@]}"
  ok "PlantLab configured"
}

print_summary() {
  local cli doctor_output role coordinator version fail_count warn_count
  cli="$BIN_DIR/plantlab"
  if [[ ! -x "$cli" ]]; then
    cli="$REPO_ROOT/bin/plantlab"
  fi

  step "Running diagnostics..."
  doctor_output="$("$cli" doctor 2>&1 || true)"
  printf '%s\n' "$doctor_output"

  version="$("$cli" version | awk '{print $2}')"
  role="$(node -e "const fs=require('fs');try{const c=JSON.parse(fs.readFileSync('$REPO_ROOT/plantlab.config.json','utf8'));console.log(c.role||'not configured')}catch{console.log('not configured')}")"
  coordinator="$(node -e "const fs=require('fs');try{const c=JSON.parse(fs.readFileSync('$REPO_ROOT/plantlab.config.json','utf8'));console.log(c.coordinatorUrl||'not configured')}catch{console.log('not configured')}")"
  fail_count="$(printf '%s\n' "$doctor_output" | sed -nE 's/.* ([0-9]+) failed\.$/\1/p' | tail -n1)"
  warn_count="$(printf '%s\n' "$doctor_output" | sed -nE 's/.* ([0-9]+) warned, [0-9]+ failed\.$/\1/p' | tail -n1)"
  fail_count="${fail_count:-0}"
  warn_count="${warn_count:-0}"

  printf '\nInstallation complete.\n\n'
  printf 'PlantLab Version:\n%s\n\n' "$version"
  printf 'Role:\n%s\n\n' "$role"
  printf 'Coordinator:\n%s\n\n' "$coordinator"
  printf 'Overall Health:\n'
  if [[ "$fail_count" -gt 0 ]]; then
    printf '! Needs attention (%s failed checks)\n\n' "$fail_count"
  elif [[ "$warn_count" -gt 0 ]]; then
    printf '! Usable with warnings (%s warnings)\n\n' "$warn_count"
    printf 'Warnings usually mean optional setup is incomplete, such as no backups yet, no camera test capture, or services not started.\n'
    printf 'Read the warning lines above; each one includes the next action.\n\n'
  else
    printf '✓ Healthy\n\n'
  fi

  cat <<'NEXT'
Next Steps

View all commands:
plantlab --help

List cameras:
plantlab camera list

Inspect this machine:
plantlab doctor

Inspect another node:
plantlab node inspect xps

View backups:
plantlab backup list

Read documentation:
README.md
NEXT
}

cd "$REPO_ROOT"

cat <<'WELCOME'
Welcome to PlantLab.

This installer will prepare the application, install the plantlab command,
and then hand off to "plantlab install" for role configuration.
WELCOME

if [[ -f /etc/os-release ]]; then
  . /etc/os-release
  printf '\nDetected:\n%s\nHostname: %s\n' "${PRETTY_NAME:-Linux}" "$(hostname)"
fi

step "Checking requirements..."
ensure_node
ensure_pnpm
ensure_env_file

step "Installing project dependencies..."
run_quiet "dependency installation" bash -lc "cd '$REPO_ROOT' && pnpm install --frozen-lockfile"
ok "Dependencies installed"

step "Preparing Prisma client..."
run_quiet "Prisma client generation" bash -lc "cd '$REPO_ROOT' && pnpm db:generate"
ok "Prisma client ready"
ensure_database_schema

if needs_build; then
  step "Building PlantLab..."
  run_quiet "production build" bash -lc "cd '$REPO_ROOT' && pnpm build"
  ok "Project built"
else
  ok "Existing build is current"
fi

step "Installing CLI..."
install_cli

run_plantlab_install
print_summary
