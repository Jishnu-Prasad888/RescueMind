import math
import networkx as nx


def heuristic(G, node_a, node_b):
    """
    Euclidean distance heuristic using node coordinates.
    Assumes each node has attribute: pos = (x, y)
    """
    x1, y1 = G.nodes[node_a]["pos"]
    x2, y2 = G.nodes[node_b]["pos"]
    return math.sqrt((x1 - x2) ** 2 + (y1 - y2) ** 2)


def find_route(G, start, goal, weight_attr="weight"):
    """
    Computes optimal path using A*.

    Parameters:
        G     : NetworkX graph
        start : starting node name
        goal  : destination node name

    Returns:
        path (list of nodes), total_cost (float)
    """

    if start not in G:
        raise ValueError(f"Start node '{start}' not found in graph.")

    if goal not in G:
        raise ValueError(f"Goal node '{goal}' not found in graph.")

    try:
        path = nx.astar_path(
            G,
            start,
            goal,
            heuristic=lambda a, b: heuristic(G, a, b),
            weight=weight_attr
        )

        total_cost = nx.path_weight(G, path, weight=weight_attr)

        return path, total_cost

    except nx.NetworkXNoPath:
        return None, float("inf")
