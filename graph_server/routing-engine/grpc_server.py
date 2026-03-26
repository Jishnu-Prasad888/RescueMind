import sys
import os
import grpc
from concurrent import futures
import logging

sys.path.append(os.path.join(os.path.dirname(__file__), 'proto'))

import proto.routing_pb2 as routing_pb2
import proto.routing_pb2_grpc as routing_pb2_grpc

from services.routing_service import RoutingService

class RoutingServicer(routing_pb2_grpc.RoutingServiceServicer):
    def __init__(self):
        logging.info("Initializing Routing Service and loading graph...")
        self.routing_service = RoutingService()
        logging.info("Graph loaded successfully.")

    def ComputeRoute(self, request, context):
        try:
            start_parts = request.start.split(",")
            end_parts = request.end.split(",")
            
            if len(start_parts) == 2 and len(end_parts) == 2:
                start_lat, start_lon = float(start_parts[0]), float(start_parts[1])
                end_lat, end_lon = float(end_parts[0]), float(end_parts[1])
                routes_data = self.routing_service.compute_route(start_lat, start_lon, end_lat, end_lon)
            else:
                context.set_code(grpc.StatusCode.INVALID_ARGUMENT)
                context.set_details("Must provide lat,lon coordinates")
                return routing_pb2.RouteResponse()
                
        except Exception as e:
            logging.error(f"Error computing route: {e}")
            context.set_code(grpc.StatusCode.INVALID_ARGUMENT)
            context.set_details(str(e))
            return routing_pb2.RouteResponse()
            
        logging.info("Computed 3 routes successfully.")
        
        proto_routes = []
        for r_data in routes_data:
            str_path = []
            if r_data["path"]:
                for node in r_data["path"]:
                    node_data = self.routing_service.G.nodes[node]
                    pos = node_data.get('pos')
                    if pos:
                        lon, lat = pos
                        str_path.append(f"{lat},{lon}")
                    else:
                        str_path.append(str(node))
            
            proto_route = routing_pb2.Route(
                path=str_path,
                distance=float(r_data["distance"]),
                estimated_time=float(r_data["time"]),
                route_type=r_data["type"]
            )
            proto_routes.append(proto_route)
        
        return routing_pb2.RouteResponse(routes=proto_routes)

def serve():
    port = '50051'
    server = grpc.server(futures.ThreadPoolExecutor(max_workers=10))
    routing_pb2_grpc.add_RoutingServiceServicer_to_server(RoutingServicer(), server)
    server.add_insecure_port(f'[::]:{port}')
    server.start()
    logging.info(f"Server started, listening on {port}")
    server.wait_for_termination()

if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO)
    serve()

