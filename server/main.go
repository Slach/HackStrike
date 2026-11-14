// HackStrike game server skeleton.
//
// No gameplay yet: one room, fixed 30 Hz tick, authoritative snapshots over
// WebSocket. Its only job is to validate the full pipeline
// browser -> nginx(/ws) -> zrok -> this server.
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

const tickRate = 30

// message is one JSON frame in either direction; "t" discriminates the kind.
type message map[string]any

type client struct {
	id   uint64
	conn *websocket.Conn
	send chan message // fed by the room goroutine, drained by the writer
}

type taggedMessage struct {
	from *client
	msg  message
}

// room owns all game state in a single goroutine: no mutexes, joins/leaves
// and player input arrive via channels. This is the pattern the real game
// logic will grow inside.
type room struct {
	clients map[uint64]*client
	join    chan *client
	leave   chan *client
	inputs  chan taggedMessage
	tick    uint64
}

var nextClientID atomic.Uint64

func newRoom() *room {
	return &room{
		clients: make(map[uint64]*client),
		join:    make(chan *client),
		leave:   make(chan *client),
		inputs:  make(chan taggedMessage, 128),
	}
}

func (r *room) run(ctx context.Context) {
	ticker := time.NewTicker(time.Second / tickRate)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case c := <-r.join:
			r.clients[c.id] = c
			r.sendTo(c, message{"t": "hello", "id": c.id, "tick": r.tick})
			log.Printf("room: client %d joined (%d online)", c.id, len(r.clients))
		case c := <-r.leave:
			if _, ok := r.clients[c.id]; !ok {
				continue // duplicate leave, already gone
			}
			delete(r.clients, c.id)
			close(c.send) // stops the writer goroutine
			log.Printf("room: client %d left (%d online)", c.id, len(r.clients))
		case in := <-r.inputs:
			r.handleInput(in)
		case <-ticker.C:
			r.tick++
			r.broadcast(message{
				"t":       "snap",
				"tick":    r.tick,
				"players": len(r.clients),
				"now":     time.Now().UnixMilli(),
			})
		}
	}
}

func (r *room) handleInput(in taggedMessage) {
	switch in.msg["t"] {
	case "ping": // latency probe: echo the client timestamp back
		r.sendTo(in.from, message{
			"t":    "pong",
			"c":    in.msg["c"],
			"s":    time.Now().UnixMilli(),
			"tick": r.tick,
		})
	default:
		log.Printf("room: unknown message from client %d: %v", in.from.id, in.msg)
	}
}

// sendTo never blocks the tick loop: a client too slow to drain its buffer
// just misses messages (and gets dropped once the write deadline kills it).
func (r *room) sendTo(c *client, msg message) {
	select {
	case c.send <- msg:
	default:
		log.Printf("room: dropping message for slow client %d", c.id)
	}
}

func (r *room) broadcast(msg message) {
	for _, c := range r.clients {
		r.sendTo(c, msg)
	}
}

// reader owns the connection lifecycle: when it returns the client is gone.
func (r *room) reader(ctx context.Context, c *client) {
	defer func() {
		r.leave <- c
		_ = c.conn.Close(websocket.StatusNormalClosure, "bye")
	}()
	for {
		var msg message
		if err := wsjson.Read(ctx, c.conn, &msg); err != nil {
			return
		}
		select {
		case r.inputs <- taggedMessage{from: c, msg: msg}:
		case <-ctx.Done():
			return
		}
	}
}

// writer serializes sends on the connection (coder/websocket allows one
// concurrent writer) and enforces a write deadline per frame.
func writer(ctx context.Context, c *client) {
	for msg := range c.send {
		wctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		err := wsjson.Write(wctx, c.conn, msg)
		cancel()
		if err != nil {
			_ = c.conn.Close(websocket.StatusInternalError, "write failed")
			return // reader notices the closed conn and reports the leave
		}
	}
}

func (r *room) handleWS(w http.ResponseWriter, req *http.Request) {
	conn, err := websocket.Accept(w, req, nil)
	if err != nil {
		log.Printf("ws: accept: %v", err)
		return
	}
	// TODO(game-design): validate Origin once the game has a fixed home.
	ctx, cancel := context.WithCancel(req.Context())
	defer cancel()

	c := &client{id: nextClientID.Add(1), conn: conn, send: make(chan message, 64)}
	r.join <- c
	go writer(ctx, c)
	r.reader(ctx, c) // blocks until the client disconnects
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

func main() {
	addr := flag.String("addr", ":8080", "listen address")
	healthcheck := flag.Bool("healthcheck", false, "probe /healthz on the given address and exit")
	flag.Parse()

	if *healthcheck {
		os.Exit(runHealthcheck(*addr))
	}

	r := newRoom()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go r.run(ctx)

	http.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})
	http.HandleFunc("/ws", r.handleWS)

	log.Printf("HackStrike server skeleton listening on %s (tick %d Hz)", *addr, tickRate)
	log.Fatal(http.ListenAndServe(*addr, nil))
}
