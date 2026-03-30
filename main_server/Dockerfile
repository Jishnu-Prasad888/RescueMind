FROM golang:1.24-alpine AS builder
WORKDIR /app
ENV GO111MODULE=auto
COPY . .
RUN go build -o /app/gateway main.go

FROM alpine:latest
WORKDIR /app
COPY --from=builder /app/gateway .
COPY pune_locations.txt .
EXPOSE 6000
CMD ["./gateway"]
