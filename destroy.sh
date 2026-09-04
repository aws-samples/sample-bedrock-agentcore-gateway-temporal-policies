#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
# Tears down every stack created by deploy.sh.
set -euo pipefail

REGION="us-east-1"
PROFILE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile) PROFILE="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
if [[ -n "$PROFILE" ]]; then export AWS_PROFILE="$PROFILE"; fi
export AWS_DEFAULT_REGION="$REGION"
export AWS_REGION="$REGION"

(cd cdk && npm ci --no-fund --no-audit && npx cdk destroy --all --force)
rm -f cdk/outputs.json
echo "All stacks destroyed."
