from flask import Flask, request, jsonify

from graph.load_geojson import load_geojson
from graph.build_graph import build_city_graph
from algorithms.astar import find_route
from algorithms.bidirectional_astar import bidirectional_astar  # only if exists

app = Flask(__name__)

# Load graph ONCE at startup
nodes = load_geojson("data/city_nodes.geojson")
roads = load_geojson("data/city_roads.geojson")
G = build_city_graph(nodes, roads)

@app.route("/route", methods=["POST"])
def get_route():
    data = request.json

    start = data["start"]
    end = data["end"]
    blocked = data.get("blocked_roads", [])

    # Apply dynamic road updates
    for u, v in blocked:
        if G.has_edge(u, v):
            G[u][v]["weight"] = 50  # simulate disaster

    algo = data.get("algorithm", "astar")

    if algo == "bidirectional":
        path, cost = bidirectional_astar(G, start, end)
    else:
        path, cost = find_route(G, start, end)



    return jsonify({
        "path": path,
        "cost": cost
    })

if __name__ == "__main__":
    app.run(debug=True)
