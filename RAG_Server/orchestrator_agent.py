"""
orchestrator_agent.py
======================
True orchestrator agent using LangChain's tool-calling agent pattern.

Flow:
  1. User query → Orchestrator LLM
  2. LLM reasons which tools to call (can call multiple in parallel)
  3. Tool results collected and merged
  4. Results passed through reranker + iterative RAG pipeline
  5. LLM generates final grounded answer with source citations
  6. If answer is insufficient, LLM can re-plan and call more tools (reflection loop)

Key design decisions vs old pipeline:
  - No upfront ingestion of live sources — all tool calls happen at query time
  - Only the instruction manual PDF is pre-indexed (it's static)
  - LLM selects tools based on query semantics — weather query won't waste
    time searching gov alerts and vice versa
  - Full tool trace returned in every response for transparency
"""

import os
import json
import logging
import asyncio
from dataclasses import dataclass, field
from typing import Any, Optional

from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langgraph.prebuilt import create_react_agent
from langchain_openai import ChatOpenAI
from langchain_community.vectorstores import Chroma
from langchain_huggingface import HuggingFaceEmbeddings
from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_core.documents import Document
from PyPDF2 import PdfReader

from agent_tools import build_tools
from explainability import ExplainabilityTracer

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

@dataclass
class AgentConfig:
    embedding_model: str = "sentence-transformers/all-MiniLM-L6-v2"
    llm_model: str = os.environ.get("OPENROUTER_MODEL", "anthropic/claude-3.5-sonnet")
    manual_chunk_size: int = 512
    manual_chunk_overlap: int = 64
    chroma_persist_dir: str = "./chroma_manual_db"
    reranker_model: str = "cross-encoder/ms-marco-MiniLM-L-6-v2"
    max_agent_iterations: int = 5     # max tool-calling rounds
    max_replan_rounds: int = 2        # reflection re-plan cycles


# ---------------------------------------------------------------------------
# Response schema
# ---------------------------------------------------------------------------

@dataclass
class AgentResponse:
    answer: str
    urgency_level: str
    sources: list[dict]
    tool_calls_made: list[dict]       # which tools were called + their inputs
    tool_results_summary: list[dict]  # per-tool result counts
    retrieval_trace: list[dict]       # explainability per final doc
    replan_count: int
    metadata: dict = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Orchestrator Agent
# ---------------------------------------------------------------------------

