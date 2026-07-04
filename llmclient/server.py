from __future__ import annotations

from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException

from llmclient.config import (
    MODEL_CATALOG,
    configured_models,
    default_db_path,
    default_model_id,
    env_value,
    find_model,
    llmclient_api_key,
)
from llmclient.providers import run_analysis
from llmclient.schemas import AnalysisRunRequest, AnalysisRunResponse
from llmclient.providers_knowledge_points import (
    run_direct_multimodal,
    run_text_only,
    run_ocr_enhanced,
)


app = FastAPI(title="Project-X LLM Client", version="0.2.0")


def require_internal_key(authorization: str | None = Header(default=None)) -> None:
    expected = llmclient_api_key()
    if not expected:
        return
    if authorization != f"Bearer {expected}":
        raise HTTPException(status_code=401, detail="Invalid llmclient internal API key")


@app.get("/health")
def health() -> dict[str, object]:
    db_path = default_db_path()
    models = configured_models()
    return {
        "ok": True,
        "dbPath": str(db_path),
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

    if not default_db_path().exists():
        raise HTTPException(status_code=400, detail=f"Project-X database not found: {default_db_path()}")

    try:
        return run_analysis(model, request.examId, request.classId, request.locale, provider_dict)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"{model.provider} analysis failed: {exc}") from exc


@app.post("/analysis/knowledge-points")
def knowledge_points(
    request: dict,
    _: None = Depends(require_internal_key),
) -> dict:
    """Analyze exam paper for knowledge points per question (v1.7.0).

    Supports three modes:
    - direct: multimodal model reads images directly
    - text: pre-extracted text sent to model
    - ocr: vision model transcribes → reasoning model analyzes
    """
    mode = request.get("mode", "text")
    subject = request.get("subject", "")
    question_range = request.get("questionRange", "全部")
    extra_notes = request.get("extraNotes", "")
    files = request.get("files", [])
    paper_text = request.get("paperText", "")

    # Get primary provider
    provider_id = request.get("providerId")
    if not provider_id:
        raise HTTPException(status_code=400, detail="providerId required")

    # TODO: Read provider from ai_providers table via DB
    # For now, use env defaults based on mode
    if mode == "direct":
        try:
            result = run_direct_multimodal(
                model=find_model(default_model_id()) or MODEL_CATALOG[0],
                files=files,
                subject=subject,
                question_range=question_range,
                extra_notes=extra_notes,
            )
            return result
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"Direct analysis failed: {exc}") from exc

    if mode == "ocr":
        ocr_provider_id = request.get("ocrProviderId")
        if not ocr_provider_id:
            raise HTTPException(status_code=400, detail="ocrProviderId required for OCR mode")
        try:
            result = run_ocr_enhanced(
                vision_model=find_model("gemini-3.1-flash-lite") or MODEL_CATALOG[0],
                reasoning_model=find_model(default_model_id()) or MODEL_CATALOG[0],
                files=files,
                subject=subject,
                question_range=question_range,
                extra_notes=extra_notes,
            )
            return result
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"OCR analysis failed: {exc}") from exc

    # Text mode (default)
    if not paper_text:
        raise HTTPException(status_code=400, detail="paperText required for text mode")
    try:
        result = run_text_only(
            model=find_model(default_model_id()) or MODEL_CATALOG[0],
            paper_text=paper_text[:32000],
            subject=subject,
            question_range=question_range,
            extra_notes=extra_notes,
        )
        return result
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Text analysis failed: {exc}") from exc


@app.get("/debug/config")
def debug_config(_: None = Depends(require_internal_key)) -> dict[str, object]:
    return {
        "dbPath": str(default_db_path()),
        "defaultModel": default_model_id(),
        "catalog": [model.model_dump(exclude={"key_env"}) for model in MODEL_CATALOG],
    }
