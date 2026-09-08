import { Construct } from "constructs";
import { Aws, aws_cloudfront_origins, CfnOutput, Duration } from "aws-cdk-lib";
import { IBucket } from "aws-cdk-lib/aws-s3";
import {
  AllowedMethods,
  CacheCookieBehavior,
  CachedMethods,
  CacheHeaderBehavior,
  CachePolicy,
  CacheQueryStringBehavior,
  CfnOriginAccessControl,
  Distribution,
  HttpVersion,
  PriceClass,
  SecurityPolicyProtocol,
  SSLMethod,
  ViewerProtocolPolicy,
} from "aws-cdk-lib/aws-cloudfront";
import { PolicyStatement, Effect, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Key } from "aws-cdk-lib/aws-kms";
import { CfnIPSet, CfnWebACL } from "aws-cdk-lib/aws-wafv2";
import { NagSuppressions } from "cdk-nag";

export interface ReactAppProps {
  readonly kmsKey: Key;
  readonly reactAppBucket: IBucket;
  readonly allowedClientIpv4Cidr: string;
  readonly allowedClientIpv6Cidr?: string;
}

export class ReactAppDeploy extends Construct {
  constructor(scope: Construct, id: string, props: ReactAppProps) {
    super(scope, id);

    // Create the CloudFront Origin Access Control (OAC)
    const originAccessControlId = this.addCloudFrontOriginAccessControl();

    // Create the CloudFront WebACL
    const webAcl = this.createCloudFrontWebAcl(
      props.allowedClientIpv4Cidr,
      props.allowedClientIpv6Cidr
    );

    // Create the CloudFront distribution
    const cloudFrontDistribution = this.createCloudFrontDistribution(
      props.reactAppBucket,
      originAccessControlId,
      webAcl
    );

    // Update the KMS key policy to allow use by CloudFront distribution
    this.updateKmsKeyPolicy(props.kmsKey, cloudFrontDistribution);

    // Update the S3 bucket policy to allow access to CloudFront distribution
    this.updateS3BucketPolicy(props.reactAppBucket, cloudFrontDistribution);

    // Create the CloudFormation output for the CloudFront URL
    this.createCloudFrontDistributionOutput(cloudFrontDistribution);
  }

