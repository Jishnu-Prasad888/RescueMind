package handlers

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"rescuemind-api/internal/server"
	"rescuemind-api/pkg/models"
)

func RouteHandler(w http.ResponseWriter, r *http.Request) {

	start := r.URL.Query().Get("start")
	end := r.URL.Query().Get("end")

	grpcResp, err := server.RoutingClient.ComputeRoute(start, end)

	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}

	resp := models.RouteResponse{}
	for _, grpcRoute := range grpcResp.Routes {
		var mappedPath []models.Location
		for _, coords := range grpcRoute.Path {
			parts := strings.Split(coords, ",")
			if len(parts) == 2 {
				lat, _ := strconv.ParseFloat(parts[0], 64)
				lon, _ := strconv.ParseFloat(parts[1], 64)
				mappedPath = append(mappedPath, models.Location{Lat: lat, Lon: lon})
			}
		}

		resp.Routes = append(resp.Routes, models.Route{
			Type:     grpcRoute.RouteType,
			Distance: float64(grpcRoute.Distance),
			Time:     float64(grpcRoute.EstimatedTime),
			Path:     mappedPath,
		})
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}
