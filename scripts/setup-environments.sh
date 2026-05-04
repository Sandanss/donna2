#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────
# Donna — One-time environment setup
#
# Creates:
#   1. Neon database branches (dev + staging)
#   2. Railway "dev" environment with all env vars
#
# Prerequisites:
#   - neonctl (brew install neonctl)
#   - railway CLI (npm install -g @railway/cli)
#   - Both CLIs authenticated (neonctl auth, railway login)
#
# Usage:
#   bash scripts/setup-environments.sh
# ─────────────────────────────────────────────────────────────────

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

info()  { echo -e "${BOLD}▸${NC} $1"; }
ok()    { echo -e "${GREEN}✓${NC} $1"; }
warn()  { echo -e "${YELLOW}⚠${NC} $1"; }
fail()  { echo -e "${RED}✗${NC} $1"; exit 1; }

# ─────────────────────────────────────────────
# Pre-flight checks
# ─────────────────────────────────────────────

echo ""
echo -e "${BOLD}Donna — Environment Setup${NC}"
echo "─────────────────────────────────────────"
echo ""

command -v neonctl >/dev/null 2>&1 || fail "neonctl not found. Run: brew install neonctl"
command -v railway >/dev/null 2>&1 || fail "railway CLI not found. Run: npm install -g @railway/cli"

# Check neonctl auth
if ! neonctl projects list &>/dev/null; then
  warn "neonctl not authenticated. Opening browser..."
  neonctl auth
fi

# Check railway auth
if ! railway status &>/dev/null; then
  warn "Railway CLI not linked. Run: railway link"
  exit 1
fi

# ─────────────────────────────────────────────
# Step 1: Identify Neon project
# ─────────────────────────────────────────────

echo ""
info "Finding your Neon project..."

