// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';

/**
 * Static hosting for the dashboard (private S3 bucket behind CloudFront with
 * Origin Access Control) plus the Cognito user pool that protects the demo:
 * the dashboard signs users in through the Cognito Hosted UI (authorization
 * code + PKCE) and the demo API validates the resulting JWTs.
 */
export class WebStack extends cdk.Stack {
  readonly userPool: cognito.UserPool;
  readonly userPoolClient: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const bucket = new s3.Bucket(this, 'SiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      defaultRootObject: 'index.html',
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html' },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html' },
      ],
      comment: 'Dogwood Gateway demo dashboard',
    });

    // ------------------------------------------------------------------
    // Cognito: email + password sign-in via the classic Hosted UI.
    // Self sign-up is disabled; deploy.sh creates the first user and more
    // can be added with admin-create-user.
    // ------------------------------------------------------------------
    this.userPool = new cognito.UserPool(this, 'UserPool', {
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const domain = this.userPool.addDomain('HostedUi', {
      cognitoDomain: { domainPrefix: `dogwood-gateway-${this.account}` },
      managedLoginVersion: cognito.ManagedLoginVersion.CLASSIC_HOSTED_UI,
    });

    const callbackUrls = [
      `https://${distribution.distributionDomainName}/`,
      'http://localhost:5173/', // local dev (vite)
    ];
    this.userPoolClient = this.userPool.addClient('DashboardClient', {
      // USER_PASSWORD_AUTH is enabled so the smoke test can authenticate a
      // short-lived test user non-interactively.
      authFlows: { userPassword: true, userSrp: true },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL],
        callbackUrls,
        logoutUrls: callbackUrls,
      },
      preventUserExistenceErrors: true,
    });

    // Match the dashboard's dark mission-control theme on the Hosted UI.
    // Only CSS classes/properties documented as customizable are used.
    const hostedUiTheme = new cognito.CfnUserPoolUICustomizationAttachment(this, 'HostedUiTheme', {
      userPoolId: this.userPool.userPoolId,
      clientId: 'ALL',
      css: [
        '.background-customizable {background-color: #050b14;}',
        '.banner-customizable {padding: 16px; background-color: #0a1626;}',
        '.submitButton-customizable {font-size: 14px; font-weight: bold; margin: 20px 0px 10px 0px; height: 40px; width: 100%; color: #05101e; background-color: #38bdf8;}',
        '.submitButton-customizable:hover {color: #05101e; background-color: #5ecdfa;}',
        '.errorMessage-customizable {padding: 5px; font-size: 14px; width: 100%; background: #fff2f4; border: 2px solid #ff3b5c; color: #d62648;}',
        '.inputField-customizable {width: 100%; height: 34px; color: #0b1a2b; background-color: #ffffff; border: 1px solid #7c93ad;}',
        '.inputField-customizable:focus {border-color: #38bdf8; outline: 0;}',
      ].join('\n'),
    });
    hostedUiTheme.node.addDependency(domain);

    new cdk.CfnOutput(this, 'SiteBucketName', { value: bucket.bucketName });
    new cdk.CfnOutput(this, 'DistributionId', { value: distribution.distributionId });
    new cdk.CfnOutput(this, 'DashboardUrl', { value: `https://${distribution.distributionDomainName}` });
    new cdk.CfnOutput(this, 'UserPoolId', { value: this.userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: this.userPoolClient.userPoolClientId });
    new cdk.CfnOutput(this, 'CognitoDomainUrl', { value: domain.baseUrl() });
  }
}
