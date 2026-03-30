package server

import (
	"log"
	"os"
	"rescuemind-api/internal/routing"
)

var RoutingClient *routing.RoutingClient

func InitServices() {
	grpcURL := os.Getenv("GRPC_SERVER_URL")
	if grpcURL == "" {
		grpcURL = "localhost:50051"
	}

	client, err := routing.NewRoutingClient(grpcURL)
	if err != nil {
		log.Fatal("Failed to connect to routing engine:", err)
	}

	RoutingClient = client
}