  private createCloudFrontDistribution(
    reactAppBucket: IBucket,
    originAccessControlId: string,
    webAcl: CfnWebACL,
  ): Distribution {
    const distribution = new Distribution(this, "CloudFrontDistribution", {
      enabled: true,
      webAclId: webAcl.attrArn,
      defaultBehavior: {
        cachePolicy: new CachePolicy(this, "DistributionCachePolicy", {
          minTtl: Duration.seconds(0),
          defaultTtl: Duration.seconds(120),
          maxTtl: Duration.seconds(300),
          cookieBehavior: CacheCookieBehavior.none(),
          queryStringBehavior: CacheQueryStringBehavior.none(),
          headerBehavior: CacheHeaderBehavior.allowList(
            "Origin",
            "Access-Control-Request-Headers",
            "Access-Control-Request-Method",
            "Cache-Control"
          ),
        }),
        origin: aws_cloudfront_origins.S3BucketOrigin.withOriginAccessControl(reactAppBucket, {
          originAccessControlId: originAccessControlId,
          originPath: "/dist",
        }),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: AllowedMethods.ALLOW_ALL,
        cachedMethods: CachedMethods.CACHE_GET_HEAD,
        compress: true,
      },
      defaultRootObject: "index.html",
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: "/",
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: "/",
        },
      ],
      httpVersion: HttpVersion.HTTP2,
      minimumProtocolVersion: SecurityPolicyProtocol.TLS_V1_2_2021,
      priceClass: PriceClass.PRICE_CLASS_100,
      sslSupportMethod: SSLMethod.SNI,
    });
  
    NagSuppressions.addResourceSuppressions(distribution, [
      {
        id: "AwsSolutions-CFR1",
        reason: "Geo restrictions not enforced since this is a demo application",
      },
      {
        id: "AwsSolutions-CFR3",
        reason: "Access logging not enforced since this is a demo application",
      },
      {
        id: "AwsSolutions-CFR4",
        reason: "SSL version not enforced since this is a demo application",
      },
    ]);
  
    return distribution;
  }

  private createCloudFrontWebAcl(
    allowedClientIpv4Cidr: string,
    allowedClientIpv6Cidr?: string,
  ): CfnWebACL {
    const allowedClientIpv4Set = new CfnIPSet(this, "AllowedClientIpv4Set", {
      addresses: [allowedClientIpv4Cidr],
      ipAddressVersion: "IPV4",
      scope: "CLOUDFRONT",
      name: "genai-security-lake-cloudfront-allowed-client-ipv4",
    });

    const allowedIpStatements: CfnWebACL.StatementProperty[] = [
      {
        ipSetReferenceStatement: {
          arn: allowedClientIpv4Set.attrArn,
        },
      },
    ];

    if (allowedClientIpv6Cidr) {
      const allowedClientIpv6Set = new CfnIPSet(this, "AllowedClientIpv6Set", {
        addresses: [allowedClientIpv6Cidr],
        ipAddressVersion: "IPV6",
        scope: "CLOUDFRONT",
        name: "genai-security-lake-cloudfront-allowed-client-ipv6",
      });

      allowedIpStatements.push({
        ipSetReferenceStatement: {
          arn: allowedClientIpv6Set.attrArn,
        },
      });
    }

    const allowedIpStatement: CfnWebACL.StatementProperty =
      allowedIpStatements.length === 1
        ? allowedIpStatements[0]
        : { orStatement: { statements: allowedIpStatements } };

    return new CfnWebACL(this, "CloudFrontAcl", {
      defaultAction: {
        allow: {},
      },
      scope: "CLOUDFRONT",
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: "MetricForCloudFrontWebACL",
        sampledRequestsEnabled: true,
      },
      name: "CloudFrontACL",
      rules: [
        {
          name: "BlockNonAllowedClientIp",
          priority: 0,
          action: {
            block: {},
          },
          statement: {
            notStatement: {
              statement: allowedIpStatement,
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: "MetricForCloudFrontWebACL-BlockNonAllowedClientIp",
            sampledRequestsEnabled: true,
          },
        },
        {
          name: "CRSRule",
          priority: 1,
          statement: {
            managedRuleGroupStatement: {
              name: "AWSManagedRulesCommonRuleSet",
              vendorName: "AWS",
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: "MetricForCloudFrontWebACL-CRS",
            sampledRequestsEnabled: true,
          },
          overrideAction: {
            none: {},
          },
        },
      ],
    });
  }

  private addCloudFrontOriginAccessControl(): string {
    const oac = new CfnOriginAccessControl(this, "OriginAccessControl", {
      originAccessControlConfig: {
        name: "genai-security-lake-oac",
        originAccessControlOriginType: "s3",
        signingBehavior: "always",
        signingProtocol: "sigv4",
      },
    });
    return oac.getAtt("Id").toString();
  }

  private updateKmsKeyPolicy(
    kmsKey: Key,
    cloudFrontDistribution: Distribution
  ): void {
    kmsKey.addToResourcePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        principals: [new ServicePrincipal("cloudfront.amazonaws.com")],
        actions: ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey*"],
        resources: ["*"],
        conditions: {
          StringEquals: {
            "aws:SourceArn": `arn:aws:cloudfront::${Aws.ACCOUNT_ID}:distribution/${cloudFrontDistribution.distributionId}`,
          },
        },
      })
    );
  }

  private updateS3BucketPolicy(
    reactAppBucket: IBucket,
    cloudFrontDistribution: Distribution
  ): void {
    const bucketPolicy = new PolicyStatement({
      effect: Effect.ALLOW,
      principals: [new ServicePrincipal("cloudfront.amazonaws.com")],
      actions: ["s3:GetObject"],
      resources: [`${reactAppBucket.bucketArn}/*`],
      conditions: {
        StringEquals: {
          "AWS:SourceArn": `arn:aws:cloudfront::${Aws.ACCOUNT_ID}:distribution/${cloudFrontDistribution.distributionId}`,
        },
      },
    });
    reactAppBucket.addToResourcePolicy(bucketPolicy);
  }

  private createCloudFrontDistributionOutput(
    cloudFrontDistribution: Distribution
  ): void {
    new CfnOutput(this, "CloudFrontDistributionUrl", {
      key: "ReactAppUrl",
      value: `https://${cloudFrontDistribution.distributionDomainName}`,
      description: "The CloudFront URL for the React App",
    });
  }
}
