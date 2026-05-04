#!/usr/bin/env bash
set -euo pipefail

service="${1:?Usage: railway-deploy-detached.sh <service> [environment]}"
environment="${2:-staging}"
timeout_seconds="${RAILWAY_DEPLOY_TIMEOUT_SECONDS:-900}"
poll_interval_seconds="${RAILWAY_DEPLOY_POLL_INTERVAL_SECONDS:-15}"
started_at_ms="$(node -e 'console.log(Date.now())')"

echo "Starting Railway deploy for service=${service} environment=${environment}"
railway up --service "$service" --environment "$environment" --detach

deployment_id=""
deadline=$((SECONDS + timeout_seconds))

while [[ -z "$deployment_id" && "$SECONDS" -lt "$deadline" ]]; do
  deployment_id="$(
    railway deployment list --service "$service" --environment "$environment" --limit 20 --json \
      | STARTED_AT_MS="$started_at_ms" node -e '
const fs = require("node:fs");

const deployments = JSON.parse(fs.readFileSync(0, "utf8"));
const startedAtMs = Number(process.env.STARTED_AT_MS);
const candidates = deployments
  .filter((deployment) => {
    const createdAtMs = Date.parse(deployment.createdAt);
    return Number.isFinite(createdAtMs) && createdAtMs >= startedAtMs - 5000;
  })
  .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

if (candidates[0]) {
  process.stdout.write(candidates[0].id);
}
'
  )"

  if [[ -z "$deployment_id" ]]; then
    echo "Waiting for Railway to register the new deployment..."
    sleep "$poll_interval_seconds"
  fi
done

if [[ -z "$deployment_id" ]]; then
  echo "Timed out waiting for Railway to register a deployment for ${service}."
  exit 1
fi

echo "Watching Railway deployment ${deployment_id}"

while [[ "$SECONDS" -lt "$deadline" ]]; do
  status="$(
    railway deployment list --service "$service" --environment "$environment" --limit 50 --json \
      | DEPLOYMENT_ID="$deployment_id" node -e '
const fs = require("node:fs");

const deployments = JSON.parse(fs.readFileSync(0, "utf8"));
const deployment = deployments.find((item) => item.id === process.env.DEPLOYMENT_ID);

if (deployment?.status) {
  process.stdout.write(deployment.status);
}
'
  )"

  if [[ -z "$status" ]]; then
    echo "Deployment ${deployment_id} is not present in Railway deployment list yet."
  else
    echo "Deployment ${deployment_id} status=${status}"
  fi

  case "$status" in
    SUCCESS)
      echo "Railway deployment succeeded for ${service}."
      exit 0
      ;;
    FAILED | CRASHED | REMOVED)
      echo "Railway deployment failed for ${service}: status=${status}"
      exit 1
      ;;
  esac

  sleep "$poll_interval_seconds"
done

echo "Timed out waiting for Railway deployment ${deployment_id} for ${service}."
exit 1
