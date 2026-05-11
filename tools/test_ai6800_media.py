#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import getpass
import json
import mimetypes
import os
import re
import sys
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple
from urllib import error, parse, request


DEFAULT_BASE_URL = "https://api.ai6800.com"
DEFAULT_MODEL = "gpt-image-2"
DEFAULT_PROMPT = "生成一张郑州城市宣传海报，竖版构图，现代旅游海报风格"


def guess_ext(content_type: Optional[str], url: str = "") -> str:
    text = (content_type or "").lower()
    if "jpeg" in text or "jpg" in text:
        return ".jpg"
    if "png" in text:
        return ".png"
    if "webp" in text:
        return ".webp"
    if "gif" in text:
        return ".gif"
    suffix = Path(parse.urlparse(url).path).suffix.lower()
    if suffix in {".jpg", ".jpeg", ".png", ".webp", ".gif"}:
        return ".jpg" if suffix == ".jpeg" else suffix
    return ".png"


def data_url_from_file(path: Path) -> str:
    data = path.read_bytes()
    mime = mimetypes.guess_type(str(path))[0] or "image/png"
    return f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"


def normalize_image_inputs(items: Optional[List[str]]) -> List[str]:
    result: List[str] = []
    for item in items or []:
        text = item.strip()
        if not text:
            continue
        if text.startswith(("http://", "https://", "data:image/")):
            result.append(text)
            continue
        path = Path(text)
        if not path.exists():
            raise FileNotFoundError(f"参考图不存在：{text}")
        result.append(data_url_from_file(path))
    return result


def read_api_key(name: str) -> str:
    value = os.environ.get("AI6800_API_KEY") or os.environ.get("API_KEY")
    if value:
        return value.strip()
    return getpass.getpass(f"{name} API Key: ").strip()


def post_json(url: str, api_key: str, payload: Dict[str, Any], timeout: int) -> Tuple[int, bytes, Dict[str, str]]:
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
    try:
        with request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read(), dict(resp.headers.items())
    except error.HTTPError as exc:
        return exc.code, exc.read(), dict(exc.headers.items()) if exc.headers else {}


def get_json(url: str, api_key: str, timeout: int) -> Tuple[int, bytes, Dict[str, str]]:
    req = request.Request(
        url,
        method="GET",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Accept": "application/json",
        },
    )
    try:
        with request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read(), dict(resp.headers.items())
    except error.HTTPError as exc:
        return exc.code, exc.read(), dict(exc.headers.items()) if exc.headers else {}


def download_binary(url: str, api_key: str, timeout: int) -> Tuple[int, bytes, Dict[str, str]]:
    headers = {"Accept": "image/*,*/*"}
    if "api.ai6800.com" in url:
        headers["Authorization"] = f"Bearer {api_key}"
    req = request.Request(url, method="GET", headers=headers)
    try:
        with request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read(), dict(resp.headers.items())
    except error.HTTPError as exc:
        return exc.code, exc.read(), dict(exc.headers.items()) if exc.headers else {}


def try_json(raw: bytes) -> Any:
    try:
        return json.loads(raw.decode("utf-8"))
    except Exception:
        return None


def build_media_payload(args: argparse.Namespace, images: List[str]) -> Dict[str, Any]:
    model = args.model
    params: Dict[str, Any] = {}

    if model.startswith("gemini"):
        params["aspectRatio"] = args.aspect_ratio
        params["imageSize"] = args.image_size
        if images:
            params["images"] = images[:14]
    else:
        params["size"] = args.size
        if model == "gpt-image-2" and args.quality:
            params["quality"] = args.quality
        if images:
            params["images"] = images[:10 if model == "gpt-image-2" else 1]

    if args.payload_style == "params":
        return {
            "model": model,
            "prompt": args.prompt,
            "params": params,
        }

    payload: Dict[str, Any] = {
        "model": model,
        "prompt": args.prompt,
    }
    payload.update(params)
    if model == "gpt-image-2":
        payload.setdefault("background", "opaque")
        payload.setdefault("n", args.n)
    elif model.startswith("grok"):
        payload.setdefault("n", args.n)
        payload.setdefault("response_format", "url")
    return payload


def find_task_id(data: Any) -> Optional[str]:
    if not isinstance(data, dict):
        return None
    for key in ("task_id", "taskId", "id"):
        value = data.get(key)
        if isinstance(value, (str, int)) and str(value):
            return str(value)
    nested = data.get("data")
    if isinstance(nested, dict):
        return find_task_id(nested)
    return None


def looks_like_url(value: str) -> bool:
    return value.startswith(("http://", "https://", "data:image/"))


