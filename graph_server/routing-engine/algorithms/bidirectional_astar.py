import heapq
import math


def heuristic(G, node_a, node_b):
    """
    Euclidean distance heuristic.
    Assumes each node has attribute: pos = (x, y)
    """
    x1, y1 = G.nodes[node_a]["pos"]
    x2, y2 = G.nodes[node_b]["pos"]
    return math.sqrt((x1 - x2) ** 2 + (y1 - y2) ** 2)


def bidirectional_astar(G, start, goal):
    """
    Computes optimal path using Bidirectional A*.

    Returns:
        path (list of nodes), total_cost (float)
    """

    if start not in G:
        raise ValueError(f"Start node '{start}' not found in graph.")

    if goal not in G:
        raise ValueError(f"Goal node '{goal}' not found in graph.")

    if start == goal:
        return [start], 0

    # Forward search structures
    open_f = [(0, start)]
    g_f = {start: 0}
    parent_f = {}
    closed_f = set()

    # Backward search structures
    open_b = [(0, goal)]
    g_b = {goal: 0}
    parent_b = {}
    closed_b = set()

    meeting_node = None
    best_cost = float("inf")

    while open_f and open_b:

        # -------- Forward step --------
        _, current_f = heapq.heappop(open_f)

        if current_f in closed_f:
            continue

        closed_f.add(current_f)

        if current_f in closed_b:
            meeting_node = current_f
            break

        for neighbor in G.neighbors(current_f):
            cost = g_f[current_f] + G[current_f][neighbor]["weight"]

            if neighbor not in g_f or cost < g_f[neighbor]:
                g_f[neighbor] = cost
                f_score = cost + heuristic(G, neighbor, goal)
                heapq.heappush(open_f, (f_score, neighbor))
                parent_f[neighbor] = current_f

        # -------- Backward step --------
        _, current_b = heapq.heappop(open_b)

        if current_b in closed_b:
            continue

        closed_b.add(current_b)

        if current_b in closed_f:
            meeting_node = current_b
            break

        for neighbor in G.neighbors(current_b):
            cost = g_b[current_b] + G[current_b][neighbor]["weight"]

            if neighbor not in g_b or cost < g_b[neighbor]:
                g_b[neighbor] = cost
                f_score = cost + heuristic(G, neighbor, start)
                heapq.heappush(open_b, (f_score, neighbor))
                parent_b[neighbor] = current_b

    if meeting_node is None:
        return None, float("inf")

    # -------- Reconstruct path --------

    # Forward part
    path_forward = []
    node = meeting_node
    while node != start:
        path_forward.append(node)
        node = parent_f[node]
    path_forward.append(start)
    path_forward.reverse()

    # Backward part
    path_backward = []
    node = meeting_node
    while node != goal:
        node = parent_b[node]
        path_backward.append(node)

    full_path = path_forward + path_backward
    total_cost = g_f[meeting_node] + g_b[meeting_node]

    return full_path, total_cost
