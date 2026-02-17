#!/usr/bin/env bash
set -euo pipefail

# claude-code-hooks installer
# Usage:
#   ./install.sh <target-project-dir> [clone|update|local:/path] [--port <number>]
#
# Examples:
#   ./install.sh /Users/me/my-project
#   ./install.sh /Users/me/my-project local:/Users/me/hooks-source/.claude/hooks
#   ./install.sh . local:$(dirname "$0")
#   ./install.sh /Users/me/my-project local:... --port 4000

HOOKS_REPO="https://github.com/reurgency/claude-code-hooks-ui.git"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${CYAN}[hooks]${NC} $*"; }
ok()    { echo -e "${GREEN}[hooks]${NC} $*"; }
warn()  { echo -e "${YELLOW}[hooks]${NC} $*"; }
err()   { echo -e "${RED}[hooks]${NC} $*" >&2; }

# ─── OS detection ─────────────────────────────────────────────────────────────

PLATFORM="unknown"

detect_os() {
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*)  PLATFORM="windows" ;;
    Darwin*)               PLATFORM="macos"   ;;
    Linux*)                PLATFORM="linux"   ;;
    *)                     PLATFORM="unknown" ;;
  esac
}

# ─── Path normalisation ──────────────────────────────────────────────────────
# On Windows (Git Bash / MSYS2 / Cygwin) users frequently paste paths with
# backslashes (e.g.  C:\Users\me\project).  Bash treats backslashes as escape
# characters, so we convert them to forward slashes.  We also translate
# Windows drive letters  C:/...  →  /c/...  which is the native Git Bash form.

normalize_path() {
  local p="$1"

  if [ "$PLATFORM" = "windows" ]; then
    # 1. Replace every backslash with a forward slash
    p="${p//\\//}"

    # 2. Convert drive letter  C:/  →  /c/  (case-insensitive)
    if [[ "$p" =~ ^([A-Za-z]):/(.*) ]]; then
      local drive="${BASH_REMATCH[1]}"
      local rest="${BASH_REMATCH[2]}"
      # Lowercase the drive letter for Git Bash convention
      p="/${drive,,}/${rest}"
    fi
  fi

  echo "$p"
}

# ─── Resolve target project ────────────────────────────────────────────────

resolve_target() {
  local target="${1:-}"

  if [ -z "$target" ]; then
    echo ""
    err "Missing required argument: target project directory"
    echo ""
    echo "Usage:"
    echo "  $0 <target-project-dir> [clone|update|local:/path/to/hooks]"
    echo ""
    echo "Examples:"
    echo "  $0 /Users/me/my-project"
    echo "  $0 /Users/me/my-project local:/path/to/hooks-source"
    echo "  $0 .                                              # use current directory"
    echo ""
    exit 1
  fi

  # Normalise Windows-style paths (backslashes → forward slashes, drive letters)
  target="$(normalize_path "$target")"

  # Resolve to absolute path
  PROJECT_ROOT="$(cd "$target" 2>/dev/null && pwd)" || {
    err "Target directory does not exist: $target"
    exit 1
  }

  # Validate it looks like a project (has .claude/ or at least isn't inside a hooks dir)
  if [[ "$PROJECT_ROOT" == */.claude/hooks* ]] || [[ "$PROJECT_ROOT" == */tts-app* ]]; then
    err "Target looks like a hooks directory, not a project root: $PROJECT_ROOT"
    err "Point this at the project root (the parent of .claude/)."
    exit 1
  fi

  # Set all paths as absolute
  HOOKS_DIR="$PROJECT_ROOT/.claude/hooks"
  SETTINGS_FILE="$PROJECT_ROOT/.claude/settings.local.json"
  TEMPLATE_FILE="$HOOKS_DIR/settings.template.json"

  info "Target project: $PROJECT_ROOT"
  info "Hooks destination: $HOOKS_DIR"
}

# ─── Prerequisites ───────────────────────────────────────────────────────────

check_prerequisites() {
  local missing=0

  if ! command -v bun &>/dev/null; then
    err "bun is required but not installed. See https://bun.sh"
    missing=1
  fi

  if ! command -v git &>/dev/null; then
    err "git is required but not installed."
    missing=1
  fi

  if ! command -v jq &>/dev/null; then
    warn "jq not found — settings merge will use simple copy instead of smart merge."
    warn "Install jq for better results: https://jqlang.github.io/jq/download/"
  fi

  if [ "$missing" -ne 0 ]; then
    err "Missing prerequisites. Install them and try again."
    exit 1
  fi

  ok "Prerequisites OK (bun $(bun --version), git $(git --version | cut -d' ' -f3))"
}

