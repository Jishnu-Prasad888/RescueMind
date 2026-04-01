

cd "$(dirname "$0")" || exit

cleanup() {
    kill $(jobs -p) 2>/dev/null
    exit
}

trap cleanup SIGINT SIGTERM

mkdir -p backend_logs
rm -f backend_logs/*.log

cd graph_server/routing-engine
source .venv/bin/activate
python3 grpc_server.py > ../../backend_logs/routing_engine.log 2>&1 &
cd ../..

cd graph_server/rescuemind-api/cmd/server
go run main.go > ../../../../backend_logs/graph_api.log 2>&1 &
cd ../../../../

cd RAG_Server
source .venv/bin/activate
python3 api_server.py > ../backend_logs/rag_server.log 2>&1 &
cd ..

cd main_server
PORT="6000" RAG_SERVER_URL="http://localhost:8000" GRAPH_API_URL="http://localhost:8080" go run main.go > ../backend_logs/gateway.log 2>&1 &
cd ..

sleep 3

cd RescueMindApp
npm start

wait
