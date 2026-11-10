import modal

image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install(
        "duckdb>=1.0.0",
        "boto3>=1.34.0",
        "botocore>=1.34.0"
    )
    .add_local_python_source("pipelines")
)

app = modal.App("gantry-maintenance")
r2_secret = modal.Secret.from_name("r2-credentials")

@app.function(
    image=image,
    secrets=[r2_secret],
    schedule=modal.Cron("0 2 * * *"),
    timeout=900,
    cpu=2.0,
    memory=4096
)
def run_daily_compaction():
    from pipelines.compact import (
        get_s3_client,
        init_duckdb,
        discover_small_files,
        pack_batches,
        compact_partition_batch,
        TARGET_BATCH_BYTES,
    )

    s3_client = get_s3_client()
    con = init_duckdb()

    partitioned_files = discover_small_files(s3_client)
    processed, files_compacted = 0, 0
    for partition_dir, files in partitioned_files.items():
        batches = pack_batches(files, TARGET_BATCH_BYTES)
        for batch in batches:
            compact_partition_batch(con, partition_dir, batch)
            files_compacted += len(batch)
        processed += 1

    return {"status": "success", "processed_partitions": processed, "files_compacted": files_compacted}

@app.local_entrypoint()
def main():
    result = run_daily_compaction.remote()
    print(f"Run completed with result: {result}")