# ─── Install hooks ───────────────────────────────────────────────────────────

install_hooks() {
  local mode="${1:-clone}"

  case "$mode" in
    update)
      if [ ! -d "$HOOKS_DIR/.git" ]; then
        err "$HOOKS_DIR is not a git repo. Use a fresh install instead."
        exit 1
      fi
      info "Updating hooks via git pull..."
      git -C "$HOOKS_DIR" pull --ff-only
      ;;

    local:*)
      local src="${mode#local:}"
      # Normalise Windows-style paths
      src="$(normalize_path "$src")"
      # Resolve source to absolute path
      src="$(cd "$src" 2>/dev/null && pwd)" || {
        err "Source directory not found: ${mode#local:}"
        exit 1
      }
      if [ ! -f "$src/package.json" ]; then
        err "Source doesn't look like a hooks directory (no package.json): $src"
        exit 1
      fi
      # Guard against installing into itself
      if [ "$src" = "$HOOKS_DIR" ]; then
        err "Source and destination are the same directory: $src"
        exit 1
      fi
      info "Copying hooks from $src..."
      mkdir -p "$HOOKS_DIR"
      # Copy everything except node_modules, .git, and runtime artifacts
      if command -v rsync &>/dev/null; then
        rsync -a --exclude='node_modules' --exclude='.git' --exclude='logs' \
              --exclude='.claude/data' --exclude='.codemill' --exclude='.DS_Store' \
              --exclude='_archive_py' --exclude='utils' --exclude='.env' \
              "$src/" "$HOOKS_DIR/"
      else
        # Fallback for Windows (Git Bash) where rsync may not be installed
        warn "rsync not found — using cp fallback (some excluded dirs may be copied)"
        cp -R "$src/." "$HOOKS_DIR/"
        # Remove directories that would have been excluded by rsync
        for exclude_dir in node_modules .git logs .claude/data .codemill _archive_py utils; do
          rm -rf "$HOOKS_DIR/$exclude_dir" 2>/dev/null || true
        done
        rm -f "$HOOKS_DIR/.env" "$HOOKS_DIR/.DS_Store" 2>/dev/null || true
      fi
      ;;

    clone|*)
      if [ -d "$HOOKS_DIR" ]; then
        # Check if it's already a hooks-manager git clone
        if [ -d "$HOOKS_DIR/.git" ]; then
          local remote_url
          remote_url=$(git -C "$HOOKS_DIR" config --get remote.origin.url 2>/dev/null || echo "")
          if [[ "$remote_url" == *"claude-code-hooks"* ]]; then
            warn "$HOOKS_DIR is already a hooks-manager clone."
            warn "Use 'update' to pull latest changes instead."
            exit 1
          fi
        fi

        # Existing hooks dir that isn't ours — merge into it
        warn "$HOOKS_DIR already exists — merging hooks into existing directory..."
        info "Existing files will NOT be overwritten."

        local tmp_dir
        tmp_dir=$(mktemp -d)
        trap "rm -rf '$tmp_dir'" EXIT

        info "Cloning hooks repo to temp directory..."
        git clone --depth 1 "$HOOKS_REPO" "$tmp_dir/hooks" 2>&1 | sed 's/^/  /'

        info "Merging into existing hooks directory..."
        if command -v rsync &>/dev/null; then
          # --ignore-existing preserves any files the user already has
          rsync -a --ignore-existing \
                --exclude='node_modules' --exclude='.git' --exclude='logs' \
                --exclude='.claude/data' --exclude='.codemill' --exclude='.DS_Store' \
                --exclude='_archive_py' --exclude='utils' --exclude='.env' \
                "$tmp_dir/hooks/" "$HOOKS_DIR/"
        else
          warn "rsync not found — using cp fallback (existing files will be preserved)"
          # cp -n = no-clobber (don't overwrite existing files)
          if [ "$PLATFORM" = "macos" ]; then
            cp -Rn "$tmp_dir/hooks/." "$HOOKS_DIR/" 2>/dev/null || true
          else
            cp -Rn "$tmp_dir/hooks/." "$HOOKS_DIR/" 2>/dev/null || true
          fi
          # Remove directories that would have been excluded by rsync
          for exclude_dir in node_modules .git logs .claude/data .codemill _archive_py utils; do
            rm -rf "$HOOKS_DIR/$exclude_dir" 2>/dev/null || true
          done
          rm -f "$HOOKS_DIR/.env" "$HOOKS_DIR/.DS_Store" 2>/dev/null || true
        fi

        rm -rf "$tmp_dir"
        trap - EXIT
        ok "Hooks merged into existing directory (existing files preserved)"
      else
        info "Cloning hooks repo..."
        mkdir -p "$PROJECT_ROOT/.claude"
        git clone "$HOOKS_REPO" "$HOOKS_DIR"
      fi
      ;;
  esac

  ok "Hooks installed at $HOOKS_DIR"
}

