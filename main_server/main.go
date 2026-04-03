package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
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

func haversine(lat1, lon1, lat2, lon2 float64) float64 {
	const R = 6371 // Earth radius in km

	dLat := (lat2 - lat1) * math.Pi / 180
	dLon := (lon2 - lon1) * math.Pi / 180

	a := math.Sin(dLat/2)*math.Sin(dLat/2) +
		math.Cos(lat1*math.Pi/180)*math.Cos(lat2*math.Pi/180)*
			math.Sin(dLon/2)*math.Sin(dLon/2)

	c := 2 * math.Atan2(math.Sqrt(a), math.Sqrt(1-a))
	return R * c
}

func loadLocations(filename string) ([]Location, error) {
	file, err := os.Open(filename)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	var locations []Location
	scanner := bufio.NewScanner(file)

	for scanner.Scan() {
		line := scanner.Text()
		parts := strings.Split(line, ",")

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

	return locations, scanner.Err()
}

func nearestHandler(w http.ResponseWriter, r *http.Request) {
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

	locations, err := loadLocations("pune_locations.txt")
	if err != nil {
		http.Error(w, "Failed to read file", http.StatusInternalServerError)
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

func pingUpstream(ctx context.Context, baseURL, path string) bool {
	u, err := url.JoinPath(strings.TrimSuffix(baseURL, "/"), path)
	if err != nil {
		return false
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return false
	}
	client := &http.Client{Timeout: 2 * time.Second}
	res, err := client.Do(req)
	if err != nil {
		return false
	}
	defer res.Body.Close()
	return res.StatusCode < 500
}

func healthHandler(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()

	ragURL := os.Getenv("RAG_SERVER_URL")
	if ragURL == "" {
		ragURL = "http://localhost:8000"
	}
	graphURL := os.Getenv("GRAPH_API_URL")
	if graphURL == "" {
		graphURL = "http://localhost:8080"
	}

	ragOK := pingUpstream(ctx, ragURL, "/health")
	graphOK := pingUpstream(ctx, graphURL, "/health")

	ragStatus, graphStatus := "down", "down"
	if ragOK {
		ragStatus = "ok"
	}
	if graphOK {
		graphStatus = "ok"
	}
	status := map[string]string{
		"gateway": "up",
		"rag":     ragStatus,
		"graph":   graphStatus,
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(status)
}

func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func singleHostProxy(target string) http.Handler {
	u, err := url.Parse(target)
	if err != nil {
		log.Fatalf("invalid proxy target URL %q: %v", target, err)
	}
	return httputil.NewSingleHostReverseProxy(u)
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "6000"
	}

	ragURL := os.Getenv("RAG_SERVER_URL")
	if ragURL == "" {
		ragURL = "http://localhost:8000"
	}
	graphURL := os.Getenv("GRAPH_API_URL")
	if graphURL == "" {
		graphURL = "http://localhost:8080"
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/nearest", nearestHandler)
	mux.HandleFunc("/health", healthHandler)
	mux.Handle("/rag/", http.StripPrefix("/rag", singleHostProxy(ragURL)))
	mux.Handle("/graph/", http.StripPrefix("/graph", singleHostProxy(graphURL)))

	handler := withCORS(mux)

	fmt.Printf("Gateway running on port %s\n", port)
	log.Fatal(http.ListenAndServe(":"+port, handler))
}
