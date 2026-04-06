from graph.load_geojson import load_geojson
from graph.build_graph import build_city_graph
from graph.kd_tree import NodeKDTree
from graph.graph_updater import update_graph_safety_weights
from services.ml_provider import MLProvider

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

        # Add dummy time weights for testing multi-route
        for u, v, data in self.G.edges(data=True):
            if 'time' not in data:
                # Assuming weight is distance, time = distance / speed
                data['time'] = data.get('weight', 1.0) / random.uniform(20.0, 60.0)

        # Initialize ML Provider and attempt to overlay hazard matrix
        self.ml_provider = MLProvider()
        
        # We try to load the default matrix from CSV if available locally
        if self.ml_provider.load_from_csv("data/blurred_matrix.csv"):
            self.ml_provider.compute_bounds(self.G)
            self._apply_ml_safety_weights()
            print("ML hazard matrix loaded and safety weights applied successfully.")
        else:
            # Fallback to dummy safety weights if no ML data exists
            for u, v, data in self.G.edges(data=True):
                if 'safety' not in data:
                    data['safety'] = data.get('weight', 1.0) * random.uniform(0.5, 2.0)
            print("No ML matrix found, dummy safety weights added.")

        # Build KD-tree
        self.kd_tree = NodeKDTree(self.G)

    def _apply_ml_safety_weights(self):
        """Helper to re-run graph updater when matrix changes."""
        update_graph_safety_weights(
            self.G, 
            self.ml_provider.get_matrix(), 
            self.ml_provider.top_left_lat, 
            self.ml_provider.top_left_lon, 
            self.ml_provider.lat_step, 
            self.ml_provider.lon_step
        )

    def update_ml_matrix(self, rows):
        """Update the live matrix from gRPC and recompute safety weights."""
        self.ml_provider.update_matrix(rows)
        self._apply_ml_safety_weights()

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