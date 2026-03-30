FROM golang:1.25.5-alpine AS builder
WORKDIR /app
ENV GO111MODULE=auto
COPY . .
WORKDIR /app/cmd/server
RUN go build -o /app/rescuemind-api main.go

FROM alpine:latest
WORKDIR /app
COPY --from=builder /app/rescuemind-api .
EXPOSE 8080
CMD ["./rescuemind-api"]
