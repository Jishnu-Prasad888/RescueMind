from scipy.spatial import KDTree


class NodeKDTree:

    def __init__(self, G):
        """
        Build KD-tree from graph nodes
        """
        self.node_ids = []
        points = []

        for node in G.nodes:
            lon, lat = G.nodes[node]["pos"]

            points.append((lat, lon))
            self.node_ids.append(node)

        self.tree = KDTree(points)

    def nearest_node(self, lat, lon):
        """
        Find nearest graph node to given coordinate
        """

        distance, index = self.tree.query((lat, lon))

        return self.node_ids[index]