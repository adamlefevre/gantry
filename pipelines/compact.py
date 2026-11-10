#!/usr/bin/env python3
import os
import sys
import uuid
from collections import defaultdict
from typing import Dict, List
import boto3
from botocore.config import Config
import duckdb
from dotenv import load_dotenv

load_dotenv()

SMALL_FILE_THRESHOLD_BYTES = 32 * 1024 * 1024   # 32 MB
TARGET_BATCH_BYTES = 128 * 1024 * 1024          # 128 MB
OPTIMAL_ROW_GROUP_SIZE = 122880                 # ~120k rows

ACCOUNT_ID = os.environ.get("CLOUDFLARE_ACCOUNT_ID")
KEY_ID = os.environ.get("R2_ACCESS_KEY_ID")
SECRET_KEY = os.environ.get("R2_SECRET_ACCESS_KEY")
BUCKET_NAME = os.environ.get("R2_BUCKET_NAME")
R2_ENDPOINT_URL = f"https://{ACCOUNT_ID}.r2.cloudflarestorage.com" if ACCOUNT_ID else ""

def get_s3_client():
    return boto3.client(
        "s3",
        endpoint_url=R2_ENDPOINT_URL,
        aws_access_key_id=KEY_ID,
        aws_secret_access_key=SECRET_KEY,
        region_name="auto",
        config=Config(signature_version="s3v4")
    )

def init_duckdb() -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    con.execute("INSTALL httpfs; LOAD httpfs;")
    con.execute(f"""
        CREATE OR REPLACE SECRET r2_creds (
            TYPE R2,
            KEY_ID '{KEY_ID}',
            SECRET '{SECRET_KEY}',
            ACCOUNT_ID '{ACCOUNT_ID}'
        );
    """)
    return con

def discover_small_files(s3_client, prefix: str = "data/") -> Dict[str, List[dict]]:
    paginator = s3_client.get_paginator("list_objects_v2")
    partitions = defaultdict(list)
    for page in paginator.paginate(Bucket=BUCKET_NAME, Prefix=prefix):
        for obj in page.get("Contents", []):
            key = obj["Key"]
            size = obj["Size"]
            if not key.endswith(".parquet") or "compacted-" in key:
                continue
            if size < SMALL_FILE_THRESHOLD_BYTES:
                partition_dir = os.path.dirname(key)
                partitions[partition_dir].append({
                    "key": key,
                    "size": size,
                    "r2_url": f"r2://{BUCKET_NAME}/{key}"
                })
    return partitions

def pack_batches(file_list: List[dict], max_batch_size: int) -> List[List[dict]]:
    batches, current_batch, current_size = [], [], 0
    for file_info in file_list:
        if current_size + file_info["size"] > max_batch_size and current_batch:
            batches.append(current_batch)
            current_batch, current_size = [], 0
        current_batch.append(file_info)
        current_size += file_info["size"]
    if current_batch:
        batches.append(current_batch)
    return batches

def compact_partition_batch(con: duckdb.DuckDBPyConnection, partition_dir: str, batch: List[dict]):
    if len(batch) < 2:
        return
    input_urls = [f["r2_url"] for f in batch]
    formatted_urls = ", ".join(f"'{u}'" for u in input_urls)
    compacted_id = uuid.uuid4().hex[:8]
    output_key = f"{partition_dir}/compacted-{compacted_id}.parquet"
    output_url = f"r2://{BUCKET_NAME}/{output_key}"

    query = f"""
        COPY (
            SELECT * FROM read_parquet([{formatted_urls}])
        ) TO '{output_url}' (
            FORMAT PARQUET,
            COMPRESSION 'SNAPPY',
            ROW_GROUP_SIZE {OPTIMAL_ROW_GROUP_SIZE}
        );
    """
    con.execute(query)

    orig_rows = con.execute(f"SELECT count(*) FROM read_parquet([{formatted_urls}])").fetchone()[0]
    new_rows = con.execute(f"SELECT count(*) FROM read_parquet('{output_url}')").fetchone()[0]
    if orig_rows != new_rows:
        raise ValueError(f"Integrity check failed! Expected {orig_rows} rows, got {new_rows}")

    s3_client = get_s3_client()
    delete_objects = [{"Key": f["key"]} for f in batch]
    s3_client.delete_objects(
        Bucket=BUCKET_NAME,
        Delete={"Objects": delete_objects, "Quiet": True}
    )

def main():
    s3_client = get_s3_client()
    con = init_duckdb()
    partitioned_files = discover_small_files(s3_client)
    for partition_dir, files in partitioned_files.items():
        batches = pack_batches(files, TARGET_BATCH_BYTES)
        for batch in batches:
            compact_partition_batch(con, partition_dir, batch)

if __name__ == "__main__":
    main()
