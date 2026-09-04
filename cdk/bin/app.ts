#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import * as cdk from 'aws-cdk-lib';
import { CoreStack } from '../lib/core-stack';
import { WebStack } from '../lib/web-stack';

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
};

// Bedrock model used by the demo agent. Override with: cdk deploy -c modelId=...
const modelId =
  app.node.tryGetContext('modelId') ?? 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';

// Hosting + Cognito first: the demo API's JWT authorizer references the pool.
const web = new WebStack(app, 'DogwoodGatewayWeb', {
  env,
  description: 'Dogwood Gateway demo - dashboard hosting (S3 + CloudFront) and Cognito auth',
});

new CoreStack(app, 'DogwoodGatewayCore', {
  env,
  description:
    'Dogwood Gateway demo - AgentCore Gateway, temporal policies (Dogwood), rate limits, demo agent + API (uksb-dogwoodgateway)',
  modelId,
  userPool: web.userPool,
  userPoolClient: web.userPoolClient,
});

cdk.Tags.of(app).add('project', 'sample-agentcore-dogwood-gateway');
