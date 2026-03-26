from graph.load_geojson import load_geojson
from graph.build_graph import build_city_graph

nodes = load_geojson("data/city_nodes.geojson")
roads = load_geojson("data/city_roads.geojson")

G = build_city_graph(nodes, roads)

print("Nodes:", len(G.nodes))
print("Edges:", len(G.edges))

for i, node in enumerate(G.nodes):
    print(node, G.nodes[node])
    if i == 5:
        break