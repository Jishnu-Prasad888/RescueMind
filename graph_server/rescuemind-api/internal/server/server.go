package server

import (
	"log"
	"rescuemind-api/internal/routing"
)

var RoutingClient *routing.RoutingClient

func InitServices() {

	client, err := routing.NewRoutingClient("localhost:50051")
	if err != nil {
		log.Fatal("Failed to connect to routing engine:", err)
	}

	RoutingClient = client
}
