from __future__ import annotations

import os
from pathlib import Path
from typing import Literal

from dotenv import load_dotenv
from pydantic import BaseModel


ROOT_DIR = Path(__file__).resolve().parent
REPO_DIR = ROOT_DIR.parent


load_dotenv(ROOT_DIR / ".env")


Provider = Literal["gemini", "deepseek", "openai"]


class ModelConfig(BaseModel):
    id: str
    provider: Provider
    label: str
    key_env: str
    thinking: bool = True
    reasoning_effort: str | None = None


MODEL_CATALOG: list[ModelConfig] = [
    ModelConfig(
        id="gemini-3.1-flash-lite",
        provider="gemini",
        label="Gemini 3.1 Flash-Lite",
        key_env="GEMINI_API_KEY",
        thinking=True,
    ),
    ModelConfig(
        id="gemini-3.5-flash",
        provider="gemini",
        label="Gemini 3.5 Flash",
        key_env="GEMINI_API_KEY",
        thinking=True,
    ),
    ModelConfig(
        id="deepseek-v4-flash",
        provider="deepseek",
        label="DeepSeek V4 Flash",
        key_env="DEEPSEEK_API_KEY",
        thinking=True,
        reasoning_effort="high",
    ),
    ModelConfig(
        id="deepseek-v4-pro",
        provider="deepseek",
        label="DeepSeek V4 Pro",
        key_env="DEEPSEEK_API_KEY",
        thinking=True,
        reasoning_effort="high",
    ),
    ModelConfig(
        id="gpt-5.5",
        provider="openai",
        label="GPT 5.5",
        key_env="OPENAI_API_KEY",
        thinking=True,
        reasoning_effort="high",
    ),
    ModelConfig(
        id="gpt-5.4",
        provider="openai",
        label="GPT 5.4",
        key_env="OPENAI_API_KEY",
        thinking=True,
        reasoning_effort="high",
    ),
    ModelConfig(
        id="gpt-5.5-pro",
        provider="openai",
        label="GPT 5.5 Pro",
        key_env="OPENAI_API_KEY",
        thinking=True,
        reasoning_effort="high",
    ),
    ModelConfig(
        id="gpt-5.4-mini",
        provider="openai",
        label="GPT 5.4 Mini",
        key_env="OPENAI_API_KEY",
        thinking=True,
        reasoning_effort="high",
    ),
]


def env_value(name: str) -> str:
    return os.environ.get(name, "").strip()


def default_db_path() -> Path:
    configured = env_value("PROJECTX_DB_PATH")
    if configured:
        path = Path(configured)
        return path if path.is_absolute() else (ROOT_DIR / path).resolve()
    return (REPO_DIR / "data" / "projectx.db").resolve()


def llmclient_api_key() -> str:
    return env_value("LLMCLIENT_INTERNAL_API_KEY")


def default_model_id() -> str:
    configured = env_value("LLMCLIENT_DEFAULT_MODEL")
    if configured and find_model(configured):
        return configured
    return "gemini-3.1-flash-lite"


def find_model(model_id: str) -> ModelConfig | None:
    return next((model for model in MODEL_CATALOG if model.id == model_id), None)


def configured_models() -> list[dict[str, object]]:
    models: list[dict[str, object]] = []
    for model in MODEL_CATALOG:
        available = bool(env_value(model.key_env))
        models.append(
            {
                "id": model.id,
                "provider": model.provider,
                "label": model.label,
                "available": available,
                "thinking": model.thinking,
            }
        )
    return models

