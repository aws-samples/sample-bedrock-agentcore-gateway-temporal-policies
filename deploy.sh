#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# One-shot deployment for the AgentCore Gateway + Dogwood demo.
#
#   ./deploy.sh --email <you@example.com> [--profile <aws-profile>] [--region <region>] [--model-id <bedrock-model-id>]
#
# Deploys the CDK stacks (AgentCore Gateway + policies + rate limit + demo
# backend + Cognito-protected dashboard), builds the dashboard, publishes it,
# creates the first Cognito user (an invitation email with a temporary
# password is sent to --email), and prints the URL. Safe to re-run; it
# updates in place.
set -euo pipefail

REGION="us-east-1"
PROFILE=""
MODEL_ID=""
EMAIL=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile) PROFILE="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --model-id) MODEL_ID="$2"; shift 2 ;;
    --email) EMAIL="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$EMAIL" ]]; then
  echo "Usage: ./deploy.sh --email <you@example.com> [--profile <aws-profile>] [--region <region>] [--model-id <id>]" >&2
  echo "--email is required: it becomes the first Cognito user allowed into the dashboard." >&2
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

if [[ -n "$PROFILE" ]]; then
  export AWS_PROFILE="$PROFILE"
fi
export AWS_DEFAULT_REGION="$REGION"
export AWS_REGION="$REGION"

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

step "Checking prerequisites"
command -v node >/dev/null || { echo "node is required (v18+)"; exit 1; }
command -v npm >/dev/null || { echo "npm is required"; exit 1; }
command -v python3 >/dev/null || { echo "python3 is required"; exit 1; }
command -v aws >/dev/null || { echo "aws cli is required"; exit 1; }
NODE_MAJOR=$(node -e 'console.log(process.versions.node.split(".")[0])')
[[ "$NODE_MAJOR" -ge 18 ]] || { echo "node v18+ is required (found v$NODE_MAJOR)"; exit 1; }

ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
echo "Deploying to account $ACCOUNT, region $REGION"

step "Installing CDK dependencies"
(cd cdk && npm ci --no-fund --no-audit)

step "Bootstrapping CDK (no-op if already bootstrapped)"
(cd cdk && npx cdk bootstrap "aws://$ACCOUNT/$REGION" 2>&1 | tail -1)

step "Deploying stacks (gateway, policies, rate limit, backend, hosting, auth)"
CDK_ARGS=(--all --require-approval never --outputs-file outputs.json)
if [[ -n "$MODEL_ID" ]]; then
  CDK_ARGS+=(-c "modelId=$MODEL_ID")
fi
(cd cdk && npx cdk deploy "${CDK_ARGS[@]}")

step "Reading stack outputs"
read_output() {
  python3 -c "
import json, sys
outputs = json.load(open('cdk/outputs.json'))
print(outputs['$1']['$2'])
"
}
API_URL=$(read_output DogwoodGatewayCore ApiUrl)
BUCKET=$(read_output DogwoodGatewayWeb SiteBucketName)
DIST_ID=$(read_output DogwoodGatewayWeb DistributionId)
DASHBOARD_URL=$(read_output DogwoodGatewayWeb DashboardUrl)
USER_POOL_ID=$(read_output DogwoodGatewayWeb UserPoolId)
CLIENT_ID=$(read_output DogwoodGatewayWeb UserPoolClientId)
COGNITO_DOMAIN=$(read_output DogwoodGatewayWeb CognitoDomainUrl)

step "Ensuring the first Cognito user exists ($EMAIL)"
if aws cognito-idp admin-get-user --user-pool-id "$USER_POOL_ID" --username "$EMAIL" >/dev/null 2>&1; then
  echo "User already exists; no invitation sent."
else
  aws cognito-idp admin-create-user \
    --user-pool-id "$USER_POOL_ID" \
    --username "$EMAIL" \
    --user-attributes Name=email,Value="$EMAIL" Name=email_verified,Value=true >/dev/null
  echo "Invitation email with a temporary password sent to $EMAIL."
fi

step "Building the dashboard"
(cd frontend && npm ci --no-fund --no-audit && npm run build)
python3 - <<EOF
import json
json.dump(
    {
        "apiUrl": "$API_URL",
        "cognitoDomain": "$COGNITO_DOMAIN",
        "clientId": "$CLIENT_ID",
        "redirectUri": "$DASHBOARD_URL/",
    },
    open("frontend/dist/config.json", "w"),
)
EOF

step "Publishing the dashboard"
aws s3 sync frontend/dist "s3://$BUCKET" --delete
aws cloudfront create-invalidation --distribution-id "$DIST_ID" --paths '/*' --query 'Invalidation.Id' --output text >/dev/null

printf '\n\033[1;32m✔ Deployment complete\033[0m\n\n'
echo "  Dashboard : $DASHBOARD_URL"
echo "  Demo API  : $API_URL (Cognito JWT required)"
echo ""
echo "  Sign in with $EMAIL and the temporary password from the invitation"
echo "  email; Cognito will ask you to set a permanent one. Add more users:"
echo "    aws cognito-idp admin-create-user --user-pool-id $USER_POOL_ID \\"
echo "      --username other@example.com --user-attributes Name=email,Value=other@example.com Name=email_verified,Value=true"
echo ""
echo "  Run ./destroy.sh when you are done."
