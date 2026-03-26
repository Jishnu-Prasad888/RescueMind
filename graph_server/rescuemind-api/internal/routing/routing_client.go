package routing

import (
	"context"
	"time"

	pb "rescuemind-api/internal/routing/proto"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

type RoutingClient struct {
	client pb.RoutingServiceClient
	conn   *grpc.ClientConn
}

func NewRoutingClient(addr string) (*RoutingClient, error) {

	conn, err := grpc.Dial(
		addr,
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
	if err != nil {
		return nil, err
	}

	client := pb.NewRoutingServiceClient(conn)

	return &RoutingClient{
		client: client,
		conn:   conn,
	}, nil
}

func (r *RoutingClient) ComputeRoute(start, end string) (*pb.RouteResponse, error) {

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	return r.client.ComputeRoute(ctx, &pb.RouteRequest{
		Start: start,
		End:   end,
	})
}