# ─── Install dependencies ────────────────────────────────────────────────────

install_deps() {
  info "Installing dependencies..."
  (cd "$HOOKS_DIR" && bun install)
  ok "Dependencies installed"
}

# ─── Merge settings ─────────────────────────────────────────────────────────

merge_settings() {
  if [ ! -f "$TEMPLATE_FILE" ]; then
    err "Template not found at $TEMPLATE_FILE — skipping settings merge."
    return
  fi

  mkdir -p "$PROJECT_ROOT/.claude"

  if [ ! -f "$SETTINGS_FILE" ]; then
    # No existing settings — just copy the template
    info "Creating $SETTINGS_FILE from template..."
    cp "$TEMPLATE_FILE" "$SETTINGS_FILE"
    ok "Settings created"

    # Also apply local overlay if it exists (for fresh installs with private hooks)
    local LOCAL_TEMPLATE="$HOOKS_DIR/settings.local.template.json"
    if [ -f "$LOCAL_TEMPLATE" ] && command -v jq &>/dev/null; then
      info "Merging local overlay from settings.local.template.json..."
      local overlay_hooks
      overlay_hooks=$(jq '.hooks' "$LOCAL_TEMPLATE")

      local merged
      merged=$(jq --argjson overlay "$overlay_hooks" '
        reduce ($overlay | keys[]) as $event (
          .;
          if .hooks[$event] then
            .hooks[$event][0].hooks = (
              [.hooks[$event][0].hooks[], $overlay[$event][0].hooks[]]
              | unique_by(.command)
            )
          else
            .hooks[$event] = $overlay[$event]
          end
        )
      ' "$SETTINGS_FILE")

      echo "$merged" | jq '.' > "$SETTINGS_FILE.tmp"
      mv "$SETTINGS_FILE.tmp" "$SETTINGS_FILE"
      ok "Local overlay merged (send_event hooks added)"
    fi
    return
  fi

  # Existing settings — merge hooks key
  if command -v jq &>/dev/null; then
    info "Merging hook registrations into existing $SETTINGS_FILE..."

    # Extract hooks from template
    local template_hooks
    template_hooks=$(jq '.hooks' "$TEMPLATE_FILE")

    # Merge: existing settings + template hooks (existing hooks take precedence)
    local merged
    merged=$(jq --argjson new_hooks "$template_hooks" '
      .hooks = (($new_hooks // {}) * (.hooks // {}))
    ' "$SETTINGS_FILE")

    echo "$merged" | jq '.' > "$SETTINGS_FILE.tmp"
    mv "$SETTINGS_FILE.tmp" "$SETTINGS_FILE"
    ok "Hook registrations merged (existing settings preserved)"

    # ── Local overlay merge (private hooks like send_event.ts) ──
    local LOCAL_TEMPLATE="$HOOKS_DIR/settings.local.template.json"
    if [ -f "$LOCAL_TEMPLATE" ]; then
      info "Merging local overlay from settings.local.template.json..."

      local overlay_hooks
      overlay_hooks=$(jq '.hooks' "$LOCAL_TEMPLATE")

      # Append overlay hooks into each event's hooks array, deduplicating by command
      merged=$(jq --argjson overlay "$overlay_hooks" '
        reduce ($overlay | keys[]) as $event (
          .;
          if .hooks[$event] then
            .hooks[$event][0].hooks = (
              [.hooks[$event][0].hooks[], $overlay[$event][0].hooks[]]
              | unique_by(.command)
            )
          else
            .hooks[$event] = $overlay[$event]
          end
        )
      ' "$SETTINGS_FILE")

      echo "$merged" | jq '.' > "$SETTINGS_FILE.tmp"
      mv "$SETTINGS_FILE.tmp" "$SETTINGS_FILE"
      ok "Local overlay merged (send_event hooks added)"
    fi
  else
    warn "jq not available — cannot smart-merge settings."
    warn "Template saved to $TEMPLATE_FILE"
    warn "Manually copy the \"hooks\" key from settings.template.json into $SETTINGS_FILE"
  fi
}

# ─── Verify installation ────────────────────────────────────────────────────

verify_install() {
  echo ""
  info "Verifying installation..."
  echo ""

  local pass=0
  local fail=0

  check_item() {
    local label="$1"
    local path="$2"
    local type="${3:-file}"  # file or dir

    if [ "$type" = "dir" ]; then
      if [ -d "$path" ]; then
        echo -e "  ${GREEN}✔${NC}  $label"
        ((++pass))
      else
        echo -e "  ${RED}✘${NC}  $label  ${RED}(missing: $path)${NC}"
        ((++fail))
      fi
    else
      if [ -f "$path" ]; then
        echo -e "  ${GREEN}✔${NC}  $label"
        ((++pass))
      else
        echo -e "  ${RED}✘${NC}  $label  ${RED}(missing: $path)${NC}"
        ((++fail))
      fi
    fi
  }

  echo -e "  ${CYAN}── Core files ──${NC}"
  check_item "package.json"            "$HOOKS_DIR/package.json"
  check_item "tsconfig.json"           "$HOOKS_DIR/tsconfig.json"
  check_item "settings.template.json"  "$HOOKS_DIR/settings.template.json"

  echo -e "  ${CYAN}── Hook scripts ──${NC}"
  check_item "stop.ts"                 "$HOOKS_DIR/stop.ts"
  check_item "subagent_stop.ts"        "$HOOKS_DIR/subagent_stop.ts"
  check_item "notification.ts"         "$HOOKS_DIR/notification.ts"
  check_item "session_end.ts"          "$HOOKS_DIR/session_end.ts"
  check_item "session_start.ts"        "$HOOKS_DIR/session_start.ts"
  check_item "pre_tool_use.ts"         "$HOOKS_DIR/pre_tool_use.ts"
  check_item "post_tool_use.ts"        "$HOOKS_DIR/post_tool_use.ts"
  check_item "user_prompt_submit.ts"   "$HOOKS_DIR/user_prompt_submit.ts"
  check_item "pre_compact.ts"          "$HOOKS_DIR/pre_compact.ts"
  check_item "send_event.ts"           "$HOOKS_DIR/send_event.ts"

  echo -e "  ${CYAN}── Libraries ──${NC}"
  check_item "lib/config.ts"           "$HOOKS_DIR/lib/config.ts"
  check_item "lib/tts/"                "$HOOKS_DIR/lib/tts"               "dir"
  check_item "lib/llm/"                "$HOOKS_DIR/lib/llm"               "dir"
  check_item "lib/templates/"          "$HOOKS_DIR/lib/templates"         "dir"

  echo -e "  ${CYAN}── TTS Manager App ──${NC}"
  check_item "tts-app/server.ts"       "$HOOKS_DIR/tts-app/server.ts"
  check_item "tts-app/public/index.html" "$HOOKS_DIR/tts-app/public/index.html"

  echo -e "  ${CYAN}── Dependencies ──${NC}"
  check_item "node_modules/"           "$HOOKS_DIR/node_modules"          "dir"

  echo -e "  ${CYAN}── Settings integration ──${NC}"
  check_item "settings.local.json"     "$SETTINGS_FILE"

  # Check that settings.local.json actually has a "hooks" key
  if [ -f "$SETTINGS_FILE" ]; then
    if command -v jq &>/dev/null; then
      if jq -e '.hooks' "$SETTINGS_FILE" &>/dev/null; then
        echo -e "  ${GREEN}✔${NC}  settings.local.json contains \"hooks\" key"
        ((++pass))
      else
        echo -e "  ${RED}✘${NC}  settings.local.json missing \"hooks\" key"
        ((++fail))
      fi
    else
      if grep -q '"hooks"' "$SETTINGS_FILE" 2>/dev/null; then
        echo -e "  ${GREEN}✔${NC}  settings.local.json contains \"hooks\" key"
        ((++pass))
      else
        echo -e "  ${RED}✘${NC}  settings.local.json missing \"hooks\" key"
        ((++fail))
      fi
    fi
  fi

  echo ""
  if [ "$fail" -eq 0 ]; then
    ok "Verification passed: $pass/$pass checks OK"
  else
    err "Verification: $pass passed, $fail failed"
    warn "Review the failures above and re-run the installer if needed."
  fi
}

# ─── Remind about .env ──────────────────────────────────────────────────────

remind_env() {
  echo ""
  info "Optional API keys (add to project root .env or export in shell):"
  echo "  ANTHROPIC_API_KEY     — LLM summarization (Anthropic)"
  echo "  OPENAI_API_KEY        — LLM summarization (OpenAI) / TTS (OpenAI)"
  echo "  ELEVENLABS_API_KEY    — TTS (ElevenLabs)"
  echo "  UNREAL_SPEECH_API_KEY — TTS (Unreal Speech)"
  echo ""
  warn "The installer does NOT create or modify .env files — secrets stay project-specific."
}

# ─── Port flag parsing ────────────────────────────────────────────────────────

CONFIGURED_PORT=3455

parse_flags() {
  local new_args=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --port)
        if [ -z "${2:-}" ] || ! [[ "$2" =~ ^[0-9]+$ ]]; then
          err "--port requires a numeric argument"
          exit 1
        fi
        if [ "$2" -lt 1024 ] || [ "$2" -gt 65535 ]; then
          err "Port must be between 1024 and 65535"
          exit 1
        fi
        CONFIGURED_PORT="$2"
        shift 2
        ;;
      *)
        new_args+=("$1")
        shift
        ;;
    esac
  done
  REMAINING_ARGS=("${new_args[@]}")
}

# ─── Configure port ──────────────────────────────────────────────────────────

configure_port() {
  # Only write if a non-default port was explicitly requested
  if [ "$CONFIGURED_PORT" -eq 3455 ]; then
    return
  fi

  local config_file="$HOOKS_DIR/hooks.config.json"
  info "Setting server port to $CONFIGURED_PORT..."

  if command -v jq &>/dev/null; then
    if [ -f "$config_file" ]; then
      local merged
      merged=$(jq --argjson port "$CONFIGURED_PORT" '.server.port = $port' "$config_file")
      echo "$merged" > "$config_file"
    else
      echo "{\"server\":{\"port\":$CONFIGURED_PORT}}" | jq '.' > "$config_file"
    fi
  else
    if [ -f "$config_file" ]; then
      warn "jq not available — cannot merge port into existing config."
      warn "Manually add '\"server\": { \"port\": $CONFIGURED_PORT }' to $config_file"
    else
      echo "{\"server\":{\"port\":$CONFIGURED_PORT}}" > "$config_file"
    fi
  fi

  ok "Server port configured: $CONFIGURED_PORT"
}

# ─── Main ────────────────────────────────────────────────────────────────────

main() {
  # Detect OS for path handling and tool availability
  detect_os

  # Parse --port flag before processing positional args
  parse_flags "$@"
  set -- "${REMAINING_ARGS[@]}"

  echo ""
  echo -e "${CYAN}╔══════════════════════════════════════╗${NC}"
  echo -e "${CYAN}║   claude-code-hooks installer v1.1   ║${NC}"
  echo -e "${CYAN}╚══════════════════════════════════════╝${NC}"
  echo ""

  if [ "$PLATFORM" = "windows" ]; then
    info "Detected Windows environment ($(uname -s))"
  fi

  # First arg is always the target project directory
  resolve_target "${1:-}"

  check_prerequisites

  # Second arg is the install mode (default: clone)
  local mode="${2:-clone}"
  install_hooks "$mode"
  install_deps
  configure_port
  merge_settings
  verify_install
  remind_env

  echo ""
  ok "Installation complete!"
  info "Start a new Claude Code session to activate hooks."
  info "Run 'bun run tts-app' from $HOOKS_DIR to start the Hooks Manager (localhost:$CONFIGURED_PORT)."
  echo ""
}

main "$@"