def collect_urls(obj: Any, found: Optional[List[Tuple[str, str]]] = None, path: str = "$") -> List[Tuple[str, str]]:
    if found is None:
        found = []
    if isinstance(obj, dict):
        for key, value in obj.items():
            next_path = f"{path}.{key}"
            if isinstance(value, str) and looks_like_url(value):
                found.append((next_path, value))
            else:
                collect_urls(value, found, next_path)
    elif isinstance(obj, list):
        for index, item in enumerate(obj):
            collect_urls(item, found, f"{path}[{index}]")
    elif isinstance(obj, str):
        for url in re.findall(r"https?://[^\s)\"']+", obj):
            found.append((path, url))
    return found


def collect_base64_images(obj: Any, found: Optional[List[Tuple[str, bytes, str]]] = None, path: str = "$") -> List[Tuple[str, bytes, str]]:
    if found is None:
        found = []
    if isinstance(obj, dict):
        for key, value in obj.items():
            next_path = f"{path}.{key}"
            if isinstance(value, str):
                maybe_add_base64(value, found, next_path)
            else:
                collect_base64_images(value, found, next_path)
    elif isinstance(obj, list):
        for index, item in enumerate(obj):
            collect_base64_images(item, found, f"{path}[{index}]")
    elif isinstance(obj, str):
        maybe_add_base64(obj, found, path)
    return found


def maybe_add_base64(value: str, found: List[Tuple[str, bytes, str]], path: str) -> None:
    text = value.strip()
    data_url = re.match(r"^data:(image/[^;]+);base64,(.+)$", text, re.S)
    if data_url:
        found.append((path, base64.b64decode(re.sub(r"\s+", "", data_url.group(2))), data_url.group(1)))
        return
    compact = re.sub(r"\s+", "", text)
    if len(compact) < 500 or not re.fullmatch(r"[A-Za-z0-9+/=]+", compact):
        return
    try:
        data = base64.b64decode(compact, validate=True)
    except Exception:
        return
    if data.startswith(b"\x89PNG"):
        found.append((path, data, "image/png"))
    elif data.startswith(b"\xff\xd8\xff"):
        found.append((path, data, "image/jpeg"))
    elif data.startswith(b"RIFF") and b"WEBP" in data[:20]:
        found.append((path, data, "image/webp"))


def save_outputs(data: Any, api_key: str, out_dir: Path, prefix: str, timeout: int) -> int:
    saved = 0
    for where, image_bytes, mime in collect_base64_images(data):
        saved += 1
        path = out_dir / f"{prefix}_output_{saved}{guess_ext(mime)}"
        path.write_bytes(image_bytes)
        print(f"image_saved[{saved}]={path} source={where} mime={mime} bytes={len(image_bytes)}")

    seen_urls = set()
    for where, url in collect_urls(data):
        if url in seen_urls:
            continue
        seen_urls.add(url)
        if url.startswith("data:image/"):
            maybe: List[Tuple[str, bytes, str]] = []
            maybe_add_base64(url, maybe, where)
            for _, image_bytes, mime in maybe:
                saved += 1
                path = out_dir / f"{prefix}_output_{saved}{guess_ext(mime)}"
                path.write_bytes(image_bytes)
                print(f"image_saved[{saved}]={path} source={where} mime={mime} bytes={len(image_bytes)}")
            continue
        status, raw, headers = download_binary(url, api_key, timeout)
        content_type = headers.get("Content-Type") or headers.get("content-type")
        if status == 200 and raw:
            saved += 1
            path = out_dir / f"{prefix}_output_{saved}{guess_ext(content_type, url)}"
            path.write_bytes(raw)
            print(f"image_downloaded[{saved}]={path} source={where} status={status} type={content_type} bytes={len(raw)}")
        else:
            print(f"image_url source={where} status={status}: {url}")
    return saved


def print_response_summary(label: str, status: int, raw: bytes, headers: Dict[str, str], elapsed: float, path: Path) -> Any:
    print(f"{label}_status={status} elapsed={elapsed:.1f}s bytes={len(raw)}")
    print(f"{label}_content_type={headers.get('Content-Type') or headers.get('content-type')}")
    print(f"{label}_raw_saved={path}")
    data = try_json(raw)
    if isinstance(data, dict):
        print(f"{label}_top_keys={list(data.keys())}")
        error_obj = data.get("error")
        if error_obj:
            print(f"{label}_error={json.dumps(error_obj, ensure_ascii=False)[:1000]}")
    elif data is None:
        print(raw[:1000].decode("utf-8", errors="replace"))
    return data