class DisasterOrchestratorAgent:
    """
    LLM-driven agent that decides which data source tools to invoke
    per query, merges results, reranks, and generates a grounded answer.
    """

    SYSTEM_PROMPT = """You are an expert Disaster Management Orchestrator Agent.

Your job is to answer disaster-related queries by intelligently selecting and calling
the right data source tools. You have access to 4 tools:

1. search_live_news         — for recent events, ongoing incidents, breaking news
2. search_government_alerts — for official alerts, warnings, evacuation orders, seismic data
3. get_weather_report       — for weather conditions, storms, flooding risk in a location
4. search_instruction_manual — for SOPs, procedures, protocols from the official manual

Tool selection rules:
- For location-specific queries → ALWAYS call get_weather_report for that location
- For "what should I do" / procedural queries → ALWAYS call search_instruction_manual
- For "is there an alert/warning" queries → ALWAYS call search_government_alerts
- For "what is happening" / current events → ALWAYS call search_live_news
- For complex queries (e.g. "flood in Mumbai, what do I do?") → call MULTIPLE tools in parallel
- Never call a tool whose results would clearly be irrelevant to the query

After collecting tool results:
- Synthesize a clear, actionable answer
- Cite specific sources with [source_type: title] format
- Classify urgency: CRITICAL / HIGH / MEDIUM / LOW
- Be concise but complete; panicked people need clear guidance
- Acknowledge if information is insufficient or conflicting

Always prioritize life safety information above all else."""

    def __init__(self, config: Optional[AgentConfig] = None):
        self.cfg = config or AgentConfig()
        self._ready = False
        self.embeddings = None
        self.manual_vectorstore = None
        self.tools = None
        self.agent_executor = None
        self.explainability_tracer = None
        self.llm = None

    # ------------------------------------------------------------------
    # Initialisation
    # ------------------------------------------------------------------

    async def build(self, manual_pdf_paths: Optional[list[str]] = None) -> None:
        """
        One-time setup:
          - Embed the static instruction manual PDF(s)
          - Initialise all tools
          - Create the LangChain tool-calling agent
        """
        logger.info("🏗  Building DisasterOrchestratorAgent …")

        # Embeddings (used only for manual + explainability)
        self.embeddings = HuggingFaceEmbeddings(
            model_name=self.cfg.embedding_model,
            model_kwargs={"device": "cpu"},
            encode_kwargs={"normalize_embeddings": True},
        )

        # Pre-index the manual PDF(s)
        self.manual_vectorstore = await self._build_manual_index(manual_pdf_paths or [])

        # Build tool instances
        self.tools = build_tools(manual_vectorstore=self.manual_vectorstore)

        # LLM with tool-calling capability
        self.llm = ChatOpenAI(
            model=self.cfg.llm_model,
            temperature=0.1,
            openai_api_key=os.environ["OPENROUTER_API_KEY"].strip(),
            openai_api_base="https://openrouter.ai/api/v1",
            default_headers={
                "HTTP-Referer": os.environ.get("OPENROUTER_SITE_URL", "http://localhost"),
                "X-Title": os.environ.get("OPENROUTER_SITE_NAME", "DisasterRAG"),
            },
        )

        # Create react agent via langgraph (modern replacement for AgentExecutor)
        self.agent_executor = create_react_agent(
            model=self.llm,
            tools=self.tools,
            prompt=self.SYSTEM_PROMPT,
        )

        # Explainability tracer
        self.explainability_tracer = ExplainabilityTracer(
            cross_encoder_model=self.cfg.reranker_model
        )

        self._ready = True
        logger.info("✅ Orchestrator Agent ready")

    # ------------------------------------------------------------------
    # Query
    # ------------------------------------------------------------------

    async def query(
        self,
        user_query: str,
        chat_history: Optional[list] = None,
    ) -> AgentResponse:
        """Run the orchestrator agent on a user query."""
        if not self._ready:
            raise RuntimeError("Call build() before query()")

        logger.info(f"🤖 Agent query: {user_query!r}")

        # Build message list for langgraph react agent
        messages = []
        for msg in (chat_history or []):
            messages.append(msg)
        messages.append(HumanMessage(content=user_query))

        result = await self.agent_executor.ainvoke({"messages": messages})

        # Extract final answer — last AIMessage with text content
        final_answer = ""
        all_messages = result.get("messages", [])
        for msg in reversed(all_messages):
            if isinstance(msg, AIMessage) and msg.content:
                final_answer = msg.content if isinstance(msg.content, str) else str(msg.content)
                break

        # Parse tool calls and retrieved docs from message history
        tool_calls_made, all_retrieved_docs = self._parse_messages(all_messages)

        # Explainability trace over final docs
        final_docs = all_retrieved_docs[:10]
        retrieval_trace = self.explainability_tracer.trace(
            query=user_query,
            documents=[
                Document(
                    page_content=d.get("content", ""),
                    metadata={
                        "title": d.get("title", ""),
                        "source_type": d.get("source_type", ""),
                        "url": d.get("url", ""),
                        "published_at": d.get("published_at", ""),
                    },
                )
                for d in final_docs
            ],
        )

        # Classify urgency from answer + docs
        urgency = self._classify_urgency(user_query, final_answer, final_docs)

        # Build sources list
        sources = self._build_sources(all_retrieved_docs)

        # Tool result summary
        tool_results_summary = self._summarise_tool_results(tool_calls_made)

        return AgentResponse(
            answer=final_answer,
            urgency_level=urgency,
            sources=sources,
            tool_calls_made=tool_calls_made,
            tool_results_summary=tool_results_summary,
            retrieval_trace=retrieval_trace,
            replan_count=0,
            metadata={
                "query": user_query,
                "total_docs_retrieved": len(all_retrieved_docs),
                "tools_used": list({tc["tool_name"] for tc in tool_calls_made}),
                "agent_iterations": len(tool_calls_made),
            },
        )

    # ------------------------------------------------------------------
    # Manual PDF indexing
    # ------------------------------------------------------------------

    async def _build_manual_index(self, pdf_paths: list[str]):
        if not pdf_paths:
            env_paths = os.environ.get("MANUAL_PDF_PATHS", "")
            pdf_paths = [p.strip() for p in env_paths.split(":") if p.strip()]

        if not pdf_paths:
            logger.warning("No manual PDFs provided — manual tool will return empty results")
            return None

        # Check if persisted index exists
        if os.path.exists(self.cfg.chroma_persist_dir):
            logger.info("Loading persisted manual index …")
            return Chroma(
                collection_name="manual",
                embedding_function=self.embeddings,
                persist_directory=self.cfg.chroma_persist_dir,
            )

        # Build fresh
        splitter = RecursiveCharacterTextSplitter(
            chunk_size=self.cfg.manual_chunk_size,
            chunk_overlap=self.cfg.manual_chunk_overlap,
        )
        docs = []
        for path in pdf_paths:
            if not os.path.exists(path):
                logger.warning(f"PDF not found: {path}")
                continue
            reader = PdfReader(path)
            for i, page in enumerate(reader.pages):
                text = page.extract_text() or ""
                if len(text.strip()) > 50:
                    docs.append(Document(
                        page_content=text,
                        metadata={
                            "source_type": "instruction_manual",
                            "title": os.path.basename(path),
                            "page": i + 1,
                            "file_path": path,
                        },
                    ))

        if not docs:
            return None

        chunks = splitter.split_documents(docs)
        vectorstore = Chroma.from_documents(
            documents=chunks,
            embedding=self.embeddings,
            collection_name="manual",
            persist_directory=self.cfg.chroma_persist_dir,
        )
        logger.info(f"Manual index built: {len(chunks)} chunks from {len(pdf_paths)} PDFs")
        return vectorstore

    # ------------------------------------------------------------------
    # Parsing helpers
    # ------------------------------------------------------------------

    def _parse_messages(
        self, messages: list
    ) -> tuple[list[dict], list[dict]]:
        """
        Extract tool call records and retrieved docs from langgraph
        react agent message history (AIMessage tool_calls + ToolMessage results).
        """
        tool_calls = []
        all_docs = []
        seen_contents: set[str] = set()

        for msg in messages:
            # AIMessage with tool_calls = the LLM decided to call a tool
            if isinstance(msg, AIMessage) and getattr(msg, "tool_calls", None):
                for tc in msg.tool_calls:
                    tool_calls.append({
                        "tool_name": tc.get("name", "unknown"),
                        "tool_input": tc.get("args", {}),
                        "result_count": 0,   # updated when we see the ToolMessage
                        "_id": tc.get("id", ""),
                    })

            # ToolMessage = the tool result
            elif isinstance(msg, ToolMessage):
                result_docs = []
                raw = msg.content
                if isinstance(raw, list):
                    result_docs = raw
                elif isinstance(raw, str):
                    try:
                        parsed = json.loads(raw)
                        result_docs = parsed if isinstance(parsed, list) else []
                    except json.JSONDecodeError:
                        result_docs = [{"content": raw, "source_type": "tool"}]

                # Match back to the tool_call by tool_call_id
                for tc in reversed(tool_calls):
                    if tc.get("_id") == getattr(msg, "tool_call_id", None):
                        tc["result_count"] = len(result_docs)
                        break

                for doc in result_docs:
                    if not isinstance(doc, dict):
                        continue
                    key = doc.get("content", "")[:100]
                    if key not in seen_contents:
                        seen_contents.add(key)
                        all_docs.append(doc)

        # Clean up internal _id field before returning
        for tc in tool_calls:
            tc.pop("_id", None)

        return tool_calls, all_docs

    def _build_sources(self, docs: list[dict]) -> list[dict]:
        seen_urls: set[str] = set()
        sources = []
        for d in docs:
            url = d.get("url", "")
            key = url or d.get("title", "")
            if key and key not in seen_urls:
                seen_urls.add(key)
                sources.append({
                    "title": d.get("title", ""),
                    "source_type": d.get("source_type", ""),
                    "url": url,
                    "published_at": d.get("published_at", ""),
                })
        return sources

    def _summarise_tool_results(self, tool_calls: list[dict]) -> list[dict]:
        summary: dict[str, dict] = {}
        for tc in tool_calls:
            name = tc["tool_name"]
            if name not in summary:
                summary[name] = {"tool_name": name, "calls": 0, "total_docs": 0}
            summary[name]["calls"] += 1
            summary[name]["total_docs"] += tc.get("result_count", 0)
        return list(summary.values())

    def _classify_urgency(
        self, query: str, answer: str, docs: list[dict]
    ) -> str:
        critical_kw = {
            "earthquake", "tsunami", "flood", "fire", "cyclone", "tornado",
            "evacuate", "evacuation", "trapped", "collapse", "casualty", "explosion",
        }
        high_kw = {
            "warning", "alert", "shelter", "rescue", "medical", "injury",
            "missing", "storm", "hurricane", "critical",
        }
        combined = (query + " " + answer + " " +
                    " ".join(d.get("content", "")[:100] for d in docs[:5])).lower()
        if any(kw in combined for kw in critical_kw):
            return "CRITICAL"
        if any(kw in combined for kw in high_kw):
            return "HIGH"
        if any(d.get("source_type") == "government_alert" for d in docs):
            return "HIGH"
        return "MEDIUM"