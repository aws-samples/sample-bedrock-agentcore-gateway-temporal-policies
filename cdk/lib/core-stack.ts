// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwv2int from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { execFileSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

export interface CoreStackProps extends cdk.StackProps {
  modelId: string;
  /** Cognito user pool + client whose JWTs guard the demo API. */
  userPool: cognito.IUserPool;
  userPoolClient: cognito.IUserPoolClient;
}

const TARGET_NAME = 'BankTools';
const SESSION_BUDGET = 5000;

export class CoreStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: CoreStackProps) {
    super(scope, id, props);

    const lambdaRoot = path.join(__dirname, '..', '..', 'lambda');

    // ------------------------------------------------------------------
    // 1. Banking tools Lambda (the gateway target implementation)
    // ------------------------------------------------------------------
    const toolsFn = new lambda.Function(this, 'BankToolsFn', {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'handler.lambda_handler',
      code: lambda.Code.fromAsset(path.join(lambdaRoot, 'tools')),
      timeout: cdk.Duration.seconds(30),
      description: 'Synthetic banking tools behind the AgentCore Gateway (demo data only)',
    });

    // ------------------------------------------------------------------
    // 2. Policy engine
    // ------------------------------------------------------------------
    const policyEngine = new agentcore.CfnPolicyEngine(this, 'PolicyEngine', {
      name: 'DogwoodGatewayEngine',
      description: 'Dogwood Gateway demo - Cedar + Dogwood temporal policies',
    });

