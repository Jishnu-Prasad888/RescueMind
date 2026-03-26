package websocket

type Hub struct {
	Clients map[*Client]bool
}

type Client struct {
	Send chan []byte
}

func NewHub() *Hub {
	return &Hub{
		Clients: make(map[*Client]bool),
	}
}
