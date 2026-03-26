package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"

	"rescuemind-api/config"
	"rescuemind-api/internal/router"
	"rescuemind-api/internal/server"
)

type Location struct {
	Name string
	Lat  float64
	Lon  float64
}

type Response struct {
	NearestLocation string  `json:"nearest_location"`
	DistanceKM      float64 `json:"distance_km"`
}

// Global cache
var (
	locations []Location
	once      sync.Once
	loadErr   error
)

// Haversine formula
func haversine(lat1, lon1, lat2, lon2 float64) float64 {
	const R = 6371

	dLat := (lat2 - lat1) * math.Pi / 180
	dLon := (lon2 - lon1) * math.Pi / 180

	a := math.Sin(dLat/2)*math.Sin(dLat/2) +
		math.Cos(lat1*math.Pi/180)*math.Cos(lat2*math.Pi/180)*
			math.Sin(dLon/2)*math.Sin(dLon/2)

	c := 2 * math.Atan2(math.Sqrt(a), math.Sqrt(1-a))
	return R * c
}

// Load file ONLY ONCE
func loadLocations(filename string) {
	file, err := os.Open(filename)
	if err != nil {
		loadErr = err
		return
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)

	for scanner.Scan() {
		parts := strings.Split(scanner.Text(), ",")
		if len(parts) != 3 {
			continue
		}

		lat, err1 := strconv.ParseFloat(parts[1], 64)
		lon, err2 := strconv.ParseFloat(parts[2], 64)
		if err1 != nil || err2 != nil {
			continue
		}

		locations = append(locations, Location{
			Name: parts[0],
			Lat:  lat,
			Lon:  lon,
		})
	}

	loadErr = scanner.Err()
}

func nearestHandler(w http.ResponseWriter, r *http.Request) {
	// Ensure file is loaded once
	once.Do(func() {
		loadLocations("pune_locations.txt")
	})

	if loadErr != nil {
		http.Error(w, "Failed to load locations", http.StatusInternalServerError)
		return
	}

	latStr := r.URL.Query().Get("lat")
	lonStr := r.URL.Query().Get("lon")

	if latStr == "" || lonStr == "" {
		http.Error(w, "Missing lat/lon", http.StatusBadRequest)
		return
	}

	userLat, err1 := strconv.ParseFloat(latStr, 64)
	userLon, err2 := strconv.ParseFloat(lonStr, 64)

	if err1 != nil || err2 != nil {
		http.Error(w, "Invalid lat/lon", http.StatusBadRequest)
		return
	}

	minDist := math.MaxFloat64
	var nearest Location

	for _, loc := range locations {
		dist := haversine(userLat, userLon, loc.Lat, loc.Lon)
		if dist < minDist {
			minDist = dist
			nearest = loc
		}
	}

	resp := Response{
		NearestLocation: nearest.Name,
		DistanceKM:      minDist,
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

func main() {
	// Graph API bootstrapping:
	// - provides /health, /route and /ws/live (proxied by the gateway)
	// - also keeps the legacy /nearest endpoint.
	cfg := config.LoadConfig()
	server.InitServices()

	// router.SetupRouter returns a handler with /health, /route (auth-protected) and /ws/live.
	graphHandler := router.SetupRouter()

	// Serve both /nearest (legacy) and the router endpoints.
	mux := http.NewServeMux()
	mux.HandleFunc("/nearest", nearestHandler)
	mux.Handle("/", graphHandler)

	fmt.Printf("Graph API listening on port %s...\n", cfg.Port)
	_ = http.ListenAndServe(":"+cfg.Port, mux)
}
