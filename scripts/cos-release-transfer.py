#!/usr/bin/env python3
"""把发布制品上传到私有 COS 的 releases/ 目录，并输出给服务器用的临时下载链接。

用法: cos-release-transfer.py <本地文件>...
环境变量: COS_SECRET_ID, COS_SECRET_KEY, COS_BUCKET, COS_REGION (默认 ap-guangzhou),
          COS_PREFIX (默认 releases/), COS_URL_TTL (默认 3600 秒)
输出: 每个文件一行预签名 GET 链接（stdout）。日志走 stderr。链接本身不应打印到日志。
"""
import os
import sys

from qcloud_cos import CosConfig, CosS3Client


def main() -> int:
    files = sys.argv[1:]
    if not files:
        print("usage: cos-release-transfer.py <file>...", file=sys.stderr)
        return 2
    region = os.environ.get("COS_REGION") or "ap-guangzhou"
    bucket = os.environ["COS_BUCKET"]
    prefix = os.environ.get("COS_PREFIX") or "releases/"
    ttl = int(os.environ.get("COS_URL_TTL") or "3600")
    client = CosS3Client(
        CosConfig(
            Region=region,
            SecretId=os.environ["COS_SECRET_ID"],
            SecretKey=os.environ["COS_SECRET_KEY"],
            Scheme="https",
        )
    )
    for path in files:
        key = prefix + os.path.basename(path)
        size = os.path.getsize(path)
        print(f"[cos] upload {os.path.basename(path)} ({size} bytes) -> {key}", file=sys.stderr)
        client.upload_file(Bucket=bucket, Key=key, LocalFilePath=path, PartSize=8, MAXThread=8)
        head = client.head_object(Bucket=bucket, Key=key)
        remote_size = int(head.get("Content-Length", -1))
        if remote_size != size:
            print(f"[cos] FATAL size mismatch for {key}: local={size} remote={remote_size}", file=sys.stderr)
            return 1
        print(client.get_presigned_download_url(Bucket=bucket, Key=key, Expired=ttl))
    return 0


if __name__ == "__main__":
    sys.exit(main())
