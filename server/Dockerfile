FROM golang:1.27-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/game-server .

FROM scratch
COPY --from=build /out/game-server /game-server
EXPOSE 8080
ENTRYPOINT ["/game-server"]
