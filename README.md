# RescueMind Unified Backend Setup

This repository contains three backend services and one unified gateway.

- `RAG_Server` (FastAPI): disaster Q&A orchestrator
- `graph_server/rescuemind-api` (Go): routing and websocket API
- `graph_server/routing-engine` (Python): gRPC routing engine used by graph API
- `main_server` (Go): unified gateway for frontend

The frontend should call only the gateway (`main_server`) so all requests go through one server URL.

## Directory Overview

- `RAG_Server/`
- `graph_server/`
  - `rescuemind-api/`
  - `routing-engine/`
- `main_server/`

## Ports

Default local ports used by the project:

- Gateway: `6000`
- RAG Server: `8000`
- Graph API: `8080`
- Routing gRPC engine: `50051`

## Start Services

Start in this order so dependencies are ready:

1. Routing engine (gRPC)
2. Graph API server
3. RAG server
4. Unified gateway

### 1) Start Routing Engine (Python gRPC)

Open terminal in `graph_server/routing-engine`:

```powershell
python -m venv .venv
.\.venv\Scripts\activate
pip install -r requirements.txt
python grpc_server.py
```

### 2) Start Graph API (Go)

Open terminal in `graph_server/rescuemind-api/cmd/server`:

```powershell
go run main.go
```

Graph API expects routing engine at `localhost:50051`.

### 3) Start RAG Server (FastAPI)

Open terminal in `RAG_Server`:

```powershell
python -m venv .venv
.\.venv\Scripts\activate
pip install -r requirements.txt
python api_server.py
```

By default this starts on `http://localhost:8000`.

### 4) Start Unified Gateway (Go)

Open terminal in `main_server`:

```powershell
$env:PORT="6000"
$env:RAG_SERVER_URL="http://localhost:8000"
$env:GRAPH_API_URL="http://localhost:8080"
go run main.go
```

Now frontend can use one base URL:

`http://localhost:6000`

## Unified Gateway API

### Local nearest location endpoint

- `GET /nearest?lat=<float>&lon=<float>`

### Proxied RAG endpoints

- `POST /rag/query` -> forwards to `RAG_Server /query`
- `GET /rag/health` -> forwards to `RAG_Server /health`
- `GET /rag/tools` -> forwards to `RAG_Server /tools`
- `POST /rag/manual/reindex` -> forwards to `RAG_Server /manual/reindex`

### Proxied Graph endpoints

- `GET /graph/route?...` -> forwards to `Graph API /route`
- `GET /graph/health` -> forwards to `Graph API /health`
- `GET /graph/ws/live` -> forwards to `Graph API /ws/live` (websocket)

### Gateway health

- `GET /health`

Returns basic status for:

- gateway
- rag upstream
- graph upstream

## Frontend Integration

Configure frontend API base URL to:

`http://localhost:6000`

Then call:

- RAG requests under `/rag/*`
- Routing requests under `/graph/*`
- Nearby place request under `/nearest`

## Troubleshooting

- If `/graph/route` fails, ensure both `routing-engine` and `rescuemind-api` are running.
- If `/rag/query` fails, ensure `RAG_Server` is running and dependencies are installed.
- If gateway returns `upstream_unreachable`, check upstream host/port env vars and service logs.

Port 6000 was already occupied by an old process (server.exe, PID 29272), so your new go run couldn’t bind.

I fixed it by terminating the stale process, then verified startup:

killed old process on :6000
re-ran go run .\main.go
server now starts successfully:
Gateway running on port 6000
RAG target: http://localhost:8000
Graph target: http://localhost:8080
If this happens again, use:

netstat -ano -p tcp | Select-String ":6000"
taskkill /PID <pid> /F

## Latest Changes (Mar 27, 2026)

- Added a persistent Google API request quota checkpoint in `RescueMindApp`:
  - Blocks Google Directions requests at 500 total requests
  - Shows a warning when the limit is reached
  - Stays blocked until you manually reset the counter from the app UI
- Fixed Expo Router navigation crashes by removing nested `NavigationContainer` usage inside tab screens (`app/(tabs)/index.tsx` and `app/(tabs)/explore.tsx`).
- Updated Expo config:
  - Added `scheme` to `RescueMindApp/app.json`
  - Added missing `RescueMindApp/assets/icon.png`
- Replaced quota persistence from `AsyncStorage` to `expo-file-system/legacy` to avoid `AsyncStorageError: Native module is null, cannot access legacy storage`.
- Improved RAG request failure handling in the app:
  - Normalizes gateway URL (auto-adds `http://` if needed)
  - Shows a clearer alert when `/rag/query` fails
- Fixed `/graph/route` failures by updating `graph_server/rescuemind-api` to serve the correct HTTP endpoints on `:8080`:
  - `/health`, `/route`, and `/ws/live`
- Relaxed dev auth behavior in `graph_server/rescuemind-api` so `/route` isn’t rejected when no `Authorization` header is provided.
- Improved `/graph/route` error debugging by including the upstream response body in the app error text when available.
