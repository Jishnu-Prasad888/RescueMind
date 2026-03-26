package config

type Config struct {
	Port              string
	RoutingServiceURL string
}

func LoadConfig() Config {

	return Config{
		Port:              "8080",
		RoutingServiceURL: "http://localhost:8001",
	}
}
