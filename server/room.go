package main

import (
	"context"
	"log"
	"net/http"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

const tickRate = 30

var nextClientID atomic.Uint64

type client struct {
	id   uint64
	conn *websocket.Conn
	send chan message // fed by the room goroutine, drained by the writer
}

type taggedMessage struct {
	from *client
	msg  message
}

// room — единственный владелец игрового состояния (инвариант 2 из
// AGENTS.md): join/leave/inputs приходят по каналам, вся мутация мира —
// здесь; world только накапливает исходящие сообщения.
type room struct {
	world   *world
	clients map[uint64]*client
	join    chan *client
	leave   chan *client
	inputs   chan taggedMessage
	diag     chan diagToggle    // §15.40: переключатель диагностики по нику
	diagDump chan diagDumpReq   // §15.40: выгрузка накопленных записей
}

func newRoom(m *gameMap) *room {
	return &room{
		world:   newWorld(m),
		clients: make(map[uint64]*client),
		join:    make(chan *client),
		leave:   make(chan *client),
		inputs:  make(chan taggedMessage, 128),
		diag:    make(chan diagToggle),
		diagDump: make(chan diagDumpReq),
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
			r.handleConnect(c)
		case c := <-r.leave:
			r.handleLeave(c)
		case in := <-r.inputs:
			r.handleInput(in)
		case cmd := <-r.diag:
			cmd.reply <- r.handleDiag(cmd) // §15.40
			r.flush()
		case q := <-r.diagDump:
			r.handleDiagDump(q) // §15.40
		case <-ticker.C:
			r.world.simulateTick()
			r.flush()
		}
	}
}

func (r *room) handleConnect(c *client) {
	r.clients[c.id] = c
	log.Printf("room: client %d connected (%d online)", c.id, len(r.clients))
}

func (r *room) handleLeave(c *client) {
	if _, ok := r.clients[c.id]; !ok {
		return // duplicate leave, already gone
	}
	delete(r.clients, c.id)
	r.world.removePlayer(c.id)
	close(c.send) // stops the writer goroutine
	log.Printf("room: client %d left (%d online)", c.id, len(r.clients))
}

func (r *room) handleInput(in taggedMessage) {
	switch in.msg["t"] {
	case "ping": // latency probe: echo the client timestamp back
		r.sendTo(in.from, message{
			"t":    "pong",
			"c":    in.msg["c"],
			"s":    time.Now().UnixMilli(),
			"tick": r.world.tick,
		})
	case "join":
		if _, playing := r.world.players[in.from.id]; playing {
			return // повторный join игнорируем
		}
		wantTeam := -1 // -1 = авто-баланс; 0|1 = просьба игрока
		switch num(in.msg, "team") {
		case 0:
			wantTeam = 0
		case 1:
			wantTeam = 1
		}
		r.world.addPlayer(in.from.id, str(in.msg, "name"), str(in.msg, "cls"), wantTeam)
		log.Printf("room: player %d joined team %d as %s", in.from.id,
			r.world.players[in.from.id].team, r.world.players[in.from.id].cls)
	default:
		if pl := r.world.players[in.from.id]; pl != nil {
			r.world.handleMessage(pl, in.msg)
		}
	}
	r.flush()
}

// flush — доставка исходящих сообщений мира нужным клиентам.
func (r *room) flush() {
	for _, om := range r.world.takeOut() {
		if om.to == 0 {
			r.broadcast(om.msg)
		} else if c := r.clients[om.to]; c != nil {
			r.sendTo(c, om.msg)
		}
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
