import os
import json
import boto3
from opensearchpy import OpenSearch, RequestsHttpConnection
from requests_aws4auth import AWS4Auth
import re
import time


def wait_for_index(client, index_name, attempts=24, delay_seconds=5):
    for attempt in range(1, attempts + 1):
        if client.indices.exists(index=index_name):
            print(f"Index is available: {index_name}")
            return

        print(f"Waiting for index {index_name} to become available. Attempt {attempt}/{attempts}")
        time.sleep(delay_seconds)

    raise TimeoutError(f"Timed out waiting for index {index_name} to become available")

def lambda_handler(event, context):
    print(f"Received event: {json.dumps(event)}")

    request_type = event.get("RequestType", "Create")
    props = event.get("ResourceProperties", event)
    host_https = props['OPENSEARCH_HTTPS_ENDPOINT']
    index_name = props['INDEX_NAME']

    physical_resource_id = f"{host_https}/{index_name}"
    if request_type == "Delete":
        return {"PhysicalResourceId": physical_resource_id}

    region = os.environ['AWS_REGION']

    host = re.sub(r"https?://", "", host_https)

    service = 'aoss'
    credentials = boto3.Session().get_credentials()
    awsauth = AWS4Auth(credentials.access_key, credentials.secret_key, region, service, session_token=credentials.token)

    client = OpenSearch(
        hosts=[{'host': host, 'port': 443}],
        http_auth=awsauth,
        use_ssl=True,
        verify_certs=True,
        connection_class=RequestsHttpConnection
    )

    index_body = {
        'settings': {"index": {"knn": True}},
        "mappings": {
            "properties": {
                "bedrock-knowledge-base-default-vector": {
                    "type": "knn_vector",
                    "dimension": 1536,
                    "method": {
                        "name": "hnsw",
                        "engine": "faiss",
                        "parameters": {"ef_construction": 512, "m": 16},
                        "space_type": "l2",
                    },
                },
                "AMAZON_BEDROCK_METADATA": {"type": "text", "index": "false"},
                "AMAZON_BEDROCK_TEXT_CHUNK": {"type": "text", "index": "true"},
                "id": {"type": "text", "index": "true"},
                "x-amz-bedrock-kb-data-source-id": {"type": "text", "index": "true"},
                "x-amz-bedrock-kb-source-uri": {"type": "text", "index": "true"},
            }
        }
    }

    if client.indices.exists(index=index_name):
        return {
            'PhysicalResourceId': physical_resource_id,
            'Data': {'IndexName': index_name}
        }

    try:
        response = client.indices.create(index=index_name, body=index_body)
        print(f'Index creation response: {json.dumps(response)}')
    except Exception as e:
        if "resource_already_exists_exception" not in str(e):
            print(f'Error creating index: {str(e)}')
            raise

        print(f'Index already exists: {index_name}')

    wait_for_index(client, index_name)

    return {
        'PhysicalResourceId': physical_resource_id,
        'Data': {'IndexName': index_name}
    }
