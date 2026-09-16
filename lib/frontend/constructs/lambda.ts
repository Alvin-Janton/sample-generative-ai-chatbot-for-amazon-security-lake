import { Aws, Duration, Stack, aws_ec2 as ec2, aws_iam as iam, aws_lakeformation as lakeformation } from "aws-cdk-lib";
import { IFunction, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { IBucket } from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import path = require("path");

export interface BackendResourceProps {
  readonly tableSchemaKnowledgeBaseId: string;
  readonly runbooksKnowledgeBaseId: string;
  readonly bedrockVpc: ec2.Vpc;
  readonly bedrockInfraSg: ec2.SecurityGroup;
  readonly athenaOutputBucket: IBucket;
  readonly securityLakeDatabaseName: string;
  readonly securityLakeTableNames: string[];
  readonly athenaWorkgroupName: string;
  readonly bedrockModelId: string;
  readonly maxAthenaRows: number;
  readonly maxAthenaWaitSeconds: number;
}

export class LambdaFunctions extends Construct {
  public readonly lambdaFunction: IFunction;

  constructor(scope: Construct, id: string, props: BackendResourceProps) {
    super(scope, id);

    const lambdaExecutionRole = new iam.Role(this, "LambdaExecutionRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole"),
        iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaVPCAccessExecutionRole"),
      ],
    });

    this.grantBedrockAccess(lambdaExecutionRole, props);
    this.grantAthenaAccess(lambdaExecutionRole, props);
    this.grantGlueAndLakeFormationAccess(lambdaExecutionRole, props);
    this.grantAthenaOutputBucketAccess(lambdaExecutionRole, props);
    this.grantLakeFormationTablePermissions(lambdaExecutionRole, props);

    this.lambdaFunction = new NodejsFunction(this, "chatStreamingLambda", {
      runtime: Runtime.NODEJS_24_X,
      entry: path.join(__dirname, "../chat-handler/index.ts"),
      handler: "handler",
      role: lambdaExecutionRole,
      vpc: props.bedrockVpc,
      vpcSubnets: {
        subnets: [props.bedrockVpc.selectSubnets({ subnetGroupName: "bedrock_infra" }).subnets[0]],
      },
      securityGroups: [props.bedrockInfraSg],
      timeout: Duration.minutes(2),
      memorySize: 512,
      bundling: {
        minify: false,
        sourceMap: true,
      },
      environment: {
        BEDROCK_MODEL_ID: props.bedrockModelId,
        TABLE_SCHEMA_KNOWLEDGE_BASE_ID: props.tableSchemaKnowledgeBaseId,
        RUNBOOKS_KNOWLEDGE_BASE_ID: props.runbooksKnowledgeBaseId,
        ATHENA_OUTPUT_BUCKET: props.athenaOutputBucket.bucketName,
        SECURITY_LAKE_DATABASE_NAME: props.securityLakeDatabaseName,
        SECURITY_LAKE_TABLE_NAMES: JSON.stringify(props.securityLakeTableNames),
        ATHENA_WORKGROUP_NAME: props.athenaWorkgroupName,
        MAX_ATHENA_ROWS: props.maxAthenaRows.toString(),
        MAX_ATHENA_WAIT_SECONDS: props.maxAthenaWaitSeconds.toString(),
      },
    });
  }

  private grantBedrockAccess(role: iam.Role, props: BackendResourceProps): void {
    role.addToPolicy(new iam.PolicyStatement({
      actions: [
        "bedrock:InvokeModel",
        "bedrock:InvokeModelWithResponseStream",
        "bedrock:GetInferenceProfile",
        "bedrock:GetFoundationModel",
      ],
      resources: [
        `arn:${Aws.PARTITION}:bedrock:*::foundation-model/*`,
        `arn:${Aws.PARTITION}:bedrock:*:${Stack.of(this).account}:inference-profile/*`,
      ],
    }));

    role.addToPolicy(new iam.PolicyStatement({
      actions: ["bedrock:Retrieve"],
      resources: [
        `arn:${Aws.PARTITION}:bedrock:${Stack.of(this).region}:${Stack.of(this).account}:knowledge-base/${props.tableSchemaKnowledgeBaseId}`,
        `arn:${Aws.PARTITION}:bedrock:${Stack.of(this).region}:${Stack.of(this).account}:knowledge-base/${props.runbooksKnowledgeBaseId}`,
      ],
    }));
  }

  private grantAthenaAccess(role: iam.Role, props: BackendResourceProps): void {
    role.addToPolicy(new iam.PolicyStatement({
      actions: [
        "athena:StartQueryExecution",
        "athena:GetQueryExecution",
        "athena:GetQueryResults",
        "athena:StopQueryExecution",
      ],
      resources: [
        `arn:${Aws.PARTITION}:athena:${Stack.of(this).region}:${Stack.of(this).account}:workgroup/${props.athenaWorkgroupName}`,
      ],
    }));
  }

  private grantGlueAndLakeFormationAccess(role: iam.Role, props: BackendResourceProps): void {
    role.addToPolicy(new iam.PolicyStatement({
      actions: [
        "glue:GetDatabase",
        "glue:GetDatabases",
        "glue:GetTable",
        "glue:GetTables",
        "glue:GetPartition",
        "glue:GetPartitions",
        "glue:BatchGetPartition",
      ],
      resources: [
        `arn:${Aws.PARTITION}:glue:${Stack.of(this).region}:${Stack.of(this).account}:catalog`,
        `arn:${Aws.PARTITION}:glue:${Stack.of(this).region}:${Stack.of(this).account}:database/${props.securityLakeDatabaseName}`,
        ...props.securityLakeTableNames.map(
          (tableName) => `arn:${Aws.PARTITION}:glue:${Stack.of(this).region}:${Stack.of(this).account}:table/${props.securityLakeDatabaseName}/${tableName}`
        ),
      ],
    }));

    role.addToPolicy(new iam.PolicyStatement({
      actions: ["lakeformation:GetDataAccess"],
      resources: ["*"],
    }));
  }

  private grantAthenaOutputBucketAccess(role: iam.Role, props: BackendResourceProps): void {
    role.addToPolicy(new iam.PolicyStatement({
      actions: [
        "s3:GetBucketLocation",
        "s3:ListBucket",
        "s3:ListBucketMultipartUploads",
      ],
      resources: [props.athenaOutputBucket.bucketArn],
    }));

    role.addToPolicy(new iam.PolicyStatement({
      actions: [
        "s3:GetObject",
        "s3:PutObject",
        "s3:AbortMultipartUpload",
        "s3:ListMultipartUploadParts",
      ],
      resources: [`${props.athenaOutputBucket.bucketArn}/*`],
    }));
  }

  private grantLakeFormationTablePermissions(role: iam.Role, props: BackendResourceProps): void {
    new lakeformation.CfnPrincipalPermissions(this, "SecurityLakeDatabasePermissions", {
      principal: {
        dataLakePrincipalIdentifier: role.roleArn,
      },
      permissions: ["DESCRIBE"],
      permissionsWithGrantOption: [],
      resource: {
        database: {
          catalogId: Stack.of(this).account,
          name: props.securityLakeDatabaseName,
        },
      },
    });

    for (const tableName of props.securityLakeTableNames) {
      new lakeformation.CfnPrincipalPermissions(this, `SecurityLakeTablePermissions${this.safeId(tableName)}`, {
        principal: {
          dataLakePrincipalIdentifier: role.roleArn,
        },
        permissions: ["DESCRIBE", "SELECT"],
        permissionsWithGrantOption: [],
        resource: {
          table: {
            catalogId: Stack.of(this).account,
            databaseName: props.securityLakeDatabaseName,
            name: tableName,
          },
        },
      });
    }
  }

  private safeId(value: string): string {
    return value
      .split(/[^A-Za-z0-9]/)
      .filter(Boolean)
      .map((part) => part[0].toUpperCase() + part.slice(1))
      .join("");
  }
}
