### 2026-09-03 - Pass 1 backend and CDK rewrite
- Goal: Replace the Bedrock Agents Classic/WebSocket backend path with a single-account, REST API response-streaming backend while keeping the existing Knowledge Base and frontend build structure mostly intact.
- Files changed: `bin/genai-security-lake.ts`, `cdk.context.json`, `lib/bedrock/bedrock-base-infra.ts`, `lib/bedrock/bedrock-kbs-agent.ts`, `lib/frontend/frontend-app.ts`, `lib/frontend/constructs/lambda.ts`, `lib/frontend/constructs/rest-api.ts`, `lib/frontend/constructs/react-app-build.ts`, `lib/frontend/constructs/react-app-deploy.ts`, `lib/frontend/chat-handler/index.ts`, `package.json`, `tsconfig.json`.
- Key changes: Removed deployed Bedrock Agent and action-group Lambda resources; kept two Bedrock Knowledge Bases; added a Node.js 24 streaming chat Lambda that uses Bedrock Converse/ConverseStream, Knowledge Base retrieval, Athena, SQL validation, and configured Security Lake table allowlisting; added API Gateway and CloudFront WAF IP allowlists; added same-account Lake Formation grants for the backend Lambda; made the existing Python index Lambda bundle locally when Docker is unavailable.
- Tests or verification performed: Ran `npm.cmd install --no-audit --no-fund --loglevel info`, `npm.cmd run build`, and `npx cdk synth`. CDK synth completed successfully.
- Notes (no secrets): `allowedClientIpv4Cidr` defaults to `0.0.0.0/32` and should be replaced with the real client CIDR before deployment. Final synth still emits warnings for existing CDK deprecations, cross-stack reference defaults, a cdk-nag intrinsic validation limitation, and CloudFront default-certificate TLS settings.

### 2026-09-08 - Pass 2 frontend streaming REST update
- Goal: Update the React frontend to consume the new REST API streaming backend instead of the removed WebSocket backend.
- Files changed: `lib/frontend/react-app/src/context/ChatStateContext.tsx`, `lib/frontend/react-app/src/components/QueryForm.tsx`, `lib/frontend/react-app/src/components/Message.tsx`, `lib/frontend/react-app/src/types/ChatMessage.tsx`, `lib/frontend/react-app/src/env.d.ts`, `lib/frontend/react-app/.env.template`, `lib/frontend/react-app/package.json`, `lib/frontend/constructs/react-app-build.ts`, `lib/frontend/frontend-app.ts`, `lib/frontend/react-app/src/hooks/useWebSocketApi.ts`, `lib/frontend/react-app/src/types/WebSocketMessage.tsx`, `lib/frontend/constructs/websocket.ts`.
- Key changes: Replaced WebSocket message handling with `fetch` streaming from `POST /message`; parsed newline-delimited backend events for status, SQL, query results, text, errors, and completion; added in-message status display; removed WebSocket environment variable injection and unused WebSocket source files; removed unused frontend streaming/parser dependencies.
- Tests or verification performed: Ran React production build with `npm.cmd run build`, root TypeScript check with `npm.cmd run build`, and `npx cdk synth`. All completed successfully.
- Notes (no secrets): The Vite build still warns about large Cloudscape chunks, but it is not a build failure. CDK synth still emits the pre-existing warnings noted in Pass 1.

### 2026-09-08 - Knowledge Base index deployment ordering fix
- Goal: Fix `BedrockAppStack` failures where Bedrock could not find `bedrock-knowledge-base-default-index` in the OpenSearch Serverless collections.
- Files changed: `lib/bedrock/bedrock-base-infra.ts`, `lib/bedrock/bedrock-kbs-agent.ts`, `lib/bedrock/vector_index_oss/vector_index_oss.py`, `lib/bedrock/vector_index_oss/requirements.txt`.
- Key changes: Made the vector index Lambda idempotent, made index-creation errors fail clearly through a provider-backed custom resource, added a wait loop until OpenSearch reports the index exists, forced index setup to rerun through a custom resource property version, packaged Python dependencies as Lambda-compatible Linux wheels, and made both Bedrock knowledge bases depend on their respective index custom resources.
- Tests or verification performed: Ran `npm.cmd run build` and `npx.cmd cdk synth`. Both completed successfully.
- Notes (no secrets): Redeploy `BedrockBaseInfraStack` before retrying `BedrockAppStack` so the index custom resources rerun with the corrected Lambda package and behavior.

### 2026-09-08 - IPv6 client allowlist support
- Goal: Allow the frontend and REST API WAF rules to permit the user's IPv6 client address in addition to the existing IPv4 CIDR.
- Files changed: `lib/frontend/frontend-app.ts`, `lib/frontend/constructs/react-app-deploy.ts`, `lib/frontend/constructs/rest-api.ts`.
- Key changes: Added optional `allowedClientIpv6Cidr` context support, created separate IPv6 IP sets when the value is present, and changed both WAF allowlist rules to allow requests that match either the IPv4 or IPv6 client CIDR.
- Tests or verification performed: Ran `npm.cmd run build` and `npx.cmd cdk synth`. Both completed successfully.
