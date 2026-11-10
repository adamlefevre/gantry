import os
import uuid
import pytest
import duckdb
from dotenv import load_dotenv

from pipelines.compact import (
    get_s3_client,
    init_duckdb,
    discover_small_files,
    pack_batches,
    compact_partition_batch,
    TARGET_BATCH_BYTES,
)

load_dotenv()

TEST_RUN_ID = uuid.uuid4().hex[:8]
TEST_PARTITION = f"data/test_runs/run_{TEST_RUN_ID}"
NUM_MICRO_FILES = 5
ROWS_PER_FILE = 2_000

@pytest.fixture(scope="module")
def r2_client():
    return get_s3_client()

@pytest.fixture(scope="module")
def duck_conn():
    return init_duckdb()

@pytest.fixture(scope="module")
def bucket_name():
    name = os.getenv("R2_BUCKET_NAME")
    assert name, "R2_BUCKET_NAME environment variable is not set."
    return name

@pytest.fixture(scope="module", autouse=True)
def ephemeral_partition(r2_client, duck_conn, bucket_name):
    for i in range(NUM_MICRO_FILES):
        file_key = f"{TEST_PARTITION}/micro_batch_{i:02d}.parquet"
        target_url = f"r2://{bucket_name}/{file_key}"
        query = f"""
            COPY (
                SELECT 
                    ({i} * {ROWS_PER_FILE} + range)::INT AS trip_id,
                    (1 + (range % 2))::INT AS vendor_id,
                    TIMESTAMP '2024-01-01 00:00:00' + INTERVAL (range) SECOND AS pickup_datetime,
                    round((5.0 + (range % 50) * 0.75)::DECIMAL(10,2), 2) AS fare_amount
                FROM range({ROWS_PER_FILE})
            ) TO '{target_url}' (FORMAT PARQUET, COMPRESSION 'SNAPPY');
        """
        duck_conn.execute(query)

    yield TEST_PARTITION

    paginator = r2_client.get_paginator("list_objects_v2")
    objects_to_delete = []
    for page in paginator.paginate(Bucket=bucket_name, Prefix=TEST_PARTITION):
        for obj in page.get("Contents", []):
            objects_to_delete.append({"Key": obj["Key"]})

    if objects_to_delete:
        r2_client.delete_objects(
            Bucket=bucket_name,
            Delete={"Objects": objects_to_delete, "Quiet": True}
        )

def test_compaction_reduces_files_and_preserves_rows(r2_client, duck_conn, bucket_name, ephemeral_partition):
    partitioned_files = discover_small_files(r2_client, prefix=ephemeral_partition)
    assert ephemeral_partition in partitioned_files
    initial_files = partitioned_files[ephemeral_partition]
    assert len(initial_files) == NUM_MICRO_FILES

    initial_urls = [f["r2_url"] for f in initial_files]
    formatted_urls = ", ".join(f"'{u}'" for u in initial_urls)
    pre_compact_count = duck_conn.execute(
        f"SELECT count(*) FROM read_parquet([{formatted_urls}])"
    ).fetchone()[0]

    expected_total_rows = NUM_MICRO_FILES * ROWS_PER_FILE
    assert pre_compact_count == expected_total_rows

    batches = pack_batches(initial_files, TARGET_BATCH_BYTES)
    compact_partition_batch(duck_conn, ephemeral_partition, batches[0])

    response = r2_client.list_objects_v2(Bucket=bucket_name, Prefix=ephemeral_partition)
    remaining_objects = response.get("Contents", [])

    assert len(remaining_objects) == 1
    compacted_key = remaining_objects[0]["Key"]
    assert "compacted-" in compacted_key

    compacted_url = f"r2://{bucket_name}/{compacted_key}"
    post_compact_count = duck_conn.execute(
        f"SELECT count(*) FROM read_parquet('{compacted_url}')"
    ).fetchone()[0]

    assert post_compact_count == pre_compact_count == expected_total_rows
