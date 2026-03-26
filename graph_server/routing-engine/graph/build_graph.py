# import networkx as nx

# def build_city_graph(nodes_data, roads_data):
#     G = nx.Graph()

#     # Add nodes
#     for feature in nodes_data["features"]:
#         name = feature["properties"]["name"]
#         x, y = feature["geometry"]["coordinates"]
#         G.add_node(name, pos=(x, y))

#     # Add roads
#     for feature in roads_data["features"]:
#         coords = feature["geometry"]["coordinates"]
#         cost = feature["properties"]["cost"]

#         start = tuple(coords[0])
#         end = tuple(coords[1])

#         # Find node names by position
#         start_node = next(n for n, d in G.nodes(data=True) if d["pos"] == start)
#         end_node = next(n for n, d in G.nodes(data=True) if d["pos"] == end)

#         G.add_edge(start_node, end_node, weight=cost)

#     return G

import networkx as nx

def build_city_graph(nodes, roads):

    G = nx.Graph()


    for feature in nodes["features"]:

        node_id = feature["properties"]["osmid"]
        lon, lat = feature["geometry"]["coordinates"]

        G.add_node(node_id, pos=(lon, lat))


    for feature in roads["features"]:

        props = feature["properties"]

        u = props["u"]
        v = props["v"]
        length = props.get("length", 1)

        G.add_edge(u, v, weight=length)

    return G