// HackStrike game server.
//
// Authoritative-сервер (ГДД §9.1): одна комната-горутина, фиксированный тик
// 30 Гц, JSON поверх WS. Карта встроена (go:embed) и раздаётся клиенту через
// GET /api/map — единый источник геометрии.
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"time"
)

func main() {
	addr := flag.String("addr", ":8080", "listen address")
	healthcheck := flag.Bool("healthcheck", false, "probe /healthz on the given address and exit")
	flag.Parse()

	if *healthcheck {
		os.Exit(runHealthcheck(*addr))
	}

	m, err := parseGameMap(h2dm1JSON)
	if err != nil {
		log.Fatalf("map: embedded h2dm1.json is broken: %v", err)
	}

	r := newRoom(m)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go r.run(ctx)

	log.Fatal(http.ListenAndServe(*addr, newHTTPMux(r)))

	log.Printf("HackStrike server listening on %s (tick %d Hz, map %s: %d colliders)",
		*addr, tickRate, m.Name, len(m.Colliders))
	log.Fatal(http.ListenAndServe(*addr, nil))
}

// newHTTPMux — HTTP-роуты: healthz, карта (единый источник геометрии),
// WebSocket игры.
func newHTTPMux(r *room) *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})
	mux.HandleFunc("/api/map", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(h2dm1JSON)
	})
	mux.HandleFunc("/ws", r.handleWS)
	// §15.40: диагностика ввода по нику: держатель стенда включает тестеру
	// счётчики («побегай, я сам вытащу») и забирает накопленный дамп (nginx
	// проксирует /api префиксом).
	mux.HandleFunc("/api/diag", r.handleDiagGET)
	mux.HandleFunc("/api/diagdump", r.handleDiagDumpGET)
	return mux
}

// runHealthcheck backs `game-server -healthcheck`: a GET against our own
// /healthz endpoint. Exists because the docker image is FROM scratch (no
// shell, no wget), so the binary probes itself for the compose healthcheck.
func runHealthcheck(addr string) int {
	hostPort := addr
	if strings.HasPrefix(addr, ":") { // ":8080" -> probe localhost
		hostPort = "127.0.0.1" + addr
	}
	url := "http://" + hostPort + "/healthz"
	client := &http.Client{Timeout: 2 * time.Second}
	resp, err := client.Get(url)
	if err != nil {
		fmt.Fprintln(os.Stderr, "healthcheck:", err)
		return 1
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		fmt.Fprintln(os.Stderr, "healthcheck: unexpected status", resp.StatusCode)
		return 1
	}
	return 0
}