def poll_media_task(args: argparse.Namespace, api_key: str, task_id: str) -> Any:
    status_url = f"{args.base_url.rstrip('/')}/v1/media/status?{parse.urlencode({'task_id': task_id})}"
    deadline = time.time() + args.max_wait
    last_data: Any = None
    attempt = 0
    while time.time() < deadline:
        attempt += 1
        started = time.time()
        status, raw, headers = get_json(status_url, api_key, args.timeout)
        elapsed = time.time() - started
        raw_path = args.out_dir / f"ai6800_status_{task_id}_{attempt}.json"
        raw_path.write_bytes(raw)
        data = print_response_summary(f"poll[{attempt}]", status, raw, headers, elapsed, raw_path)
        last_data = data
        if not isinstance(data, dict) or status < 200 or status >= 300:
            raise RuntimeError(f"轮询失败，HTTP={status}")

        state = str(data.get("state") or "").lower()
        is_final = bool(data.get("is_final"))
        print(f"task_id={task_id} state={state} is_final={is_final} progress={data.get('progress')} status_text={data.get('status')}")
        if is_final:
            if state == "success":
                return data
            raise RuntimeError(f"任务失败：{data.get('error') or data.get('status') or data}")

        time.sleep(args.poll_interval)
    raise TimeoutError(f"超过 {args.max_wait} 秒仍未完成，最后状态：{last_data}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Test ai6800 /v1/media/generate image task API.")
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    parser.add_argument("--model", default=DEFAULT_MODEL, help="gpt-image-2 / gemini-3-pro-image-preview / grok-4.2-image")
    parser.add_argument("--prompt", default=DEFAULT_PROMPT)
    parser.add_argument("--image", action="append", help="参考图 URL、本地路径或 data URL，可重复传。")
    parser.add_argument("--payload-style", choices=["flat", "params"], default="flat", help="flat 按文档示例平铺参数；params 按 model/prompt/params 三段式。")
    parser.add_argument("--size", default="1024x1536")
    parser.add_argument("--quality", default="auto")
    parser.add_argument("--aspect-ratio", default="2:3")
    parser.add_argument("--image-size", default="2K")
    parser.add_argument("--n", type=int, default=1)
    parser.add_argument("--timeout", type=int, default=60)
    parser.add_argument("--max-wait", type=int, default=900)
    parser.add_argument("--poll-interval", type=int, default=5)
    parser.add_argument("--out-dir", type=Path, default=Path(__file__).resolve().parent)
    args = parser.parse_args()

    args.out_dir.mkdir(parents=True, exist_ok=True)
    api_key = read_api_key("ai6800")
    if not api_key:
        print("没有输入 API Key。", file=sys.stderr)
        return 2

    images = normalize_image_inputs(args.image)
    payload = build_media_payload(args, images)
    submit_url = f"{args.base_url.rstrip('/')}/v1/media/generate"
    print(f"POST {submit_url}")
    print(f"model={args.model}")
    print(f"payload_style={args.payload_style}")
    print(f"prompt={args.prompt}")
    print("payload=" + json.dumps(payload, ensure_ascii=False))

    started = time.time()
    try:
        status, raw, headers = post_json(submit_url, api_key, payload, args.timeout)
    except Exception as exc:
        print(f"提交失败：{type(exc).__name__}: {exc}", file=sys.stderr)
        return 1
    elapsed = time.time() - started

    submit_path = args.out_dir / "ai6800_submit_last_response.json"
    submit_path.write_bytes(raw)
    data = print_response_summary("submit", status, raw, headers, elapsed, submit_path)
    if status < 200 or status >= 300:
        return 1
    if data is None:
        return 1

    task_id = find_task_id(data)
    if task_id:
        print(f"task_id={task_id}")
        try:
            final_data = poll_media_task(args, api_key, task_id)
        except Exception as exc:
            print(f"轮询失败：{type(exc).__name__}: {exc}", file=sys.stderr)
            return 1
        final_path = args.out_dir / f"ai6800_final_{task_id}.json"
        final_path.write_text(json.dumps(final_data, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"final_saved={final_path}")
        saved = save_outputs(final_data, api_key, args.out_dir, f"ai6800_{args.model}_{task_id}", args.timeout)
        if not saved:
            print("任务成功，但没有检测到可下载图片。请打开 final JSON 看 result_url/result 字段。")
        return 0

    saved = save_outputs(data, api_key, args.out_dir, f"ai6800_{args.model}_sync", args.timeout)
    if not saved:
        print("没有发现 task_id 或图片结果，请查看提交响应 JSON。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
