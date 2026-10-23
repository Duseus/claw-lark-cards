#!/usr/bin/env bash
# 🌉 claw-lark-cards — one-line installer
#
#   curl -fsSL https://raw.githubusercontent.com/Duseus/claw-lark-cards/main/install.sh | bash
#
# What it does:
#   1. Locates an OpenClaw CLI (OPENCLAW_BIN override → `openclaw` on PATH → `npx` fallback)
#   2. Clones this repo (LARK_DIR override, LARK_REF branch/tag override, default: main)
#   3. Builds the plugin from source (npm install + npm run build → dist/)
#   4. Installs it via `openclaw plugins install <dir> --force --accept-capabilities`
#      and verifies the plugin shows up in `openclaw plugins list`
#
# It does NOT restart the gateway — run `openclaw gateway restart` yourself.
# A restart may kill the process running this script if it was launched from
# inside a gateway turn (e.g. by an agent mid-conversation).
#
# Why source install: npm package name `claw-fry-cards` belongs to the upstream
# project; this fork publishes no npm package. The plugin id stays
# `claw-fry-cards`, so existing config keys keep working.
#
# Env overrides:
#   OPENCLAW_BIN=/path/to/openclaw   skip auto-detection
#   LARK_DIR=/path/to/clone          reuse an existing checkout (skips clone)
#   LARK_REF=<branch-or-tag>         clone/checkout a specific branch or tag
set -euo pipefail

REPO="Duseus/claw-lark-cards"
PKG="claw-fry-cards"
REF="${LARK_REF:-main}"
DIR="${LARK_DIR:-/tmp/claw-lark-cards}"

say()  { printf '\033[1;36m▸\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- OpenClaw CLI
declare -a OC=()

find_openclaw() {
  if [ -n "${OPENCLAW_BIN:-}" ]; then
    [ -x "$OPENCLAW_BIN" ] || die "OPENCLAW_BIN is not executable: $OPENCLAW_BIN"
    OC=("$OPENCLAW_BIN"); return
  fi

  if command -v openclaw >/dev/null 2>&1; then
    OC=(openclaw); return
  fi

  # npm users without a global CLI can still drive OpenClaw through npx.
  if command -v npx >/dev/null 2>&1; then
    OC=(npx -y openclaw); return
  fi

  die "OpenClaw CLI not found. Install OpenClaw first, or set OPENCLAW_BIN=/path/to/openclaw"
}

# ---------------------------------------------------------------- source tree
get_source() {
  if [ -d "$DIR/.git" ]; then
    say "reusing existing checkout: $DIR"
    git -C "$DIR" fetch origin "$REF" >/dev/null 2>&1 || true
    git -C "$DIR" checkout -q "$REF" 2>/dev/null || true
    git -C "$DIR" pull --ff-only origin "$REF" >/dev/null 2>&1 || true
  else
    say "cloning $REPO ($REF) → $DIR"
    git clone --depth 1 --branch "$REF" "https://github.com/$REPO.git" "$DIR" \
      || die "git clone failed"
  fi
  [ -f "$DIR/package.json" ] || die "source tree looks wrong: $DIR/package.json missing"
}

find_openclaw
get_source

# ---------------------------------------------------------------- build
say "installing dependencies (this can take a while)"
( cd "$DIR" && npm install --legacy-peer-deps ) || die "npm install failed"
say "building dist/"
( cd "$DIR" && npm run build ) || die "npm run build failed"
[ -d "$DIR/dist" ] || die "build produced no dist/ directory"

# ---------------------------------------------------------------- install
say "installing plugin from $DIR"
"${OC[@]}" plugins install "$DIR" --force --accept-capabilities

# ---------------------------------------------------------------- verify
if "${OC[@]}" plugins list 2>/dev/null | grep -q "$PKG"; then
  ok "$PKG installed and registered"
else
  warn "install command finished but plugin not found in plugins list — check the output above"
  exit 1
fi

warn "not restarting the gateway — run \`${OC[*]} gateway restart\` yourself"
say "done. Next: see https://github.com/$REPO#-配置 for channel config (appId/appSecret + streaming)"
