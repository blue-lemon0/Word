#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""LLM 调用骨架。

Key 读取优先级：
  1. 环境变量 DEEPSEEK_API_KEY
  2. 本地文件  scripts/.llm_key  （不入库）
  3. 本地文件  C:/Users/<user>/.config/kaoyan_llm_key

支持 OpenAI 兼容协议（DeepSeek / 智谱 / 通义 等），通过模型名和 base url 切换。
"""
import os
import sys
import time

DEFAULT_BASE_URL = "https://api.deepseek.com"
DEFAULT_MODEL = "deepseek-chat"
REQUEST_TIMEOUT = 90
MAX_RETRIES = 3


def resolve_key():
    key = os.environ.get("DEEPSEEK_API_KEY", "").strip()
    if key:
        return key
    candidates = [
        os.path.join(os.path.dirname(os.path.abspath(__file__)), ".llm_key"),
        os.path.join(os.path.expanduser("~"), ".config", "kaoyan_llm_key"),
    ]
    for p in candidates:
        if os.path.exists(p):
            with open(p, encoding="utf-8") as f:
                k = f.read().strip()
            if k:
                return k
    return None


def get_client():
    """返回 (client, model, base_url)。无 key 时抛带指引的异常。"""
    import openai

    key = resolve_key()
    if not key:
        raise RuntimeError(
            "未找到 LLM API Key。请设置环境变量 DEEPSEEK_API_KEY，"
            "或将 key 写入 scripts/.llm_key 或 ~/.config/kaoyan_llm_key"
        )
    base_url = os.environ.get("LLM_BASE_URL", DEFAULT_BASE_URL)
    model = os.environ.get("LLM_MODEL", DEFAULT_MODEL)
    client = openai.OpenAI(api_key=key, base_url=base_url)
    return client, model


def chat_json(client, model, system, user, temperature=0.2):
    """调用 LLM 并解析 JSON 输出。带超时与重试，避免挂起请求拖垮整批。"""
    import json

    last_err = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            resp = client.chat.completions.create(
                model=model,
                temperature=temperature,
                timeout=REQUEST_TIMEOUT,
                messages=[
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
                response_format={"type": "json_object"},
            )
            text = resp.choices[0].message.content
            try:
                return json.loads(text)
            except json.JSONDecodeError as e:
                raise RuntimeError(f"JSON 解析失败: {e}\n原始输出: {text[:500]}")
        except (RuntimeError, Exception) as e:
            last_err = e
            if attempt < MAX_RETRIES:
                time.sleep(2 * attempt)
    raise RuntimeError(f"请求失败(重试{MAX_RETRIES}次): {last_err}")


def main():
    try:
        client, model = get_client()
    except RuntimeError as e:
        print(f"[ERROR] {e}", file=sys.stderr)
        sys.exit(1)
    print(f"client OK, model={model}")


if __name__ == "__main__":
    main()