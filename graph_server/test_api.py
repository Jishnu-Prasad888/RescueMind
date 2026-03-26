import requests

# API endpoint
BASE_URL = "http://localhost:8080/route"

# Coordinates (example)
start = "18.5274,73.8732"
end = "18.5200,73.8600"

# Send GET request
params = {
    "start": start,
    "end": end
}

try:
    response = requests.get(BASE_URL, params=params)
    response.raise_for_status()  # Raise error for bad responses

    data = response.json()
    import json
    print(json.dumps(data, indent=2))

    # # Pretty print the routes
    # for route in data.get("routes", []):
    #     print("\n=== Route Type:", route["type"], "===")
    #     print("Distance:", route["distance"], "meters")
    #     print("Estimated Time:", route["time"], "minutes")

    #     print("Path (first few points):")
    #     for point in route["path"][:5]:  # limit output
    #         print(f"  -> Lat: {point['lat']}, Lon: {point['lon']}")

except requests.exceptions.RequestException as e:
    print("Error making request:", e)