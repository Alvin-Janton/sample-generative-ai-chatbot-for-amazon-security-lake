import { Aspects, CfnOutput, Stack, StackProps, aws_bedrock as bedrock } from "aws-cdk-lib";
import { Construct } from "constructs";
import { AwsSolutionsChecks, NagSuppressions } from "cdk-nag";
import { BedrockBaseInfraStack } from "./bedrock-base-infra";

export class BedrockAppStack extends Stack {
  public readonly tableSchemaKnowledgeBaseId: string;
  public readonly runbooksKnowledgeBaseId: string;

  constructor(
    scope: Construct,
    id: string,
    bedrockBaseInfraStack: BedrockBaseInfraStack,
    props?: StackProps
  ) {
    super(scope, id, props);

    Aspects.of(this).add(new AwsSolutionsChecks({ verbose: true }));

    const tableSchemaKnowledgeBase = new bedrock.CfnKnowledgeBase(this, "gen_ai_sec_lake_table_schema_kb", {
      knowledgeBaseConfiguration: {
        type: "VECTOR",
        vectorKnowledgeBaseConfiguration: {
          embeddingModelArn: `arn:aws:bedrock:${this.region}::foundation-model/amazon.titan-embed-text-v1`,
        },
      },
      name: "gen-ai-sec-lake-table-schema",
      roleArn: bedrockBaseInfraStack.bedrock_kbs_role.roleArn,
      storageConfiguration: {
        type: "OPENSEARCH_SERVERLESS",
        opensearchServerlessConfiguration: {
          collectionArn: bedrockBaseInfraStack.genAiSecLakeTableSchemaOpsc.attrArn,
          vectorIndexName: "bedrock-knowledge-base-default-index",
          fieldMapping: {
            metadataField: "AMAZON_BEDROCK_METADATA",
            textField: "AMAZON_BEDROCK_TEXT_CHUNK",
            vectorField: "bedrock-knowledge-base-default-vector",
          },
        },
      },
    });
    tableSchemaKnowledgeBase.node.addDependency(bedrockBaseInfraStack.tableSchemaIndexResource);

    new bedrock.CfnDataSource(this, "genAiSecLakeTableSchemaDataSourceTableSchema", {
      name: "gen_ai_sec_lake_table_schema_data_source",
      knowledgeBaseId: tableSchemaKnowledgeBase.ref,
      dataSourceConfiguration: {
        s3Configuration: {
          bucketArn: bedrockBaseInfraStack.kb_source_s3_bucket.bucketArn,
          inclusionPrefixes: ["table_schema/"],
        },
        type: "S3",
      },
      vectorIngestionConfiguration: {
        chunkingConfiguration: {
          chunkingStrategy: "FIXED_SIZE",
          fixedSizeChunkingConfiguration: {
            maxTokens: 8000,
            overlapPercentage: 1,
          },
        },
      },
    });

    new bedrock.CfnDataSource(this, "genAiSecLakeTableSchemaDataSourceExampleQueries", {
      name: "gen_ai_sec_lake_example_queries_data_source",
      knowledgeBaseId: tableSchemaKnowledgeBase.ref,
      dataSourceConfiguration: {
        s3Configuration: {
          bucketArn: bedrockBaseInfraStack.kb_source_s3_bucket.bucketArn,
          inclusionPrefixes: ["example_queries/"],
        },
        type: "S3",
      },
      vectorIngestionConfiguration: {
        chunkingConfiguration: {
          chunkingStrategy: "HIERARCHICAL",
          hierarchicalChunkingConfiguration: {
            levelConfigurations: [{ maxTokens: 1500 }, { maxTokens: 700 }],
            overlapTokens: 200,
          },
        },
      },
    });

    const runbooksKnowledgeBase = new bedrock.CfnKnowledgeBase(this, "gen_ai_sec_lake_runbooks_kb", {
      knowledgeBaseConfiguration: {
        type: "VECTOR",
        vectorKnowledgeBaseConfiguration: {
          embeddingModelArn: `arn:aws:bedrock:${this.region}::foundation-model/amazon.titan-embed-text-v1`,
        },
      },
      name: "gen-ai-sec-lake-runbooks",
      roleArn: bedrockBaseInfraStack.bedrock_kbs_role.roleArn,
      storageConfiguration: {
        type: "OPENSEARCH_SERVERLESS",
        opensearchServerlessConfiguration: {
          collectionArn: bedrockBaseInfraStack.genAiSecLakerunbooksOpsc.attrArn,
          vectorIndexName: "bedrock-knowledge-base-default-index",
          fieldMapping: {
            metadataField: "AMAZON_BEDROCK_METADATA",
            textField: "AMAZON_BEDROCK_TEXT_CHUNK",
            vectorField: "bedrock-knowledge-base-default-vector",
          },
        },
      },
    });
    runbooksKnowledgeBase.node.addDependency(bedrockBaseInfraStack.runbooksIndexResource);

    new bedrock.CfnDataSource(this, "genAiSecLakeTableSchemaDataSourceRunbooks", {
      name: "gen_ai_sec_lake_runbooks_data_source",
      knowledgeBaseId: runbooksKnowledgeBase.ref,
      dataSourceConfiguration: {
        s3Configuration: {
          bucketArn: bedrockBaseInfraStack.kb_source_s3_bucket.bucketArn,
          inclusionPrefixes: ["runbooks/"],
        },
        type: "S3",
      },
    });

    this.tableSchemaKnowledgeBaseId = tableSchemaKnowledgeBase.attrKnowledgeBaseId;
    this.runbooksKnowledgeBaseId = runbooksKnowledgeBase.attrKnowledgeBaseId;

    new CfnOutput(this, "TableSchemaKnowledgeBaseId", {
      value: this.tableSchemaKnowledgeBaseId,
      description: "Knowledge Base ID for Security Lake table schema and example query documents",
    });

    new CfnOutput(this, "RunbooksKnowledgeBaseId", {
      value: this.runbooksKnowledgeBaseId,
      description: "Knowledge Base ID for security incident response runbook documents",
    });

    NagSuppressions.addStackSuppressions(this, [
      {
        id: "AwsSolutions-IAM4",
        reason: "Suppressing CDK-generated provider policies for demo infrastructure",
      },
      {
        id: "AwsSolutions-IAM5",
        reason: "Suppressing CDK-generated provider wildcard policies for demo infrastructure",
      },
    ]);
  }
}
