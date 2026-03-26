"""
api_server.py  (v2 — Orchestrator Agent)
==========================================
FastAPI server backed by DisasterOrchestratorAgent.

Every query goes through the LLM-driven agent which decides
at runtime which of the 4 data-source tools to call.
"""
import os
import logging
from dotenv import load_dotenv
load_dotenv()
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from orchestrator_agent import DisasterOrchestratorAgent, AgentConfig, AgentResponse

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

agent: DisasterOrchestratorAgent | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global agent
    logger.info("Starting Disaster Orchestrator Agent ...")
    agent = DisasterOrchestratorAgent(config=AgentConfig())
    await agent.build()
    logger.info("Agent ready")
    yield
    logger.info("Shutdown")


app = FastAPI(
    title="Disaster Management RAG — Orchestrator Agent API",
    description=(
        "LLM-driven orchestrator agent for disaster management. "
        "Dynamically routes each query to the right data sources: "
        "live news, government alerts, weather reports, or instruction manual."
    ),
    version="2.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class QueryRequest(BaseModel):
    query: str = Field(..., example="There is heavy flooding in Mumbai. What should I do?")
    chat_history: Optional[list[dict]] = Field(default=None)


class ToolCallRecord(BaseModel):
    tool_name: str
    tool_input: dict
    result_count: int


class ToolSummary(BaseModel):
    tool_name: str
    calls: int
    total_docs: int


class SourceItem(BaseModel):
    title: str
    source_type: str
    url: str
    published_at: str


class TraceItem(BaseModel):
    title: str
    source_type: str
    relevance_score: float
    key_phrases: list[str]
    snippet: str
    retrieval_explanation: str


class QueryResponse(BaseModel):
    answer: str
    urgency_level: str
    sources: list[SourceItem]
    tool_calls_made: list[ToolCallRecord]
    tool_results_summary: list[ToolSummary]
    retrieval_trace: list[TraceItem]
    replan_count: int
    metadata: dict


class HealthResponse(BaseModel):
    status: str
    agent_ready: bool
    tools_available: list[str]


@app.get("/health", response_model=HealthResponse, tags=["System"])
async def health():
    tool_names = [t.name for t in agent.tools] if agent and agent.tools else []
    return HealthResponse(
        status="ok",
        agent_ready=agent is not None and agent._ready,
        tools_available=tool_names,
    )


@app.post("/query", response_model=QueryResponse, tags=["Agent"])
async def query_endpoint(request: QueryRequest):
    """
    Submit a disaster query to the orchestrator agent.
    The agent decides which tools to call, retrieves live data,
    and returns a grounded, cited answer with full tool trace.
    """
    if agent is None or not agent._ready:
        raise HTTPException(status_code=503, detail="Agent not ready")
    if not request.query.strip():
        raise HTTPException(status_code=400, detail="Query cannot be empty")

    lc_history = []
    for msg in (request.chat_history or []):
        role = msg.get("role", "")
        content = msg.get("content", "")
        if role == "user":
            from langchain_core.messages import HumanMessage
            lc_history.append(HumanMessage(content=content))
        elif role == "assistant":
            from langchain_core.messages import AIMessage
            lc_history.append(AIMessage(content=content))

    try:
        result: AgentResponse = await agent.query(
            user_query=request.query,
            chat_history=lc_history,
        )
    except Exception as exc:
        logger.error(f"Agent error: {exc}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return QueryResponse(
        answer=result.answer,
        urgency_level=result.urgency_level,
        sources=[SourceItem(**s) for s in result.sources],
        tool_calls_made=[ToolCallRecord(**tc) for tc in result.tool_calls_made],
        tool_results_summary=[ToolSummary(**ts) for ts in result.tool_results_summary],
        retrieval_trace=[TraceItem(**t) for t in result.retrieval_trace],
        replan_count=result.replan_count,
        metadata=result.metadata,
    )


@app.get("/tools", tags=["System"])
async def list_tools():
    if agent is None or not agent.tools:
        raise HTTPException(status_code=503, detail="Agent not ready")
    return {"tools": [{"name": t.name, "description": t.description} for t in agent.tools]}


@app.post("/manual/reindex", tags=["Ingestion"])
async def reindex_manual(background_tasks: BackgroundTasks):
    """Re-index the static instruction manual PDF. Live sources need no re-indexing."""
    if agent is None:
        raise HTTPException(status_code=503, detail="Agent not initialised")

    async def _reindex():
        import shutil
        if os.path.exists(agent.cfg.chroma_persist_dir):
            shutil.rmtree(agent.cfg.chroma_persist_dir)
        agent.manual_vectorstore = await agent._build_manual_index([])
        for tool in (agent.tools or []):
            if tool.name == "search_instruction_manual":
                tool.vectorstore = agent.manual_vectorstore
        logger.info("Manual re-indexed")

    background_tasks.add_task(_reindex)
    return {"message": "Manual re-indexing started in background"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("api_server:app", host="0.0.0.0",
                port=int(os.environ.get("PORT", 8000)), reload=False)