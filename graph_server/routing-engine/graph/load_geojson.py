import json

def load_geojson(path):
    with open(path, "r") as f:
        return json.load(f)
