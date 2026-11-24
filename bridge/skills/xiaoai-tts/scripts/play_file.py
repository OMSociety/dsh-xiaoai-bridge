#!/usr/bin/env python3
"""
上传并播放本地音频文件
"""

import os
import sys
import argparse
import uuid
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from api_client import api_request


def play_file(file_path, blocking=False):
    """
    上传并播放本地音频文件
    
    Args:
        file_path: 本地音频文件路径
        blocking: 是否阻塞等待（默认 False）
    """
    if not os.path.exists(file_path):
        raise Exception(f"文件不存在: {file_path}")
    
    boundary = uuid.uuid4().hex
    with open(file_path, "rb") as f:
        file_data = f.read()
    
    filename = os.path.basename(file_path)
    
    body = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'
        f"Content-Type: audio/mpeg\r\n\r\n"
    ).encode("utf-8")
    body += file_data
    body += f"\r\n--{boundary}--\r\n".encode("utf-8")
    
    return api_request(f"/api/play/file?blocking={str(blocking).lower()}", method="POST",
                       data=body, content_type=f"multipart/form-data; boundary={boundary}", timeout=60)


def main():
    parser = argparse.ArgumentParser(description="上传并播放本地音频文件")
    parser.add_argument("file", help="本地音频文件路径")
    parser.add_argument("--blocking", action="store_true",
                        help="阻塞等待播放完成（默认非阻塞）")
    
    args = parser.parse_args()
    
    try:
        result = play_file(args.file, blocking=args.blocking)
        if result.get("success"):
            print("播放完成" if args.blocking else "桥接器已受理播报")
        else:
            print(f"⚠️ 播放可能失败: {result}")
    except Exception as e:
        print(f"❌ 错误: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
