from graph.load_geojson import load_geojson
from graph.build_graph import build_city_graph
from graph.kd_tree import NodeKDTree

nodes = load_geojson("data/city_nodes.geojson")
roads = load_geojson("data/city_roads.geojson")

G = build_city_graph(nodes, roads)

kd = NodeKDTree(G)

node = kd.nearest_node(18.5274, 73.8732)

print("Nearest node:", node)
print("Coordinates:", G.nodes[node]["pos"])