#!/usr/bin/env python3
"""Generate Bedrock KB table schema files from AWS Glue metadata."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


DEFAULT_CONTEXT_PATH = Path(__file__).resolve().parents[1] / "cdk.context.json"
DEFAULT_OUTPUT_DIR = (
    Path(__file__).resolve().parents[1]
    / "lib"
    / "bedrock"
    / "kb_source_data"
    / "table_schema"
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Generate Knowledge Base table schema JSON files from the AWS Glue "
            "Data Catalog. Defaults are read from cdk.context.json."
        )
    )
    parser.add_argument(
        "--context",
        type=Path,
        default=DEFAULT_CONTEXT_PATH,
        help=f"Path to cdk.context.json. Default: {DEFAULT_CONTEXT_PATH}",
    )
    parser.add_argument(
        "--database",
        help="Glue database name. Overrides securityLakeDatabaseName from context.",
    )
    parser.add_argument(
        "--region",
        help="AWS region for Glue. Overrides securityLakeRegion from context.",
    )
    parser.add_argument(
        "--table",
        action="append",
        dest="tables",
        help=(
            "Glue table name to export. Can be provided multiple times. "
            "Overrides securityLakeTableNames from context."
        ),
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=DEFAULT_OUTPUT_DIR,
        help=f"Directory for generated JSON files. Default: {DEFAULT_OUTPUT_DIR}",
    )
    parser.add_argument(
        "--prune",
        action="store_true",
        help="Delete existing JSON schema files in the output directory that are not configured.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Fetch Glue metadata and print the files that would be written without changing files.",
    )
    return parser.parse_args()


def load_context(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    with path.open("r", encoding="utf-8") as context_file:
        return json.load(context_file)


def context_value(context: dict[str, Any], key: str, nested_key: str | None = None) -> Any:
    if key in context:
        return context[key]
    security_lake = context.get("securityLake")
    if nested_key and isinstance(security_lake, dict):
        return security_lake.get(nested_key)
    return None


def resolve_config(args: argparse.Namespace, context: dict[str, Any]) -> tuple[str, str, list[str]]:
    database = args.database or context_value(
        context, "securityLakeDatabaseName", "databaseName"
    )
    region = args.region or context_value(context, "securityLakeRegion", "region")
    tables = args.tables or context_value(context, "securityLakeTableNames", "tableNames")

    if not database:
        raise ValueError(
            "Missing Glue database name. Set securityLakeDatabaseName in cdk.context.json "
            "or pass --database."
        )
    if not region:
        raise ValueError(
            "Missing AWS region. Set securityLakeRegion in cdk.context.json or pass --region."
        )
    if not tables:
        raise ValueError(
            "Missing table list. Set securityLakeTableNames in cdk.context.json "
            "or pass --table one or more times."
        )
    if not isinstance(tables, list) or not all(isinstance(table, str) for table in tables):
        raise ValueError("securityLakeTableNames must be a list of table name strings.")

    normalized_tables = sorted({table.strip() for table in tables if table.strip()})
    if not normalized_tables:
        raise ValueError("The configured table list is empty.")

    return database, region, normalized_tables


def compact_dict(value: dict[str, Any], keys: list[str]) -> dict[str, Any]:
    return {key: value[key] for key in keys if key in value and value[key] not in (None, "")}


def column_to_schema(column: dict[str, Any]) -> dict[str, str]:
    schema = {"name": column["Name"], "type": column["Type"]}
    comment = column.get("Comment")
    if comment:
        schema["description"] = comment
    return schema


def table_to_schema(database: str, table: dict[str, Any]) -> dict[str, Any]:
    storage_descriptor = table.get("StorageDescriptor", {})
    serde_info = storage_descriptor.get("SerdeInfo", {})
    generated_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat()

    schema = {
        "table_name": f"{database}.{table['Name']}",
        "database_name": database,
        "table_name_only": table["Name"],
        "description": table.get("Description")
        or table.get("Parameters", {}).get("comment")
        or f"Glue Data Catalog schema for {database}.{table['Name']}.",
        "generated_from": "aws_glue_get_table",
        "generated_at_utc": generated_at,
        "table_type": table.get("TableType"),
        "columns": [
            column_to_schema(column)
            for column in storage_descriptor.get("Columns", [])
        ],
        "partition_keys": [
            column_to_schema(column)
            for column in table.get("PartitionKeys", [])
        ],
        "storage": compact_dict(
            storage_descriptor,
            ["Location", "InputFormat", "OutputFormat", "Compressed", "NumberOfBuckets"],
        ),
        "serde": compact_dict(
            serde_info,
            ["Name", "SerializationLibrary", "Parameters"],
        ),
        "parameters": table.get("Parameters", {}),
    }

    return {key: value for key, value in schema.items() if value not in (None, {}, [])}


def write_schema(path: Path, schema: dict[str, Any], dry_run: bool) -> None:
    if dry_run:
        print(f"Would write {path}")
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as schema_file:
        json.dump(schema, schema_file, indent=2, sort_keys=False)
        schema_file.write("\n")
    print(f"Wrote {path}")


def prune_stale_files(output_dir: Path, expected_files: set[Path], dry_run: bool) -> None:
    if not output_dir.exists():
        return
    for existing_file in sorted(output_dir.glob("*.json")):
        if existing_file not in expected_files:
            if dry_run:
                print(f"Would delete stale schema {existing_file}")
            else:
                existing_file.unlink()
                print(f"Deleted stale schema {existing_file}")


def generate_schemas(
    database: str,
    region: str,
    tables: list[str],
    output_dir: Path,
    prune: bool,
    dry_run: bool,
) -> None:
    try:
        import boto3
        from botocore.config import Config
        from botocore.exceptions import ClientError
    except ImportError as exc:
        raise RuntimeError(
            "The schema generator requires boto3. Install it with "
            "`python -m pip install boto3` and retry."
        ) from exc

    session = boto3.Session(region_name=region)
    glue = session.client(
        "glue",
        config=Config(
            retries={"max_attempts": 5, "mode": "adaptive"},
            connect_timeout=5,
            read_timeout=30,
        ),
    )

    expected_files: set[Path] = set()
    for table_name in tables:
        try:
            response = glue.get_table(DatabaseName=database, Name=table_name)
        except glue.exceptions.EntityNotFoundException as exc:
            raise ValueError(
                f"Glue table {database}.{table_name} was not found in {region}."
            ) from exc
        except ClientError as exc:
            raise RuntimeError(
                f"Glue GetTable failed for {database}.{table_name}: {exc}"
            ) from exc

        schema = table_to_schema(database, response["Table"])
        output_path = output_dir / f"{table_name}.json"
        expected_files.add(output_path)
        write_schema(output_path, schema, dry_run=dry_run)

    if prune:
        prune_stale_files(output_dir, expected_files, dry_run=dry_run)


def main() -> int:
    args = parse_args()
    try:
        context = load_context(args.context)
        database, region, tables = resolve_config(args, context)
        generate_schemas(
            database=database,
            region=region,
            tables=tables,
            output_dir=args.output_dir,
            prune=args.prune,
            dry_run=args.dry_run,
        )
        return 0
    except (RuntimeError, OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
