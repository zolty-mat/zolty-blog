#!/usr/bin/env python3
"""Upload media files to S3 for the blog."""

import argparse
import boto3
import mimetypes
import os
from pathlib import Path

S3_BUCKET = os.environ.get(
    "S3_BUCKET_NAME", "zolty-blog-content-855878721457"
)
AWS_REGION = "us-east-1"


def upload_file(file_path: Path, s3_prefix: str = "media/photos") -> str:
    s3 = boto3.client("s3", region_name=AWS_REGION)

    content_type, _ = mimetypes.guess_type(str(file_path))
    if content_type is None:
        content_type = "application/octet-stream"

    s3_key = f"{s3_prefix}/{file_path.name}"

    s3.upload_file(
        str(file_path),
        S3_BUCKET,
        s3_key,
        ExtraArgs={
            "ContentType": content_type,
            "CacheControl": "public, max-age=31536000, immutable",
        },
    )

    print(f"Uploaded: s3://{S3_BUCKET}/{s3_key}")
    return s3_key


def main():
    parser = argparse.ArgumentParser(description="Upload media to S3")
    parser.add_argument("files", nargs="+", type=Path, help="Files to upload")
    parser.add_argument(
        "--prefix",
        default="media/photos",
        help="S3 key prefix (default: media/photos)",
    )
    args = parser.parse_args()

    for file_path in args.files:
        if not file_path.exists():
            print(f"Skipping (not found): {file_path}")
            continue
        upload_file(file_path, args.prefix)


if __name__ == "__main__":
    main()
