import { Aspects, RemovalPolicy, Stack, StackProps } from "aws-cdk-lib";
import { Construct } from 'constructs';
import { LambdaFunctions } from './constructs/lambda';
import { ApiGateway } from './constructs/rest-api';
import { ReactAppBuild } from "./constructs/react-app-build";
import { ReactAppDeploy } from "./constructs/react-app-deploy";
import { AwsSolutionsChecks, NagSuppressions } from "cdk-nag";
import { BedrockAppStack } from "../bedrock/bedrock-kbs-agent";
import { BedrockBaseInfraStack } from "../bedrock/bedrock-base-infra";

export class FrontendAppStack extends Stack {
  constructor(scope: Construct, id: string, bedrockAppStack: BedrockAppStack, bedrockBaseInfraStack: BedrockBaseInfraStack, props?: StackProps) {
    super(scope, id, props);

    // Apply AwsSolutionsChecks
    Aspects.of(this).add(new AwsSolutionsChecks({ verbose: true }));

    const allowedClientIpv4Cidr = this.node.tryGetContext("allowedClientIpv4Cidr") as string;
    const securityLakeDatabaseName = this.node.tryGetContext("securityLakeDatabaseName") as string;
    const securityLakeTableNames = this.node.tryGetContext("securityLakeTableNames") as string[];
    const athenaWorkgroupName = this.node.tryGetContext("athenaWorkgroupName") as string;
    const bedrockModelId = this.node.tryGetContext("bedrockModelId") as string;
    const maxAthenaRows = Number(this.node.tryGetContext("maxAthenaRows") ?? 100);
    const maxAthenaWaitSeconds = Number(this.node.tryGetContext("maxAthenaWaitSeconds") ?? 45);
    
    // Create the Lambda function
    const lambdaFunctions = new LambdaFunctions(this, 'LambdaFunctions', {
      tableSchemaKnowledgeBaseId: bedrockAppStack.tableSchemaKnowledgeBaseId,
      runbooksKnowledgeBaseId: bedrockAppStack.runbooksKnowledgeBaseId,
      bedrockVpc: bedrockBaseInfraStack.bedrock_vpc,
      bedrockInfraSg: bedrockBaseInfraStack.bedrock_infra_sg,
      athenaOutputBucket: bedrockBaseInfraStack.kb_source_s3_bucket,
      securityLakeDatabaseName,
      securityLakeTableNames,
      athenaWorkgroupName,
      bedrockModelId,
      maxAthenaRows,
      maxAthenaWaitSeconds,
    });

    // Create the API Gateway
    const apiGateway = new ApiGateway(this, 'ApiGateway', {
      lambdaFunction: lambdaFunctions.lambdaFunction,
      allowedClientIpv4Cidr,
    });

    // Create the React app build
    const reactAppBuild = new ReactAppBuild(this, "ReactAppBuild", {
      restApiUrl: apiGateway.restApiUrl,
      webSocketUrl: "",
      apiKeyParameterName: apiGateway.apiKeyParameterName,
    });

    // Create the React app hosting
    new ReactAppDeploy(this, "ReactAppDeploy", {
      kmsKey: reactAppBuild.kmsKey,
      reactAppBucket: reactAppBuild.reactAppBucket,
      allowedClientIpv4Cidr,
    });

    NagSuppressions.addStackSuppressions(this, [
      {
        id: "AwsSolutions-IAM4",
        reason:
          "Suppressing L3 IAM policies since it is not managed by the application",
      },
      {
        id: "AwsSolutions-IAM5",
        reason:
          "Suppressing L3 IAM policies since it is not managed by the application",
      },
      {
        id: "AwsSolutions-L1",
        reason: "Lambda managed by L3 construct",
      },
    ]);
  }
}