    // ------------------------------------------------------------------
    // 3. Gateway (MCP protocol, AWS_IAM inbound auth, policies ENFORCEd)
    // ------------------------------------------------------------------
    const gatewayRole = new iam.Role(this, 'GatewayRole', {
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com', {
        conditions: { StringEquals: { 'aws:SourceAccount': this.account } },
      }),
      description: 'Execution role assumed by AgentCore Gateway',
    });

    // All gateway-role permissions live in one explicit policy that the
    // Gateway resource depends on. The service validates GetPolicyEngine at
    // gateway creation time, so the policy must exist first; referencing the
    // gateway ARN here would create a circular dependency, hence the
    // account-scoped wildcard for gateway resources.
    const gatewayRolePolicy = new iam.Policy(this, 'GatewayRolePolicy', {
      roles: [gatewayRole],
      statements: [
        new iam.PolicyStatement({
          actions: ['lambda:InvokeFunction'],
          resources: [toolsFn.functionArn],
        }),
        new iam.PolicyStatement({
          actions: [
            'bedrock-agentcore:GetPolicyEngine',
            'bedrock-agentcore:AuthorizeAction',
            'bedrock-agentcore:PartiallyAuthorizeActions',
          ],
          resources: [
            policyEngine.attrPolicyEngineArn,
            `arn:aws:bedrock-agentcore:${this.region}:${this.account}:gateway/*`,
          ],
        }),
        new iam.PolicyStatement({
          actions: ['bedrock-agentcore:GetWorkloadAccessToken'],
          resources: [
            `arn:aws:bedrock-agentcore:${this.region}:${this.account}:workload-identity-directory/*`,
          ],
        }),
      ],
    });

    const gateway = new agentcore.CfnGateway(this, 'Gateway', {
      name: 'dogwood-gateway-gw',
      protocolType: 'MCP',
      authorizerType: 'AWS_IAM',
      roleArn: gatewayRole.roleArn,
      // DEBUG surfaces the reason for policy denials in MCP error payloads,
      // which the dashboard displays verbatim.
      exceptionLevel: 'DEBUG',
      description: 'Dogwood Gateway demo gateway - every agent call crosses this wall',
      policyEngineConfiguration: {
        arn: policyEngine.attrPolicyEngineArn,
        mode: 'ENFORCE',
      },
    });

    gateway.node.addDependency(gatewayRolePolicy);

    // ------------------------------------------------------------------
    // 4. Gateway target: the banking tools, schema declared inline.
    //    Output fields matter: temporal policies correlate against them.
    // ------------------------------------------------------------------
    const str = (description?: string) => ({ type: 'string', ...(description ? { description } : {}) });
    const int = (description?: string) => ({ type: 'integer', ...(description ? { description } : {}) });

    const target = new agentcore.CfnGatewayTarget(this, 'BankToolsTarget', {
      gatewayIdentifier: gateway.attrGatewayIdentifier,
      name: TARGET_NAME,
      description: 'Synthetic banking tools (demo)',
      credentialProviderConfigurations: [
        { credentialProviderType: 'GATEWAY_IAM_ROLE' },
      ],
      targetConfiguration: {
        mcp: {
          lambda: {
            lambdaArn: toolsFn.functionArn,
            toolSchema: {
              inlinePayload: [
                {
                  name: 'get_account_balance',
                  description:
                    'Retrieve the current account balance for a customer. Returns the accountId that belongs to the customer.',
                  inputSchema: {
                    type: 'object',
                    properties: { customerId: str('Customer id, e.g. C-1001') },
                    required: ['customerId'],
                  },
                  outputSchema: {
                    type: 'object',
                    properties: {
                      status: str(),
                      customerId: str(),
                      accountId: str('The account id owned by this customer'),
                      balance: int(),
                    },
                    required: ['status', 'customerId', 'accountId', 'balance'],
                  },
                },
                {
                  name: 'transfer_funds',
                  description: 'Transfer funds between two accounts.',
                  inputSchema: {
                    type: 'object',
                    properties: {
                      fromAccount: str(),
                      toAccount: str(),
                      amount: int('Amount in USD'),
                    },
                    required: ['fromAccount', 'toAccount', 'amount'],
                  },
                  outputSchema: {
                    type: 'object',
                    properties: {
                      status: str(),
                      fromAccount: str(),
                      toAccount: str(),
                      amount: int(),
                    },
                    required: ['status', 'fromAccount', 'toAccount', 'amount'],
                  },
                },
                {
                  name: 'purchase_item',
                  description: 'Purchase one item on the corporate account.',
                  inputSchema: {
                    type: 'object',
                    properties: { itemId: str(), amount: int('Price in USD') },
                    required: ['itemId', 'amount'],
                  },
                  outputSchema: {
                    type: 'object',
                    properties: {
                      status: str(),
                      itemId: str(),
                      amount: int(),
                      orderId: str(),
                    },
                    required: ['status', 'itemId', 'amount', 'orderId'],
                  },
                },
                {
                  name: 'get_market_news',
                  description: 'Get the latest market news for a topic.',
                  inputSchema: {
                    type: 'object',
                    properties: { topic: str() },
                    required: ['topic'],
                  },
                },
                {
                  name: 'read_market_research',
                  description:
                    'Read the latest third-party market research note for a topic. External, unverified content.',
                  inputSchema: {
                    type: 'object',
                    properties: { topic: str('Topic or ticker, e.g. ACME') },
                    required: ['topic'],
                  },
                  outputSchema: {
                    type: 'object',
                    properties: {
                      status: str(),
                      topic: str(),
                      source: str('Origin of the note (third party)'),
                      note: str('The research note text'),
                    },
                    required: ['status', 'topic', 'source', 'note'],
                  },
                },
                {
                  name: 'approve_trade',
                  description:
                    'Request maker-checker approval for a trade (simulated human/compliance approval). Returns an approval record for the exact ticker and quantity.',
                  inputSchema: {
                    type: 'object',
                    properties: { ticker: str('Ticker symbol, e.g. AMZN'), qty: int('Number of shares') },
                    required: ['ticker', 'qty'],
                  },
                  outputSchema: {
                    type: 'object',
                    properties: {
                      status: str(),
                      ticker: str(),
                      qty: int(),
                      approvalId: str(),
                    },
                    required: ['status', 'ticker', 'qty', 'approvalId'],
                  },
                },
                {
                  name: 'execute_trade',
                  description: 'Execute a trade for a ticker and quantity.',
                  inputSchema: {
                    type: 'object',
                    properties: { ticker: str('Ticker symbol, e.g. AMZN'), qty: int('Number of shares') },
                    required: ['ticker', 'qty'],
                  },
                  outputSchema: {
                    type: 'object',
                    properties: {
                      status: str(),
                      ticker: str(),
                      qty: int(),
                      orderId: str(),
                    },
                    required: ['status', 'ticker', 'qty', 'orderId'],
                  },
                },
              ],
            },
          },
        },
      },
    });

    // ------------------------------------------------------------------
    // 5. Policies. Plain Cedar permits let lookups run (and be recorded as
    //    response events); Dogwood temporal statements enforce the story.
    // ------------------------------------------------------------------
    const gwArn = gateway.attrGatewayArn;
    const action = (tool: string) => `AgentCore::Action::"${TARGET_NAME}___${tool}"`;
    const resource = `AgentCore::Gateway::"${gwArn}"`;

    // The plain permits are intentionally unconditional: this demo controls
    // *behavior over time* with the temporal policies below, not per-request
    // conditions. The Cedar analyzer flags unconditional permits as "Overly
    // Permissive", so validation findings are ignored for these three only.
    const cedarPolicy = (idSuffix: string, name: string, statement: string, description: string) => {
      const policy = new agentcore.CfnPolicy(this, idSuffix, {
        policyEngineId: policyEngine.attrPolicyEngineId,
        name,
        description,
        validationMode: 'IGNORE_ALL_FINDINGS',
        definition: { cedar: { statement } },
      });
      policy.addDependency(target);
      return policy;
    };

    const dogwoodPolicy = (idSuffix: string, name: string, statement: string, description: string) => {
      const policy = new agentcore.CfnPolicy(this, idSuffix, {
        policyEngineId: policyEngine.attrPolicyEngineId,
        name,
        description,
        validationMode: 'FAIL_ON_ANY_FINDINGS',
        definition: { policy: { statement } },
      });
      policy.addDependency(target);
      return policy;
    };

    const permitBalance = cedarPolicy(
      'PermitBalanceLookup',
      'PermitBalanceLookup',
      `permit (principal, action == ${action('get_account_balance')}, resource == ${resource});`,
      'Lookups are always allowed, so their responses are recorded in the session trajectory.',
    );
    const permitNews = cedarPolicy(
      'PermitMarketNews',
      'PermitMarketNews',
      `permit (principal, action == ${action('get_market_news')}, resource == ${resource});`,
      'Market news is allowed by policy; the rate limit is what contains the retry storm.',
    );
    const permitPurchase = cedarPolicy(
      'PermitPurchase',
      'PermitPurchase',
      `permit (principal, action == ${action('purchase_item')}, resource == ${resource});`,
      'Purchases are allowed individually; the temporal budget cap bounds the session total.',
    );
    // Create policies one at a time: parallel creates against the same
    // engine can race each other (and their rollbacks).
    permitNews.addDependency(permitBalance);
    permitPurchase.addDependency(permitNews);

    // Output-to-input integrity: a transfer is only permitted when a prior
    // get_account_balance response in this session returned the destination
    // account. A hallucinated account number has no matching lookup -> DENY.
    const transferPolicy = dogwoodPolicy(
      'TransferRequiresLookup',
      'TransferRequiresLookup',
      `permit (principal, action == ${action('transfer_funds')}, resource == ${resource})
when temporal {
    formerly within 1h ${action('get_account_balance')}::response{
        eventResource: resource,
        output.accountId: context.input.toAccount
    }
};`,
      'Output-to-input integrity: transfers only to accounts returned by a prior lookup in this session.',
    );
    transferPolicy.addDependency(permitPurchase);

    // Cumulative budget: forbid a purchase once the session total (including
    // the current request) exceeds the budget. Each individual purchase can
    // be under every per-call threshold and the pattern is still stopped.
    const budgetPolicy = dogwoodPolicy(
      'SessionBudgetCap',
      'SessionBudgetCap',
      `forbid (principal, action == ${action('purchase_item')}, resource == ${resource})
when temporal {
    exists (total: Long).
        (sum amt for (amt: Long), (t: Timepoint).
            where (formerly within 1h (${action('purchase_item')}::request{ eventResource: resource, input.amount: amt } && tp(t)))) == total
        && total > ${SESSION_BUDGET}
};`,
      `Cumulative session budget: total purchase_item amount per session must stay at or under $${SESSION_BUDGET}.`,
    );
    budgetPolicy.addDependency(transferPolicy);

    const permitApprove = cedarPolicy(
      'PermitApproveTrade',
      'PermitApproveTrade',
      `permit (principal, action == ${action('approve_trade')}, resource == ${resource});`,
      'Approvals are always allowed, so each one is recorded as a response event the trade policy can consume.',
    );
    permitApprove.addDependency(budgetPolicy);

    // Maker-checker with one-time-use approvals: a trade is permitted only
    // while no completed trade has occurred since a matching approval (same
    // ticker, same quantity) within the last hour. The first execution
    // consumes the approval; a second execution needs a fresh one. Matching
    // the left operand on ::response is what keeps the request being
    // authorized from blocking itself.
    const approvalPolicy = dogwoodPolicy(
      'TradeRequiresUnusedApproval',
      'TradeRequiresUnusedApproval',
      `permit (principal, action == ${action('execute_trade')}, resource == ${resource})
when temporal {
    !${action('execute_trade')}::response{ eventResource: resource }
    since within 1h ${action('approve_trade')}::response{
        eventResource: resource,
        input.ticker: context.input.ticker,
        input.qty: context.input.qty
    }
};`,
      'One-time-use approval (maker-checker): each approval authorizes exactly one trade for the exact ticker and quantity.',
    );
    approvalPolicy.addDependency(permitApprove);

    // Concurrency guard for the approval (closes a race in the permit above):
    // two execute_trade requests fired concurrently, before the first one's
    // response is recorded, would both see "no completed trade since the
    // approval" and both pass. This forbid counts execution ATTEMPTS
    // (::request events, which include the request being authorized and any
    // in-flight ones) that no matching approval has followed. More than one
    // attempt since the last matching approval means a second attempt is
    // riding the same approval -> forbid. Anchoring the count with `since`
    // (rather than a plain windowed count_within) is what resets the tally on
    // each fresh approval, so a previously DENIED attempt does not block
    // later, freshly-approved executions. Verified against the Dogwood
    // reference interpreter: act 5's ALLOW/DENY/ALLOW sequence is unchanged,
    // and a concurrent double-execution burst is denied from the 2nd attempt.
    // Note this is intentionally stricter than approval stacking: two standing
    // approvals authorize two sequential executions, not two concurrent ones.
    const oneAttemptPolicy = dogwoodPolicy(
      'TradeOneAttemptPerApproval',
      'TradeOneAttemptPerApproval',
      `forbid (principal, action == ${action('execute_trade')}, resource == ${resource})
when temporal {
    bind(n,
        count for (t: Timepoint). where (
            !${action('approve_trade')}::response{
                eventResource: resource,
                input.ticker: context.input.ticker,
                input.qty: context.input.qty
            }
            since within 1h
            (${action('execute_trade')}::request{
                eventResource: resource,
                input.ticker: context.input.ticker,
                input.qty: context.input.qty
            } && tp(t))
        ),
        n > 1)
};`,
      'Concurrency guard: at most one execution attempt per matching approval, counting in-flight requests.',
    );
    oneAttemptPolicy.addDependency(approvalPolicy);

    const permitResearch = cedarPolicy(
      'PermitMarketResearch',
      'PermitMarketResearch',
      `permit (principal, action == ${action('read_market_research')}, resource == ${resource});`,
      'Reading research is always allowed - but its response event taints the session for transfers.',
    );
    permitResearch.addDependency(oneAttemptPolicy);
    // Tainted session (the "lethal trifecta" guard): once untrusted external
    // content has entered the session, money movement is forbidden for the
    // rest of that session - regardless of whether an injection fooled the
    // model, and regardless of any permit the transfer would otherwise match
    // (a Cedar forbid always overrides permits).
    const taintPolicy = dogwoodPolicy(
      'TaintedSessionNoTransfer',
      'TaintedSessionNoTransfer',
      `forbid (principal, action == ${action('transfer_funds')}, resource == ${resource})
when temporal {
    formerly within 1h ${action('read_market_research')}::response{
        eventResource: resource
    }
};`,
      'Prompt-injection blast-radius control: no transfers in a session that has read untrusted external content.',
    );
    taintPolicy.addDependency(permitResearch);

    // ------------------------------------------------------------------
    // 6. Gateway rate limit (no CloudFormation resource exists for rate
    //    limits, so a custom resource drives the control-plane API).
    //    1 request/second on the flaky tool; every other tool gets its own
    //    generous bucket via the wildcard entry. Rate limit enforcement is
    //    distributed, so a concurrent burst is what trips it visibly (the
    //    demo's act 4 sends 60 concurrent calls and gets a large share
    //    throttled).
    // ------------------------------------------------------------------
    const rateLimitId = 'dogwood-gateway-tool-storm';
    const rateLimitEntries = [
      {
        dimensions: { toolName: `${TARGET_NAME}___get_market_news` },
        requests: [{ rate: 1, period: 'second' }],
      },
      {
        dimensions: { toolName: '*' },
        requests: [{ rate: 300, period: 'minute' }],
      },
    ];
    const rateLimitDescription = 'Demo: contain a runaway retry loop against get_market_news';
    const rateLimit = new cr.AwsCustomResource(this, 'ToolStormRateLimit', {
      installLatestAwsSdk: true,
      onCreate: {
        service: 'bedrock-agentcore-control',
        action: 'CreateGatewayRateLimit',
        parameters: {
          gatewayIdentifier: gateway.attrGatewayIdentifier,
          rateLimitId,
          description: rateLimitDescription,
          dimensionKeys: ['toolName'],
          entries: rateLimitEntries,
        },
        physicalResourceId: cr.PhysicalResourceId.of(rateLimitId),
      },
      // dimensionKeys are immutable and UpdateGatewayRateLimit rejects them.
      onUpdate: {
        service: 'bedrock-agentcore-control',
        action: 'UpdateGatewayRateLimit',
        parameters: {
          gatewayIdentifier: gateway.attrGatewayIdentifier,
          rateLimitId,
          description: rateLimitDescription,
          entries: rateLimitEntries,
        },
        physicalResourceId: cr.PhysicalResourceId.of(rateLimitId),
      },
      onDelete: {
        service: 'bedrock-agentcore-control',
        action: 'DeleteGatewayRateLimit',
        parameters: {
          gatewayIdentifier: gateway.attrGatewayIdentifier,
          rateLimitId,
        },
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: [
            'bedrock-agentcore:CreateGatewayRateLimit',
            'bedrock-agentcore:UpdateGatewayRateLimit',
            'bedrock-agentcore:DeleteGatewayRateLimit',
            'bedrock-agentcore:GetGatewayRateLimit',
          ],
          // A rate limit is a sub-resource of the gateway, so these actions are
          // authorized against the gateway ARN (Create) and the rate-limit
          // sub-resource ARN under it (Get/Update/Delete). Both are needed; the
          // grant is confined to this one gateway.
          resources: [gwArn, `${gwArn}/*`],
        }),
      ]),
    });
    rateLimit.node.addDependency(gateway);

    // ------------------------------------------------------------------
    // 7. Trajectory event store
    // ------------------------------------------------------------------
    const table = new dynamodb.Table(this, 'EventsTable', {
      partitionKey: { name: 'runId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'seq', type: dynamodb.AttributeType.NUMBER },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expireAt',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ------------------------------------------------------------------
    // 8. Demo agent Lambda
    // ------------------------------------------------------------------
    const agentFn = new lambda.Function(this, 'AgentFn', {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'handler.lambda_handler',
      code: lambda.Code.fromAsset(path.join(lambdaRoot, 'agent')),
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      description: 'Dogwood Gateway demo agent (Bedrock Converse tool-use loop over gateway MCP)',
      environment: {
        GATEWAY_URL: gateway.attrGatewayUrl,
        MODEL_ID: props.modelId,
        TABLE_NAME: table.tableName,
      },
    });
    table.grantReadWriteData(agentFn);
    // Least-privilege model access: scope InvokeModel to the configured model
    // rather than every model. A cross-region inference profile
    // (e.g. "us.anthropic.claude-sonnet-4-5-...") fans a single request out to
    // the underlying foundation model in several Regions, and InvokeModel is
    // authorized against the foundation-model ARN in whichever Region actually
    // serves it. The Region wildcard on the foundation-model ARN is therefore
    // REQUIRED for the profile to work; what matters for blast radius is that
    // the model id is pinned (not "*"). A plain foundation-model id (no geo
    // prefix) resolves to the same ARN; the unused profile ARN is harmless.
    const baseModelId = props.modelId.replace(/^(us|eu|apac|global)\./, '');
    agentFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: [
          `arn:aws:bedrock:*::foundation-model/${baseModelId}`,
          `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/${props.modelId}`,
        ],
      }),
    );
    agentFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock-agentcore:InvokeGateway'],
        // Scoped to the gateway itself; the agent does not manage sub-resources.
        resources: [gwArn],
      }),
    );

    // ------------------------------------------------------------------
    // 9. Demo API Lambda + HTTP API
    // ------------------------------------------------------------------
    const apiFn = new lambda.Function(this, 'ApiFn', {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'handler.lambda_handler',
      code: lambda.Code.fromAsset(path.join(lambdaRoot, 'api'), {
        bundling: {
          image: lambda.Runtime.PYTHON_3_13.bundlingImage,
          local: {
            tryBundle(outputDir: string): boolean {
              const source = path.join(lambdaRoot, 'api');
              // execFileSync (not execSync): arguments are passed as an array
              // with no shell, so no interpolated path can be interpreted as a
              // command. outputDir is CDK-provided, but this avoids the pattern
              // entirely.
              execFileSync(
                'python3',
                [
                  '-m', 'pip', 'install',
                  '-r', path.join(source, 'requirements.txt'),
                  '-t', outputDir,
                  '--quiet', '--disable-pip-version-check',
                ],
                { stdio: 'inherit' },
              );
              fs.copyFileSync(path.join(source, 'handler.py'), path.join(outputDir, 'handler.py'));
              return true;
            },
          },
          command: [
            'bash',
            '-c',
            'pip install -r requirements.txt -t /asset-output && cp handler.py /asset-output/',
          ],
        },
      }),
      timeout: cdk.Duration.seconds(90),
      description: 'Dogwood Gateway demo API (start acts, poll events, toggle enforcement mode)',
      environment: {
        TABLE_NAME: table.tableName,
        AGENT_FUNCTION: agentFn.functionName,
        GATEWAY_ID: gateway.attrGatewayIdentifier,
        SESSION_BUDGET: `${SESSION_BUDGET}`,
      },
    });
    table.grantReadData(apiFn);
    agentFn.grantInvoke(apiFn);
    apiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock-agentcore:GetGateway', 'bedrock-agentcore:UpdateGateway'],
        resources: [gwArn],
      }),
    );
    // UpdateGateway passes the gateway execution role back; that requires
    // iam:PassRole for the same role.
    apiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [gatewayRole.roleArn],
        conditions: { StringEquals: { 'iam:PassedToService': 'bedrock-agentcore.amazonaws.com' } },
      }),
    );

    const api = new apigwv2.HttpApi(this, 'DemoApi', {
      description: 'Dogwood Gateway demo API',
      corsPreflight: {
        allowOrigins: ['*'],
        allowMethods: [apigwv2.CorsHttpMethod.GET, apigwv2.CorsHttpMethod.POST, apigwv2.CorsHttpMethod.OPTIONS],
        allowHeaders: ['content-type', 'authorization'],
      },
    });
    // Every route requires a valid Cognito JWT (the dashboard sends the
    // access token obtained through the Hosted UI).
    const jwtAuthorizer = new HttpJwtAuthorizer(
      'DashboardJwt',
      `https://cognito-idp.${this.region}.amazonaws.com/${props.userPool.userPoolId}`,
      { jwtAudience: [props.userPoolClient.userPoolClientId] },
    );
    const integration = new apigwv2int.HttpLambdaIntegration('ApiIntegration', apiFn);
    for (const [route, method] of [
      ['/config', apigwv2.HttpMethod.GET],
      ['/run', apigwv2.HttpMethod.POST],
      ['/events', apigwv2.HttpMethod.GET],
      ['/mode', apigwv2.HttpMethod.POST],
    ] as const) {
      api.addRoutes({ path: route, methods: [method], integration, authorizer: jwtAuthorizer });
    }

    // ------------------------------------------------------------------
    // Outputs
    // ------------------------------------------------------------------
    new cdk.CfnOutput(this, 'ApiUrl', { value: api.apiEndpoint });
    new cdk.CfnOutput(this, 'GatewayUrl', { value: gateway.attrGatewayUrl });
    new cdk.CfnOutput(this, 'GatewayIdOut', { value: gateway.attrGatewayIdentifier });
    new cdk.CfnOutput(this, 'PolicyEngineIdOut', { value: policyEngine.attrPolicyEngineId });
    new cdk.CfnOutput(this, 'AgentFunctionName', { value: agentFn.functionName });
    new cdk.CfnOutput(this, 'EventsTableName', { value: table.tableName });
  }
}
