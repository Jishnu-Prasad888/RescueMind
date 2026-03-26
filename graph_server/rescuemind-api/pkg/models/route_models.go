package models

type Location struct {
	Lat float64 `json:"lat"`
	Lon float64 `json:"lon"`
}

type RouteRequest struct {
	Start Location `json:"start"`
	End   Location `json:"end"`
}

type Route struct {
	Type     string     `json:"type"`
	Distance float64    `json:"distance"`
	Time     float64    `json:"time"`
	Path     []Location `json:"path"`
}

type RouteResponse struct {
	Routes []Route `json:"routes"`
}
