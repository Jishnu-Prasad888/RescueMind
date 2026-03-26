package router

import (
	"net/http"
	"rescuemind-api/internal/handlers"
	"rescuemind-api/internal/middleware"
)

func SetupRouter() http.Handler {

	mux := http.NewServeMux()

	mux.HandleFunc("/health", handlers.HealthHandler)
	mux.HandleFunc("/ws/live", handlers.WebSocketHandler)

	protectedRoute := middleware.AuthMiddleware(http.HandlerFunc(handlers.RouteHandler))
	mux.Handle("/route", protectedRoute)

	return mux
}
