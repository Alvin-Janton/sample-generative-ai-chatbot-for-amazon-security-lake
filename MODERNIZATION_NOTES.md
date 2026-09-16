# Modernization Notes

This file summarizes the major changes made in this fork of the AWS sample `sample-generative-ai-chatbot-for-amazon-security-lake`.

The original project used a multi-account Security Lake subscriber architecture, Bedrock Agents Classic, and WebSocket-based response delivery. This fork modernizes the project for a single-account AWS environment and replaces the agent/runtime path with application-owned code that uses current Amazon Bedrock Converse APIs.

## Architecture Changes

### Original Architecture

The original sample expected:

- A dedicated Amazon Security Lake account.
- A separate subscriber account where the chatbot app was deployed.
- Resource Access Manager shares from the Security Lake account.
- Lake Formation resource links in the subscriber account.
- Manual Lake Formation grants after deployment.
- A Bedrock Agent with an action group Lambda.
- A WebSocket API for streaming responses to the React frontend.

### Modernized Architecture

This fork expects:

- Amazon Security Lake in the same account as the chatbot app.
- Security Lake sources already configured.
- Existing Security Lake Glue database and table names supplied through CDK context.
- Lake Formation permissions granted directly to the backend Lambda role.
- A REST API and streaming Lambda integration instead of WebSockets.
- A Lambda-owned agent loop using Bedrock Converse, Knowledge Base retrieval, Athena, and SQL validation.
- CloudFront and API Gateway access restricted by WAF client IP allowlists.

## Bedrock Agent Replacement

The original Bedrock Agent and action group were removed.

The backend Lambda in `lib/frontend/chat-handler/index.ts` now owns the agent flow:

1. Retrieve schema and example-query context from a Bedrock Knowledge Base.
2. Retrieve runbook context from a second Bedrock Knowledge Base.
3. Ask the configured model to produce a compact query plan with Bedrock Converse.
4. Validate generated SQL against local safety rules.
5. Execute safe read-only SQL in Athena.
6. Stream the final answer with Bedrock ConverseStream.

This avoids Bedrock Agents Classic, which may not be available to new users, while preserving the core behavior of a tool-using security analysis assistant.

## REST Streaming Replacement

The original WebSocket path was replaced by:

- API Gateway REST API.
- `POST /message` endpoint.
- Lambda response streaming.
- Newline-delimited JSON events consumed by the React frontend.

The frontend receives event types for status updates, generated SQL, query results, streamed answer text, errors, and completion.

## Security and Access Changes

Key security changes:

- CloudFront is protected by a WAF WebACL that blocks clients outside the configured IPv4/IPv6 CIDRs.
- API Gateway is protected by a regional WAF WebACL with the same client CIDR controls.
- The API requires an API key stored in SSM Parameter Store and injected into the React build by CodeBuild.
- The frontend S3 bucket blocks public access and is served through CloudFront Origin Access Control.
- The backend Lambda allows Athena queries only against configured Security Lake table names.
- Generated SQL is blocked unless it is a read-only `SELECT` or `WITH` statement.

This remains a demo architecture and does not include full user authentication such as Cognito.

## Knowledge Base Changes

The fork keeps two Bedrock Knowledge Bases:

- `gen-ai-sec-lake-table-schema`
- `gen-ai-sec-lake-runbooks`

The Knowledge Bases use:

- S3 data sources populated from `lib/bedrock/kb_source_data`.
- OpenSearch Serverless vector collections.
- Titan text embeddings.
- Lambda-backed custom resources to create the required OpenSearch vector indexes before Knowledge Base creation.

The CDK app creates the Knowledge Bases and data sources, but ingestion jobs must still be started after deployment.

## Security Lake Schema Workflow

Security Lake table schemas vary by account, region, enabled source, and OCSF version.

This fork includes:

```text
scripts/generate_security_lake_schemas.py
```

Use it to regenerate Knowledge Base schema JSON files from Glue metadata:

```powershell
python -m pip install boto3
npm run generate:security-lake-schemas -- --prune
```

The script reads `securityLakeRegion`, `securityLakeDatabaseName`, and `securityLakeTableNames` from `cdk.context.json`.

## CDK Context

Important context keys:

- `securityLakeRegion`
- `securityLakeDatabaseName`
- `securityLakeTableNames`
- `allowedClientIpv4Cidr`
- `allowedClientIpv6Cidr`
- `bedrockModelId`
- `athenaWorkgroupName`
- `maxAthenaRows`
- `maxAthenaWaitSeconds`

Do not publish personal IP addresses, account IDs, or cached CDK lookup values in a reusable fork.

## Frontend Build and Hosting

The frontend workflow was kept mostly automated:

- The React source is uploaded to S3 under `source/`.
- CodeBuild runs `npm ci` and `npm run build`.
- Build artifacts are written to `dist/`.
- CloudFront serves the `dist/` prefix through Origin Access Control.

The React app now uses REST streaming instead of WebSocket state management.

## Validation Performed During Modernization

The rewritten application was validated with:

- `npm install`
- `npm run build`
- `npx cdk synth`
- React production build
- Successful deployment of the three stacks
- CloudFront frontend access after WAF IPv4/IPv6 allowlist updates
- Knowledge Base ingestion for schema, example query, and runbook data sources
- Live chat testing against Athena and Bedrock

## Known Operational Notes

- Knowledge Base ingestion is manual after deployment.
- CloudFront can cache stale frontend assets; invalidate `/*` if the app shows old behavior.
- OpenSearch Serverless and NAT Gateway can incur ongoing charges.
- CDK/cdk-nag may emit warnings that do not block synthesis or deployment.
- Some unused legacy files from the original WebSocket/Bedrock Agent path may remain in the repository for reference but are not wired into the active CDK deployment.


