from graph.load_geojson import load_geojson
from graph.build_graph import build_city_graph
from graph.kd_tree import NodeKDTree

from algorithms.astar import find_route
import networkx as nx
import random


class RoutingService:

    def __init__(self):

        nodes = load_geojson("data/city_nodes.geojson")
        roads = load_geojson("data/city_roads.geojson")

        self.G = build_city_graph(nodes, roads)

        print("Graph loaded:")
        print("Nodes:", len(self.G.nodes))
        print("Edges:", len(self.G.edges))

        # Add dummy weights for testing multi-route
        for u, v, data in self.G.edges(data=True):
            if 'time' not in data:
                # Assuming weight is distance, time = distance / speed
                data['time'] = data.get('weight', 1.0) / random.uniform(20.0, 60.0)
            if 'safety' not in data:
                # Random safety penalty
                data['safety'] = data.get('weight', 1.0) * random.uniform(0.5, 2.0)

        print("Dummy time and safety weights added.")

        # Build KD-tree
        self.kd_tree = NodeKDTree(self.G)

    def compute_route(self, start_lat, start_lon, end_lat, end_lon):

        start_node = self.kd_tree.nearest_node(start_lat, start_lon)
        end_node = self.kd_tree.nearest_node(end_lat, end_lon)

        fastest_path, _ = find_route(self.G, start_node, end_node, weight_attr="time")
        safest_path, _ = find_route(self.G, start_node, end_node, weight_attr="safety")
        shortest_path, _ = find_route(self.G, start_node, end_node, weight_attr="weight")

        def get_route_details(path):
            if not path:
                return path, 0.0, 0.0
            dist = nx.path_weight(self.G, path, weight="weight")
            time = nx.path_weight(self.G, path, weight="time")
            return path, dist, time

        f_path, f_dist, f_time = get_route_details(fastest_path)
        s_path, s_dist, s_time = get_route_details(safest_path)
        sh_path, sh_dist, sh_time = get_route_details(shortest_path)

        return [
            {"type": "FASTEST", "path": f_path, "distance": f_dist, "time": f_time},
            {"type": "SAFEST", "path": s_path, "distance": s_dist, "time": s_time},
            {"type": "SHORTEST", "path": sh_path, "distance": sh_dist, "time": sh_time}
        ]