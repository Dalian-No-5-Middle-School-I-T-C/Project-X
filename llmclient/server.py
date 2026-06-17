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


app = FastAPI(title="Project-X LLM Client", version="0.1.0")


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
    model_id = request.model or default_model_id()
    model = find_model(model_id)
    if model is None:
        raise HTTPException(status_code=400, detail=f"Unknown model: {model_id}")
    if not env_value(model.key_env):
        raise HTTPException(status_code=400, detail=f"Missing {model.key_env} for model {model.id}")
    if not default_db_path().exists():
        raise HTTPException(status_code=400, detail=f"Project-X database not found: {default_db_path()}")
    try:
        return run_analysis(model, request.examId, request.classId, request.locale)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"{model.provider} analysis failed: {exc}") from exc


@app.get("/debug/config")
def debug_config(_: None = Depends(require_internal_key)) -> dict[str, object]:
    return {
        "dbPath": str(default_db_path()),
        "defaultModel": default_model_id(),
        "catalog": [model.model_dump(exclude={"key_env"}) for model in MODEL_CATALOG],
    }

