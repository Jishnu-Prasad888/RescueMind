package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strconv"
	"strings"
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

type proxyTarget struct {
	Name string
	URL  *url.URL
}

type gatewayConfig struct {
	Port      string
	RAGTarget proxyTarget
	GraphAPI  proxyTarget
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

func mustParseURL(name, raw string) *url.URL {
	u, err := url.Parse(raw)
	if err != nil {
		log.Fatalf("invalid %s URL %q: %v", name, raw, err)
	}
	return u
}

func buildConfig() gatewayConfig {
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

	return gatewayConfig{
		Port: port,
		RAGTarget: proxyTarget{
			Name: "rag",
			URL:  mustParseURL("RAG_SERVER_URL", ragURL),
		},
		GraphAPI: proxyTarget{
			Name: "graph",
			URL:  mustParseURL("GRAPH_API_URL", graphURL),
		},
	}
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

func attachProxy(prefix string, target proxyTarget, mux *http.ServeMux) {
	proxy := httputil.NewSingleHostReverseProxy(target.URL)
	originalDirector := proxy.Director

	proxy.Director = func(req *http.Request) {
		originalDirector(req)
		// Strip the gateway prefix before forwarding.
		req.URL.Path = strings.TrimPrefix(req.URL.Path, prefix)
		if req.URL.Path == "" {
			req.URL.Path = "/"
		}
		req.Host = target.URL.Host
	}

	proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadGateway)
		_ = json.NewEncoder(w).Encode(map[string]string{
			"error":   "upstream_unreachable",
			"service": target.Name,
			"detail":  err.Error(),
		})
	}

	mux.Handle(prefix+"/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		proxy.ServeHTTP(w, r)
	}))
}

func healthProbe(url string) string {
	resp, err := http.Get(url)
	if err != nil {
		return "down"
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	if resp.StatusCode >= 200 && resp.StatusCode < 400 {
		return "up"
	}
	return "degraded"
}

func gatewayHealthHandler(cfg gatewayConfig) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		status := map[string]string{
			"gateway": "up",
			"rag":     healthProbe(cfg.RAGTarget.URL.String() + "/health"),
			"graph":   healthProbe(cfg.GraphAPI.URL.String() + "/health"),
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(status)
	}
}

func main() {
	cfg := buildConfig()
	mux := http.NewServeMux()

	// Native endpoint from main_server.
	mux.HandleFunc("/nearest", nearestHandler)
	mux.HandleFunc("/health", gatewayHealthHandler(cfg))

	// Proxy all RAG Server endpoints under /rag/*
	// Example: /rag/query -> {RAG_SERVER_URL}/query
	attachProxy("/rag", cfg.RAGTarget, mux)

	// Proxy all Graph API endpoints under /graph/*
	// Example: /graph/route -> {GRAPH_API_URL}/route
	attachProxy("/graph", cfg.GraphAPI, mux)

	handler := withCORS(mux)

	fmt.Printf("Gateway running on port %s\n", cfg.Port)
	fmt.Printf("RAG target: %s\n", cfg.RAGTarget.URL.String())
	fmt.Printf("Graph target: %s\n", cfg.GraphAPI.URL.String())

	log.Fatal(http.ListenAndServe(":"+cfg.Port, handler))
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
