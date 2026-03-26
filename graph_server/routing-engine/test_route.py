from graph.load_geojson import load_geojson
from graph.build_graph import build_city_graph
from algorithms.astar import find_route

nodes = load_geojson("data/city_nodes.geojson")
roads = load_geojson("data/city_roads.geojson")

G = build_city_graph(nodes, roads)

node_list = list(G.nodes)

start = node_list[0]
end = node_list[100]

path, cost = find_route(G, start, end)

print("Path length:", len(path))
print("Cost:", cost)
print("First nodes:", path[:5])