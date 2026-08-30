from __future__ import annotations

import logging
from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException

logger = logging.getLogger("llmclient")

from llmclient.config import (
    MODEL_CATALOG,
    configured_models,
    default_db_path,
    default_model_id,
    env_value,
    find_model,
    llmclient_api_key,
    mariadb_config,
    mariadb_configured,
)
from llmclient.providers import run_analysis
from llmclient.schemas import AnalysisRunRequest, AnalysisRunResponse
from llmclient.providers_knowledge_points import (
    run_direct_multimodal,
    run_text_only,
)


app = FastAPI(title="Project-X LLM Client", version="0.2.0")


def require_internal_key(authorization: str | None = Header(default=None)) -> None:
    expected = llmclient_api_key()
    # 安全审计（F-4）：内部密钥未配置时拒绝所有请求（而非放行），
    # 避免服务被端口转发/改绑 0.0.0.0 后完全开放。
    if not expected:
        raise HTTPException(status_code=503, detail="LLMCLIENT_INTERNAL_API_KEY not configured; server refuses to serve requests")
    if authorization != f"Bearer {expected}":
        raise HTTPException(status_code=401, detail="Invalid llmclient internal API key")


@app.get("/health")
def health() -> dict[str, object]:
    # 安全审计（F-12-9）：脱敏 —— 不对外返回 dbHost/dbName/dbPath 等内网细节，仅暴露存活与可用性布尔值。
    # 安全审计（P1）：internalAuthConfigured 如实反映内部密钥是否已配置 —— 未配置时受保护端点返回 503，
    # 供 Node /ai/status 判断内置 LLM 是否真的可用，避免前端误判"服务可用"。
    db_path = default_db_path()
    models = configured_models()
    db_ok = False
    if mariadb_configured():
        try:
            from llmclient.tools.grades import connect_db

            with connect_db() as conn:
                row = conn.execute("SELECT 1 AS ok").fetchone()
            db_ok = bool(row and row["ok"] == 1)
        except Exception:
            db_ok = False
        return {
            "ok": True,
            "dbDialect": "mariadb",
            "internalAuthConfigured": bool(llmclient_api_key()),
            "dbExists": db_ok,
            "defaultModel": default_model_id(),
            "models": models,
        }
    return {
        "ok": True,
        "dbDialect": "sqlite",
        "internalAuthConfigured": bool(llmclient_api_key()),
        "dbExists": Path(db_path).exists(),
        "defaultModel": default_model_id(),
        "models": models,
    }


@app.get("/models")
def models(_: None = Depends(require_internal_key)) -> dict[str, object]:
    return {
        "defaultModel": default_model_id(),
        "models": configured_models(),
    }


@app.post("/analysis/run", response_model=AnalysisRunResponse)
def analysis_run(request: AnalysisRunRequest, _: None = Depends(require_internal_key)) -> AnalysisRunResponse:
    provider_override = request.providerOverride
    model_id = request.model or default_model_id()

    if provider_override and provider_override.api_key:
        # Dynamic provider: use model name directly, create synthetic ModelConfig
        from llmclient.config import ModelConfig
        model = ModelConfig(
            id=model_id,
            provider=provider_override.provider_type or "openai",
            label=f"{provider_override.provider_type}/{model_id}",
            key_env="",  # not used — override provides the key
            thinking=False,
        )
        provider_dict = {
            "provider_type": provider_override.provider_type,
            "base_url": provider_override.base_url,
            "api_key": provider_override.api_key,
        }
    else:
        model = find_model(model_id)
        if model is None:
            raise HTTPException(status_code=400, detail=f"Unknown model: {model_id}")
        if not env_value(model.key_env):
            raise HTTPException(status_code=400, detail=f"Missing {model.key_env} for model {model.id}")
        provider_dict = None

    if not mariadb_configured() and not default_db_path().exists():
        raise HTTPException(status_code=400, detail=f"Project-X database not found: {default_db_path()}")

    group_exam_ids: set[int] | None = None
    if request.groupId is not None:
        from llmclient.tools.grades import get_group_exam_ids

        member_ids = get_group_exam_ids(request.groupId)
        if not member_ids:
            raise HTTPException(status_code=400, detail=f"Exam group {request.groupId} has no member exams")
        group_exam_ids = set(member_ids)
    elif request.examId is None:
        raise HTTPException(status_code=400, detail="examId or groupId is required")

    try:
        return run_analysis(model, request.examId, request.classId, request.locale, provider_dict, group_exam_ids)
    except HTTPException:
        raise
    except Exception as exc:
        # 安全审计（F-12-1）：异常原文仅写日志，响应返回通用信息，避免泄漏 URL/密钥片段
        logger.exception("analysis/run failed for model %s", model.id)
        raise HTTPException(status_code=502, detail="analysis failed; see server logs") from exc


@app.post("/analysis/knowledge-points")
def knowledge_points(
    request: dict,
    _: None = Depends(require_internal_key),
) -> dict:
    """Analyze exam paper for knowledge points per question (v1.7.0).

    Supports two modes:
    - direct: multimodal model reads images directly
    - text: pre-extracted text sent to model
    """
    mode = request.get("mode", "text")
    subject = request.get("subject", "")
    question_range = request.get("questionRange", "全部")
    extra_notes = request.get("extraNotes", "")
    files = request.get("files", [])
    paper_text = request.get("paperText", "")
    provider_override = request.get("providerOverride")
    model_id = request.get("model") or default_model_id()

    if provider_override and provider_override.get("api_key"):
        from llmclient.config import ModelConfig

        provider_type = provider_override.get("provider_type") or "openai"
        if provider_type not in {"gemini", "deepseek", "openai"}:
            provider_type = "openai"
        model = ModelConfig(
            id=model_id,
            provider=provider_type,
            label=f"{provider_type}/{model_id}",
            key_env="",
            thinking=False,
        )
    else:
        model = find_model(model_id) or MODEL_CATALOG[0]

    # Get primary provider
    provider_id = request.get("providerId")
    if not provider_id:
        raise HTTPException(status_code=400, detail="providerId required")

    # TODO: Read provider from ai_providers table via DB
    # For now, use env defaults based on mode
    if mode == "direct":
        try:
            result = run_direct_multimodal(
                model=model,
                files=files,
                subject=subject,
                question_range=question_range,
                extra_notes=extra_notes,
                provider_override=provider_override,
            )
            return result
        except Exception as exc:
            logger.exception("knowledge-points direct analysis failed for model %s", model.id)
            raise HTTPException(status_code=502, detail="Direct analysis failed; see server logs") from exc

    # Text mode (default)
    if not paper_text:
        raise HTTPException(status_code=400, detail="paperText required for text mode")
    try:
        result = run_text_only(
            model=model,
            paper_text=paper_text[:32000],
            subject=subject,
            question_range=question_range,
            extra_notes=extra_notes,
            provider_override=provider_override,
        )
        return result
    except Exception as exc:
        logger.exception("knowledge-points text analysis failed for model %s", model.id)
        raise HTTPException(status_code=502, detail="Text analysis failed; see server logs") from exc


@app.get("/debug/config")
def debug_config(_: None = Depends(require_internal_key)) -> dict[str, object]:
    return {
        "dbPath": str(default_db_path()),
        "defaultModel": default_model_id(),
        "catalog": [model.model_dump(exclude={"key_env"}) for model in MODEL_CATALOG],
    }
