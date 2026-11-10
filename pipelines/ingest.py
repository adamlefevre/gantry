#!/usr/bin/env python3
import os
import sys
import duckdb
from dotenv import load_dotenv

load_dotenv()

REQUIRED_VARS = ["CLOUDFLARE_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME"]
missing = [var for var in REQUIRED_VARS if not os.getenv(var)]
if missing:
    print(f"Error: Missing required environment variables: {', '.join(missing)}", file=sys.stderr)
    sys.exit(1)

ACCOUNT_ID = os.environ["CLOUDFLARE_ACCOUNT_ID"]
KEY_ID = os.environ["R2_ACCESS_KEY_ID"]
SECRET_KEY = os.environ["R2_SECRET_ACCESS_KEY"]
BUCKET_NAME = os.environ["R2_BUCKET_NAME"]

SOURCE_PARQUET_URL = "https://d37ci6vzurychx.cloudfront.net/trip-data/yellow_tripdata_2024-01.parquet"
TARGET_R2_PATH = f"r2://{BUCKET_NAME}/data/year=2024/month=01/yellow_trips.parquet"

def main():
    con = duckdb.connect()
    con.execute("INSTALL httpfs; LOAD httpfs;")
    con.execute(f"""
        CREATE OR REPLACE SECRET r2_lake (
            TYPE R2,
            KEY_ID '{KEY_ID}',
            SECRET '{SECRET_KEY}',
            ACCOUNT_ID '{ACCOUNT_ID}'
        );
    """)

    print(f"Streaming data directly from CloudFront source into Cloudflare R2:")
    print(f"  Source: {SOURCE_PARQUET_URL}")
    print(f"  Target: {TARGET_R2_PATH}")

    query = f"""
        COPY (
            SELECT 
                VendorID AS vendor_id,
                tpep_pickup_datetime AS pickup_datetime,
                tpep_dropoff_datetime AS dropoff_datetime,
                passenger_count,
                trip_distance,
                PULocationID AS pickup_location_id,
                DOLocationID AS dropoff_location_id,
                payment_type,
                fare_amount,
                tip_amount,
                total_amount
            FROM read_parquet('{SOURCE_PARQUET_URL}')
            WHERE trip_distance > 0 AND total_amount > 0
            LIMIT 500000
        ) TO '{TARGET_R2_PATH}' (FORMAT PARQUET, COMPRESSION 'SNAPPY');
    """
    con.execute(query)
    print("Ingestion completed successfully.")

if __name__ == "__main__":
    main()
