def update_graph_weights(G, ml_state):
    
    road_conditions = ml_state.get("road_conditions", {})

    for (u, v), info in road_conditions.items():
        if G.has_edge(u, v):
            prob = info.get("flood_probability", 0)

            if prob > 0.7:
                G[u][v]["weight"] = float("inf")
            elif prob > 0.3:
                G[u][v]["weight"] *= 2

def update_graph_safety_weights(G, ml_matrix, top_left_lat, top_left_lon, lat_step, lon_step):
    """
    Overwrites the 'safety' attribute of every road based on the ML 2D array.
    """
    for u, v, data in G.edges(data=True):
        pos = G.nodes[u].get('pos')
        if not pos:
            continue
        lon, lat = pos
        
        row = int(abs((lat - top_left_lat) / lat_step)) if lat_step else 0
        col = int(abs((lon - top_left_lon) / lon_step)) if lon_step else 0
        
        row = max(0, min(row, len(ml_matrix)-1))
        col = max(0, min(col, len(ml_matrix[0])-1))
        
        hazard_multiplier = ml_matrix[row][col]
        
        # We retain the original physical weight (distance) but multiply by the hazard
        data['safety'] = data.get('weight', 1.0) * (1.0 + hazard_multiplier)

    print("Graph runtime safety weights successfully updated from ML Matrix!")
