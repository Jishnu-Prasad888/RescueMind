# Disaster Management RAG — Orchestrator Agent
## Advanced LangChain agent for ML-based disaster management

### Architecture

The system is a **true orchestrator agent** — the LLM reasons at query time
about which data sources to call, rather than batch-ingesting everything upfront.
Only the instruction manual PDF is pre-indexed (it's static); all live sources
are fetched fresh on every query.

| Technique | Implementation |
|-----------|---------------|
| **Tool-routing agent** | `create_tool_calling_agent` — LLM picks which tools to invoke per query |
| **Ensemble Retrieval + RRF** | Dense (Chroma) + BM25 inside the manual tool |
| **Hierarchical Indices** | Parent (512t) → Child (128t) chunking for the PDF manual |
| **Cross-Encoder Reranking** | `ms-marco-MiniLM` scores all retrieved docs |
| **Iterative feedback** | Agent's own multi-step reasoning replaces the old loop |
| **Explainable Retrieval** | Per-doc relevance score + matched key phrases in every response |

---

### File Structure

```
disaster_rag/
├── orchestrator_agent.py   ← agent brain · tool routing · response builder
├── agent_tools.py          ← 4 BaseTool classes (news, gov alerts, weather, manual)
├── api_server.py           ← FastAPI server
├── explainability.py       ← per-doc scoring and trace
├── hierarchical_index.py   ← parent/child PDF chunking
├── requirements.txt
├── .env.example
└── README.md
```

---

### Data Sources

| Tool | Source | Fetch strategy |
|------|--------|---------------|
| `search_live_news` | ReliefWeb RSS, GDACS, NewsAPI | Live at query time |
| `search_government_alerts` | NDMA, FEMA, USGS, NWS | Live at query time |
| `get_weather_report` | WeatherAPI.com | Live at query time |
| `search_instruction_manual` | Your PDF manual(s) | Pre-indexed at startup |

---

### Quickstart

#### 1. Install dependencies
```bash
python -m venv venv
venv\Scripts\activate       # Windows
# source venv/bin/activate  # Mac/Linux
pip install -r requirements.txt
```

#### 2. Configure environment
```bash
copy .env.example .env      # Windows
# cp .env.example .env      # Mac/Linux
```
Edit `.env` and fill in your keys.

#### 3. Add your instruction manual (optional)
```
MANUAL_PDF_PATHS=C:\path\to\disaster_manual.pdf
```

#### 4. Run the server
```bash
python api_server.py
```
API docs available at `http://localhost:8000/docs`

---

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENROUTER_API_KEY` | **Yes** | OpenRouter key — get at https://openrouter.ai/keys |
| `OPENROUTER_MODEL` | No | Model string (default: `anthropic/claude-3.5-sonnet`) |
| `OPENROUTER_SITE_URL` | No | Your app URL for OpenRouter dashboard (default: `http://localhost`) |
| `OPENROUTER_SITE_NAME` | No | App name for OpenRouter dashboard (default: `DisasterRAG`) |
| `WEATHERAPI_KEY` | Recommended | WeatherAPI.com key — get at https://www.weatherapi.com/ |
| `NEWSAPI_KEY` | Optional | NewsAPI.org key — news tool still works via RSS without it |
| `MANUAL_PDF_PATHS` | Optional | Colon-separated paths to PDF manuals |
| `PORT` | No | Server port (default: `8000`) |

---

### Extending the agent

- **Graph RAG** — add Neo4j to link related disaster events as a knowledge graph, add it as a 5th tool
- **Multi-modal** — extend `agent_tools.py` with a satellite imagery tool using a vision-capable model
- **Parallel tool calls** — replace `AgentExecutor` with a custom async loop using `asyncio.gather()` for true parallel tool execution