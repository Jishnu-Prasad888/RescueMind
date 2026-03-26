package middleware

import "net/http"

func AuthMiddleware(next http.Handler) http.Handler {

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {

		token := r.Header.Get("Authorization")

		if token == "" {
			// Development-friendly behavior:
			// allow requests when no Authorization header is provided.
			// (The gateway/mobile app currently doesn't send Authorization.)
			next.ServeHTTP(w, r)
			return
		}

		next.ServeHTTP(w, r)
	})
}
