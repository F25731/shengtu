#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import getpass
import json
import mimetypes
import re
import sys
import time
from pathlib import Path
from typing import Optional, Tuple
from urllib import error, request


DEFAULT_BASE_URL = "https://backgrace.com/v1"
DEFAULT_MODEL = "gemini-3-pro-image-preview"
DEFAULT_PROMPT = "生成一张郑州城市宣传海报，竖版构图，现代旅游海报风格"


def data_url_from_file(path: Path) -> str:
    data = path.read_bytes()
    mime = mimetypes.guess_type(str(path))[0] or "image/png"
    return f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"


def guess_ext(mime: Optional[str]) -> str:
    if not mime:
        return ".png"
    if "jpeg" in mime or "jpg" in mime:
        return ".jpg"
    if "webp" in mime:
        return ".webp"
    if "gif" in mime:
        return ".gif"
    return ".png"


def maybe_b64_image(value: str) -> Optional[Tuple[bytes, Optional[str]]]:
    text = value.strip()
    data_url = re.match(r"^data:(image/[^;]+);base64,(.+)$", text, re.S)
    if data_url:
        return base64.b64decode(data_url.group(2)), data_url.group(1)

    compact = re.sub(r"\s+", "", text)
    if len(compact) < 500:
        return None
    if not re.fullmatch(r"[A-Za-z0-9+/=]+", compact):
        return None
    try:
        decoded = base64.b64decode(compact, validate=True)
    except Exception:
        return None
    if decoded.startswith(b"\x89PNG"):
        return decoded, "image/png"
    if decoded.startswith(b"\xff\xd8\xff"):
        return decoded, "image/jpeg"
    if decoded.startswith(b"RIFF") and b"WEBP" in decoded[:20]:
        return decoded, "image/webp"
    return None


def walk_images(obj, images, urls, previews, path="$"):
    if isinstance(obj, dict):
        for key, value in obj.items():
            key_lower = str(key).lower()
            next_path = f"{path}.{key}"
            if key_lower in {"b64_json", "base64", "image_base64", "data"} and isinstance(value, str):
                found = maybe_b64_image(value)
                if found:
                    images.append((next_path, found[0], found[1]))
                    continue
            if key_lower in {"url", "image_url"}:
                if isinstance(value, str) and value.startswith(("http://", "https://", "data:image/")):
                    if value.startswith("data:image/"):
                        found = maybe_b64_image(value)
                        if found:
                            images.append((next_path, found[0], found[1]))
                    else:
                        urls.append((next_path, value))
                    continue
                if isinstance(value, dict):
                    walk_images(value, images, urls, previews, next_path)
                    continue
            walk_images(value, images, urls, previews, next_path)
        return

    if isinstance(obj, list):
        for index, item in enumerate(obj):
            walk_images(item, images, urls, previews, f"{path}[{index}]")
        return

    if isinstance(obj, str):
        text = obj.strip()
        found = maybe_b64_image(text)
        if found:
            images.append((path, found[0], found[1]))
            return

        for mime, data in re.findall(r"data:(image/[^;]+);base64,([A-Za-z0-9+/=\s]+)", text):
            try:
                images.append((path, base64.b64decode(re.sub(r"\s+", "", data)), mime))
            except Exception:
                pass

        for url in re.findall(r"!\[[^\]]*\]\((https?://[^)\s]+)\)", text):
            urls.append((path, url))
        for url in re.findall(r"https?://[^\s)\"']+\.(?:png|jpg|jpeg|webp|gif)(?:\?[^\s)\"']*)?", text, re.I):
            urls.append((path, url))

        if text.startswith(("{", "[")):
            try:
                walk_images(json.loads(text), images, urls, previews, path + "(json)")
                return
            except Exception:
                pass

        if text and len(previews) < 5:
            previews.append((path, text[:500]))


def main() -> int:
    parser = argparse.ArgumentParser(description="Probe BackGrace Gemini image response shape.")
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--prompt", default=DEFAULT_PROMPT)
    parser.add_argument("--image", type=Path, help="Optional reference image path.")
    parser.add_argument("--timeout", type=int, default=300)
    parser.add_argument("--out-dir", type=Path, default=Path(__file__).resolve().parent)
    args = parser.parse_args()

    api_key = getpass.getpass("BackGrace API Key: ").strip()
    if not api_key:
        print("No API key provided.", file=sys.stderr)
        return 2

    content = args.prompt
    if args.image:
        content = [
            {"type": "text", "text": args.prompt},
            {"type": "image_url", "image_url": {"url": data_url_from_file(args.image)}},
        ]

    payload = {
        "model": args.model,
        "stream": False,
        "messages": [{"role": "user", "content": content}],
    }

    url = args.base_url.rstrip("/") + "/chat/completions"
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
    )

    started = time.time()
    print(f"POST {url}")
    print(f"model={args.model}")
    print(f"prompt={args.prompt}")

    try:
        with request.urlopen(req, timeout=args.timeout) as resp:
            status = resp.status
            raw = resp.read()
            headers = dict(resp.headers.items())
    except error.HTTPError as exc:
        status = exc.code
        raw = exc.read()
        headers = dict(exc.headers.items()) if exc.headers else {}
    except Exception as exc:
        print(f"Request failed: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1

    elapsed = time.time() - started
    args.out_dir.mkdir(parents=True, exist_ok=True)
    raw_path = args.out_dir / "gemini_test_last_response.json"
    raw_path.write_bytes(raw)

    print(f"status={status} elapsed={elapsed:.1f}s bytes={len(raw)}")
    print(f"content-type={headers.get('Content-Type') or headers.get('content-type')}")
    print(f"raw_saved={raw_path}")

    try:
        data = json.loads(raw.decode("utf-8"))
    except Exception:
        print(raw[:2000].decode("utf-8", errors="replace"))
        return 0 if 200 <= status < 300 else 1

    print(f"top_keys={list(data.keys())}")
    if isinstance(data.get("choices"), list):
        print(f"choices_count={len(data['choices'])}")

    images = []
    urls = []
    previews = []
    walk_images(data, images, urls, previews)

    for index, (where, image_bytes, mime) in enumerate(images, start=1):
        path = args.out_dir / f"gemini_test_output_{index}{guess_ext(mime)}"
        path.write_bytes(image_bytes)
        print(f"image_saved[{index}]={path} source={where} mime={mime} bytes={len(image_bytes)}")

    for index, (where, image_url) in enumerate(urls[:10], start=1):
        print(f"image_url[{index}] source={where}: {image_url}")

    if previews:
        print("text_previews:")
        for where, preview in previews:
            print(f"- {where}: {preview}")

    if not images and not urls:
        print("No image payload detected in the response.")

    return 0 if 200 <= status < 300 else 1


if __name__ == "__main__":
    raise SystemExit(main())