NEON_PROJECTS=$(neonctl projects list --output json 2>/dev/null)
NEON_PROJECT_COUNT=$(echo "$NEON_PROJECTS" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")

if [ "$NEON_PROJECT_COUNT" = "0" ]; then
  fail "No Neon projects found. Check your neonctl auth."
elif [ "$NEON_PROJECT_COUNT" = "1" ]; then
  NEON_PROJECT_ID=$(echo "$NEON_PROJECTS" | python3 -c "import sys,json; print(json.load(sys.stdin)[0]['id'])")
  NEON_PROJECT_NAME=$(echo "$NEON_PROJECTS" | python3 -c "import sys,json; print(json.load(sys.stdin)[0]['name'])")
  ok "Found Neon project: $NEON_PROJECT_NAME ($NEON_PROJECT_ID)"
else
  echo ""
  echo "Multiple Neon projects found:"
  echo "$NEON_PROJECTS" | python3 -c "
import sys, json
projects = json.load(sys.stdin)
for i, p in enumerate(projects):
    print(f'  {i+1}) {p[\"name\"]} ({p[\"id\"]})')
"
  echo ""
  read -rp "Select project number: " PROJECT_NUM
  NEON_PROJECT_ID=$(echo "$NEON_PROJECTS" | python3 -c "import sys,json; print(json.load(sys.stdin)[int(sys.argv[1])-1]['id'])" "$PROJECT_NUM")
  NEON_PROJECT_NAME=$(echo "$NEON_PROJECTS" | python3 -c "import sys,json; print(json.load(sys.stdin)[int(sys.argv[1])-1]['name'])" "$PROJECT_NUM")
  ok "Selected: $NEON_PROJECT_NAME ($NEON_PROJECT_ID)"
fi

# ─────────────────────────────────────────────
# Step 2: Create Neon branches
# ─────────────────────────────────────────────

echo ""
info "Creating Neon database branches..."

# Check if branches already exist
EXISTING_BRANCHES=$(neonctl branches list --project-id "$NEON_PROJECT_ID" --output json 2>/dev/null)

create_branch() {
  local BRANCH_NAME=$1
  local EXISTS=$(echo "$EXISTING_BRANCHES" | python3 -c "
import sys, json
branches = json.load(sys.stdin)
print('yes' if any(b['name'] == '$BRANCH_NAME' for b in branches) else 'no')
" 2>/dev/null)

  if [ "$EXISTS" = "yes" ]; then
    warn "Branch '$BRANCH_NAME' already exists — skipping creation"
  else
    info "Creating branch '$BRANCH_NAME' from main..."
    neonctl branches create --project-id "$NEON_PROJECT_ID" --name "$BRANCH_NAME" --output json >/dev/null
    ok "Created branch: $BRANCH_NAME"
  fi

  # Get connection string
  local CONN_STR
  CONN_STR=$(neonctl connection-string --project-id "$NEON_PROJECT_ID" --branch "$BRANCH_NAME" 2>/dev/null)
  echo "$CONN_STR"
}

DEV_DB_URL=$(create_branch "dev")
STAGING_DB_URL=$(create_branch "staging")

echo ""
ok "Dev DATABASE_URL:     ${DEV_DB_URL:0:50}..."
ok "Staging DATABASE_URL: ${STAGING_DB_URL:0:50}..."

# ─────────────────────────────────────────────
# Step 3: Get configuration from user
# ─────────────────────────────────────────────

echo ""
info "Configuration needed:"
echo ""

read -rp "Dev Telnyx voice phone number (e.g. +1234567890): " DEV_TELNYX_NUMBER
if [ -z "$DEV_TELNYX_NUMBER" ]; then
  fail "Telnyx voice number is required"
fi

# ─────────────────────────────────────────────
# Step 4: Copy production env vars and create dev environment
# ─────────────────────────────────────────────

echo ""
info "Reading production env vars from Railway..."

# Get Railway vars for a service/environment.
get_railway_var() {
  local SERVICE=$1
  local ENVIRONMENT=$2
  local VAR=$3
  railway variable list --kv --service "$SERVICE" --environment "$ENVIRONMENT" 2>/dev/null | \
    awk -F= -v key="$VAR" '$1 == key {print substr($0, length(key) + 2); exit}'
}

get_prod_var() {
  get_railway_var "$1" production "$2"
}

get_public_url() {
  local SERVICE=$1
  local ENVIRONMENT=$2
  local DOMAIN
  DOMAIN=$(get_railway_var "$SERVICE" "$ENVIRONMENT" RAILWAY_PUBLIC_DOMAIN)
  if [ -n "$DOMAIN" ]; then
    echo "https://$DOMAIN"
  fi
}

# Read key production vars from Pipecat service
ANTHROPIC_API_KEY=$(get_prod_var donna-pipecat ANTHROPIC_API_KEY)
ANTHROPIC_MODEL=$(get_prod_var donna-pipecat ANTHROPIC_MODEL)
DEEPGRAM_API_KEY=$(get_prod_var donna-pipecat DEEPGRAM_API_KEY)
ELEVENLABS_API_KEY=$(get_prod_var donna-pipecat ELEVENLABS_API_KEY)
ELEVENLABS_VOICE_ID=$(get_prod_var donna-pipecat ELEVENLABS_VOICE_ID)
ELEVENLABS_MODEL=$(get_prod_var donna-pipecat ELEVENLABS_MODEL)
GOOGLE_API_KEY=$(get_prod_var donna-pipecat GOOGLE_API_KEY)
OPENAI_API_KEY=$(get_prod_var donna-pipecat OPENAI_API_KEY)
TELNYX_API_KEY=$(get_prod_var donna-pipecat TELNYX_API_KEY)
TELNYX_PUBLIC_KEY=$(get_prod_var donna-pipecat TELNYX_PUBLIC_KEY)
TELNYX_CONNECTION_ID=$(get_prod_var donna-pipecat TELNYX_CONNECTION_ID)
JWT_SECRET=$(get_prod_var donna-pipecat JWT_SECRET)
DONNA_API_KEYS=$(get_prod_var donna-pipecat DONNA_API_KEYS)
if [ -z "$DONNA_API_KEYS" ]; then
  DONNA_API_KEYS=$(get_prod_var donna-api DONNA_API_KEYS)
fi
FIELD_ENCRYPTION_KEY=$(get_prod_var donna-pipecat FIELD_ENCRYPTION_KEY)
if [ -z "$FIELD_ENCRYPTION_KEY" ]; then
  FIELD_ENCRYPTION_KEY=$(get_prod_var donna-api FIELD_ENCRYPTION_KEY)
fi
CLERK_SECRET_KEY=$(get_prod_var donna-api CLERK_SECRET_KEY)

DEV_PIPECAT_PUBLIC_URL=$(get_public_url donna-pipecat dev)
DEV_NODE_API_URL=$(get_public_url donna-api dev)
STAGING_PIPECAT_PUBLIC_URL=$(get_public_url donna-pipecat staging)
STAGING_NODE_API_URL=$(get_public_url donna-api staging)
MISSING_PUBLIC_URLS=false

if [ -z "$ANTHROPIC_API_KEY" ] || [ -z "$DONNA_API_KEYS" ] || [ -z "$FIELD_ENCRYPTION_KEY" ]; then
  warn "Could not read production vars. You may need to set vars manually in Railway dashboard."
  warn "The dev environment and Neon branches have been created — set vars in Railway UI."
  echo ""
  echo "Railway env vars to set for dev environment (both services):"
  echo "  ENVIRONMENT           = production"
  echo "  DATABASE_URL          = $DEV_DB_URL"
  echo "  PIPECAT_PUBLIC_URL    = https://<dev-pipecat-domain>"
  echo "  DONNA_API_KEYS        = pipecat:<key>,scheduler:<key>,notifications:<key>"
  echo "  FIELD_ENCRYPTION_KEY  = <32-byte base64url key>"
  echo "  JWT_SECRET            = <non-default secret>"
  echo "  TELNYX_API_KEY        = <Telnyx API key>"
  echo "  TELNYX_PUBLIC_KEY     = <Telnyx public key>"
  echo "  TELNYX_PHONE_NUMBER   = $DEV_TELNYX_NUMBER"
  echo "  TELNYX_CONNECTION_ID  = <Telnyx Voice API application id>"
  echo "  TELEPHONY_PROVIDER    = telnyx"
  echo "  NODE_API_URL          = https://<dev-node-domain>   (on donna-pipecat)"
  echo "  CLERK_SECRET_KEY      = <Clerk secret>              (on donna-api)"
  echo "  SCHEDULER_ENABLED     = false   (on donna-pipecat)"
  echo "  SCHEDULER_ENABLED     = false   (on donna-api; dev/staging must not place scheduled calls)"
  echo "  LOG_LEVEL             = INFO    (on donna-pipecat)"
  echo "  + copy all API keys from production"
  echo ""
  echo "For staging environment:"
  echo "  ENVIRONMENT           = production"
  echo "  DATABASE_URL          = $STAGING_DB_URL"
  echo "  PIPECAT_PUBLIC_URL    = https://<staging-pipecat-domain>"
  echo "  + same API keys and Telnyx dev number"
  echo ""
  ok "Neon branches created. Set Railway vars manually, then run: make deploy-dev"
  exit 0
fi

ok "Read production env vars"

warn_missing_public_url() {
  local SERVICE=$1
  local ENVIRONMENT=$2
  local VAR=$3
  warn "$SERVICE $ENVIRONMENT has no RAILWAY_PUBLIC_DOMAIN; $VAR must be set manually after Railway creates the domain."
  MISSING_PUBLIC_URLS=true
}

if [ -z "$DEV_PIPECAT_PUBLIC_URL" ]; then
  warn_missing_public_url donna-pipecat dev PIPECAT_PUBLIC_URL
fi
if [ -z "$DEV_NODE_API_URL" ]; then
  warn_missing_public_url donna-api dev NODE_API_URL
fi
if [ -z "$STAGING_PIPECAT_PUBLIC_URL" ]; then
  warn_missing_public_url donna-pipecat staging PIPECAT_PUBLIC_URL
fi
if [ -z "$STAGING_NODE_API_URL" ]; then
  warn_missing_public_url donna-api staging NODE_API_URL
fi
if [ "$MISSING_PUBLIC_URLS" = "true" ]; then
  warn "The script will continue, but URL-dependent vars must be set before live call testing."
fi

# ─────────────────────────────────────────────
# Step 5: Set dev environment variables
# ─────────────────────────────────────────────

echo ""
info "Setting env vars for dev environment..."

set_dev_var() {
  local SERVICE=$1
  local KEY=$2
  local VALUE=$3
  if [ -n "$VALUE" ]; then
    railway variable set --service "$SERVICE" --environment dev --skip-deploys "$KEY=$VALUE" 2>/dev/null && \
      echo "  Set $KEY on $SERVICE" || \
      warn "Failed to set $KEY on $SERVICE"
  fi
}

# Pipecat dev vars
info "Setting donna-pipecat dev vars..."
set_dev_var donna-pipecat ENVIRONMENT "production"
set_dev_var donna-pipecat DATABASE_URL "$DEV_DB_URL"
set_dev_var donna-pipecat PIPECAT_PUBLIC_URL "$DEV_PIPECAT_PUBLIC_URL"
set_dev_var donna-pipecat NODE_API_URL "$DEV_NODE_API_URL"
set_dev_var donna-pipecat TELEPHONY_PROVIDER "telnyx"
set_dev_var donna-pipecat TELNYX_API_KEY "$TELNYX_API_KEY"
set_dev_var donna-pipecat TELNYX_PUBLIC_KEY "$TELNYX_PUBLIC_KEY"
set_dev_var donna-pipecat TELNYX_PHONE_NUMBER "$DEV_TELNYX_NUMBER"
set_dev_var donna-pipecat TELNYX_CONNECTION_ID "$TELNYX_CONNECTION_ID"
set_dev_var donna-pipecat ANTHROPIC_API_KEY "$ANTHROPIC_API_KEY"
set_dev_var donna-pipecat ANTHROPIC_MODEL "${ANTHROPIC_MODEL:-claude-haiku-4-5-20251001}"
set_dev_var donna-pipecat DEEPGRAM_API_KEY "$DEEPGRAM_API_KEY"
set_dev_var donna-pipecat ELEVENLABS_API_KEY "$ELEVENLABS_API_KEY"
set_dev_var donna-pipecat ELEVENLABS_VOICE_ID "$ELEVENLABS_VOICE_ID"
set_dev_var donna-pipecat ELEVENLABS_MODEL "$ELEVENLABS_MODEL"
set_dev_var donna-pipecat GOOGLE_API_KEY "$GOOGLE_API_KEY"
set_dev_var donna-pipecat OPENAI_API_KEY "$OPENAI_API_KEY"
set_dev_var donna-pipecat JWT_SECRET "$JWT_SECRET"
set_dev_var donna-pipecat DONNA_API_KEYS "$DONNA_API_KEYS"
set_dev_var donna-pipecat FIELD_ENCRYPTION_KEY "$FIELD_ENCRYPTION_KEY"
set_dev_var donna-pipecat SCHEDULER_ENABLED "false"
set_dev_var donna-pipecat LOG_LEVEL "INFO"

# Node.js dev vars
info "Setting donna-api dev vars..."
set_dev_var donna-api ENVIRONMENT "production"
set_dev_var donna-api DATABASE_URL "$DEV_DB_URL"
set_dev_var donna-api PIPECAT_PUBLIC_URL "$DEV_PIPECAT_PUBLIC_URL"
set_dev_var donna-api TELEPHONY_PROVIDER "telnyx"
set_dev_var donna-api GOOGLE_API_KEY "$GOOGLE_API_KEY"
set_dev_var donna-api OPENAI_API_KEY "$OPENAI_API_KEY"
set_dev_var donna-api JWT_SECRET "$JWT_SECRET"
set_dev_var donna-api DONNA_API_KEYS "$DONNA_API_KEYS"
set_dev_var donna-api FIELD_ENCRYPTION_KEY "$FIELD_ENCRYPTION_KEY"
set_dev_var donna-api CLERK_SECRET_KEY "$CLERK_SECRET_KEY"
set_dev_var donna-api SCHEDULER_ENABLED "false"

# ─────────────────────────────────────────────
# Step 6: Set staging environment variables
# ─────────────────────────────────────────────

echo ""
info "Setting staging env vars..."

set_staging_var() {
  local SERVICE=$1
  local KEY=$2
  local VALUE=$3
  if [ -n "$VALUE" ]; then
    railway variable set --service "$SERVICE" --environment staging --skip-deploys "$KEY=$VALUE" 2>/dev/null && \
      echo "  Set $KEY on $SERVICE" || \
      warn "Failed to set $KEY on $SERVICE"
  fi
}

set_staging_var donna-pipecat ENVIRONMENT "production"
set_staging_var donna-pipecat DATABASE_URL "$STAGING_DB_URL"
set_staging_var donna-pipecat PIPECAT_PUBLIC_URL "$STAGING_PIPECAT_PUBLIC_URL"
set_staging_var donna-pipecat NODE_API_URL "$STAGING_NODE_API_URL"
set_staging_var donna-pipecat TELEPHONY_PROVIDER "telnyx"
set_staging_var donna-pipecat TELNYX_API_KEY "$TELNYX_API_KEY"
set_staging_var donna-pipecat TELNYX_PUBLIC_KEY "$TELNYX_PUBLIC_KEY"
set_staging_var donna-pipecat TELNYX_PHONE_NUMBER "$DEV_TELNYX_NUMBER"
set_staging_var donna-pipecat TELNYX_CONNECTION_ID "$TELNYX_CONNECTION_ID"
set_staging_var donna-pipecat ANTHROPIC_API_KEY "$ANTHROPIC_API_KEY"
set_staging_var donna-pipecat ANTHROPIC_MODEL "${ANTHROPIC_MODEL:-claude-haiku-4-5-20251001}"
set_staging_var donna-pipecat DEEPGRAM_API_KEY "$DEEPGRAM_API_KEY"
set_staging_var donna-pipecat ELEVENLABS_API_KEY "$ELEVENLABS_API_KEY"
set_staging_var donna-pipecat ELEVENLABS_VOICE_ID "$ELEVENLABS_VOICE_ID"
set_staging_var donna-pipecat ELEVENLABS_MODEL "$ELEVENLABS_MODEL"
set_staging_var donna-pipecat GOOGLE_API_KEY "$GOOGLE_API_KEY"
set_staging_var donna-pipecat OPENAI_API_KEY "$OPENAI_API_KEY"
set_staging_var donna-pipecat JWT_SECRET "$JWT_SECRET"
set_staging_var donna-pipecat DONNA_API_KEYS "$DONNA_API_KEYS"
set_staging_var donna-pipecat FIELD_ENCRYPTION_KEY "$FIELD_ENCRYPTION_KEY"
set_staging_var donna-pipecat SCHEDULER_ENABLED "false"
set_staging_var donna-pipecat LOG_LEVEL "INFO"
set_staging_var donna-api ENVIRONMENT "production"
set_staging_var donna-api DATABASE_URL "$STAGING_DB_URL"
set_staging_var donna-api PIPECAT_PUBLIC_URL "$STAGING_PIPECAT_PUBLIC_URL"
set_staging_var donna-api TELEPHONY_PROVIDER "telnyx"
set_staging_var donna-api GOOGLE_API_KEY "$GOOGLE_API_KEY"
set_staging_var donna-api OPENAI_API_KEY "$OPENAI_API_KEY"
set_staging_var donna-api JWT_SECRET "$JWT_SECRET"
set_staging_var donna-api DONNA_API_KEYS "$DONNA_API_KEYS"
set_staging_var donna-api FIELD_ENCRYPTION_KEY "$FIELD_ENCRYPTION_KEY"
set_staging_var donna-api CLERK_SECRET_KEY "$CLERK_SECRET_KEY"
set_staging_var donna-api SCHEDULER_ENABLED "false"

# ─────────────────────────────────────────────
# Step 7: Summary
# ─────────────────────────────────────────────

echo ""
echo "─────────────────────────────────────────"
echo -e "${GREEN}${BOLD}Setup complete!${NC}"
echo "─────────────────────────────────────────"
echo ""
echo "Environments created:"
echo "  production  → Neon main branch (unchanged)"
echo "  staging     → Neon 'staging' branch"
echo "  dev         → Neon 'dev' branch"
echo ""
echo "Next steps:"
echo ""
echo "  1. Configure Telnyx Voice API application for dev number ($DEV_TELNYX_NUMBER):"
if [ -n "$DEV_PIPECAT_PUBLIC_URL" ]; then
  echo "     Webhook URL → $DEV_PIPECAT_PUBLIC_URL/telnyx/events"
else
  echo "     Webhook URL → https://<dev-pipecat-domain>/telnyx/events"
  echo "     Set PIPECAT_PUBLIC_URL and NODE_API_URL after Railway creates domains."
fi
echo ""
echo "  2. Deploy to dev:"
echo "     make deploy-dev"
echo ""
echo "  3. Seed dev database (copy a test senior from prod):"
echo "     You can use the admin dashboard or insert directly"
echo ""
echo "  4. Test with a real call to $DEV_TELNYX_NUMBER"
echo ""
echo "  5. Iterate: edit → make deploy-dev-pipecat → call → repeat"
echo ""
echo "Commands:"
echo "  make deploy-dev          Deploy to dev"
echo "  make deploy-dev-pipecat  Deploy only Pipecat to dev (faster)"
echo "  make health-dev          Check dev services are up"
echo "  make logs-dev            Tail dev logs"
echo "  make test                Run all tests locally"
echo ""
