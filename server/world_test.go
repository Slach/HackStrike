package main

import (
	"testing"
	"time"
)

func testWorldWithEmbeddedMap(t *testing.T) (*world, *time.Time) {
	t.Helper()
	w := newWorld(mustParseEmbeddedMap(t))
	clock := time.UnixMilli(1_700_000_000_000)
	w.now = func() time.Time { return clock }
	return w, &clock
}

// Join: балансировка по численности, welcome с id/team/tick.
func TestJoinBalanceAndWelcome(t *testing.T) {
	w, _ := testWorldWithEmbeddedMap(t)

	p1 := w.addPlayer(1, "a", "sniper")
	p2 := w.addPlayer(2, "b", "assault")
	p3 := w.addPlayer(3, "c", "heavy")
	if !(p1.team == 0 && p2.team == 1 && p3.team == 0) {
		t.Fatalf("balance by headcount: teams %d %d %d", p1.team, p2.team, p3.team)
	}
	out := w.takeOut()
	if len(out) != 3 {
		t.Fatalf("want 3 welcome messages, got %d", len(out))
	}
	wm := out[2].msg
	if wm["t"] != "welcome" || wm["id"] != uint64(3) || wm["team"] != 0 {
		t.Fatalf("welcome: %+v", wm)
	}
	if _, ok := wm["tick"]; !ok {
		t.Fatalf("welcome must carry tick")
	}
	// Класс по умолчанию для мусорного cls.
	p4 := w.addPlayer(4, "", "bogus")
	if p4.cls != defaultClass || p4.name != "player" {
		t.Fatalf("default class/name: cls=%s name=%s", p4.cls, p4.name)
	}
}

// Input: лимит 60/с — всё сверх отбрасывается (не применяется).
func TestInputRateLimit(t *testing.T) {
	w, _ := testWorldWithEmbeddedMap(t)
	pl := w.addPlayer(1, "a", "assault")
	w.takeOut()

	for i := 0; i < 70; i++ {
		w.handleMessage(pl, message{"t": "input", "seq": float64(i + 1), "yaw": 1.0, "pitch": 0.5,
			"keys": map[string]any{"w": 1.0}})
	}
	if pl.yaw != 1.0 {
		t.Fatalf("input within the window must apply, yaw=%v", pl.yaw)
	}
	// 61-е и дальше отброшены: yaw не обновился.
	for i := 0; i < 10; i++ {
		w.handleMessage(pl, message{"t": "input", "yaw": 2.0, "keys": map[string]any{}})
	}
	if pl.yaw != 1.0 {
		t.Fatalf("input over 60/s must be dropped, yaw=%v", pl.yaw)
	}
	// Через секунду окно обновляется.
	w.now = func() time.Time { return time.UnixMilli(1_700_000_001_000) }
	w.handleMessage(pl, message{"t": "input", "yaw": 3.0, "keys": map[string]any{}})
	if pl.yaw != 3.0 {
		t.Fatalf("input after the window must apply again, yaw=%v", pl.yaw)
	}
}

// Респаун: только мёртвым и только после respawnAt; класс можно сменить.
func TestRespawnRules(t *testing.T) {
	w, clock := testWorldWithEmbeddedMap(t)
	pl := w.addPlayer(1, "a", "sniper")
	w.takeOut()

	// Живому респаун не положен.
	w.handleMessage(pl, message{"t": "respawn", "cls": "heavy"})
	if pl.cls != "sniper" || !pl.alive {
		t.Fatalf("alive player must not respawn")
	}

	// Смерть от своего же (friendly fire).
	pl.hp = 1
	w.damage(pl, pl)
	if pl.alive {
		t.Fatalf("setup: player must be dead")
	}

	// Слишком рано — отказ.
	*clock = clock.Add(3 * time.Second)
	w.handleMessage(pl, message{"t": "respawn", "cls": "heavy"})
	if pl.alive {
		t.Fatalf("respawn before respawnAt must be rejected")
	}

	// После 5 с — респаун на своей базе со сменой класса.
	*clock = clock.Add(3 * time.Second)
	w.handleMessage(pl, message{"t": "respawn", "cls": "heavy"})
	if !pl.alive || pl.cls != "heavy" || pl.hp != classes["heavy"].hp {
		t.Fatalf("respawn failed: alive=%v cls=%s hp=%d", pl.alive, pl.cls, pl.hp)
	}
	spawns := w.m.teamSpawns(pl.team)
	ok := false
	for _, s := range spawns {
		if pl.pos == (vec3{s[0], s[1], s[2]}) {
			ok = true
		}
	}
	if !ok {
		t.Fatalf("respawn must be on the team base, pos=%v", pl.pos)
	}
}

// Матч: победа по фрагам → matchend → сброс счёта, следующий матч стартует.
func TestMatchEndByFrags(t *testing.T) {
	w, _ := testWorldWithEmbeddedMap(t)
	w.fragLimit = 1
	killer := w.addPlayer(1, "k", "sniper")
	victim := w.addPlayer(2, "v", "assault")
	victim.team = 1
	victim.hp = 1 // одно попадание снайпера (80) убивает — это и есть фраг
	w.takeOut()

	w.damage(killer, victim)
	w.simulateTick() // matchCheck внутри тика

	var matchend *message
	for _, om := range w.takeOut() {
		if om.msg["t"] == "matchend" {
			m := om.msg
			matchend = &m
		}
	}
	if matchend == nil {
		t.Fatalf("matchend must be broadcast when frag limit is reached")
	}
	if (*matchend)["winner"] != 0 {
		t.Fatalf("winner = %v, want 0", (*matchend)["winner"])
	}
	sc := (*matchend)["scores"].([2]int)
	if sc != [2]int{1, 0} {
		t.Fatalf("matchend scores = %v", sc)
	}
	if w.scores != [2]int{0, 0} {
		t.Fatalf("scores must reset after matchend, got %v", w.scores)
	}
	// Следующий матч перезапускается на ближайшем тике (игроки остались).
	w.simulateTick()
	if !w.matchActive {
		t.Fatalf("next match must restart while players remain")
	}
	want := w.matchLen.Milliseconds()
	if got := w.timeLeftMs(); got > want || got < want-1000 {
		t.Fatalf("restarted match timer: timeLeftMs=%d want~%d", got, want)
	}
}

// Матч: конец по таймеру, ничья → winner -1.
func TestMatchEndByTimerDraw(t *testing.T) {
	w, clock := testWorldWithEmbeddedMap(t)
	w.matchLen = 2 * time.Second
	w.addPlayer(1, "a", "assault")
	w.addPlayer(2, "b", "assault")
	w.simulateTick()
	w.takeOut()

	*clock = clock.Add(3 * time.Second)
	w.simulateTick()

	for _, om := range w.takeOut() {
		if om.msg["t"] == "matchend" {
			if om.msg["winner"] != -1 {
				t.Fatalf("draw winner = %v, want -1", om.msg["winner"])
			}
			return
		}
	}
	t.Fatalf("matchend by timer missing")
}

// Снап: все поля §9.2 + timeLeft/timeLeftMs в мс, safe=false, порядок по id.
func TestSnapFields(t *testing.T) {
	w, _ := testWorldWithEmbeddedMap(t)
	w.addPlayer(2, "b", "hacker") // первый join → team 0
	w.addPlayer(1, "a", "sniper") // второй → team 1
	w.takeOut()

	w.simulateTick()
	var snap message
	for _, om := range w.takeOut() {
		if om.msg["t"] == "snap" {
			snap = om.msg
		}
	}
	if snap == nil {
		t.Fatalf("tick must broadcast a snap")
	}
	if snap["tick"] != uint64(1) {
		t.Fatalf("snap.tick = %v", snap["tick"])
	}
	if _, ok := snap["now"]; !ok {
		t.Fatalf("snap.now missing")
	}
	players := snap["players"].([]snapPlayer)
	if len(players) != 2 || players[0].ID != 1 || players[1].ID != 2 {
		t.Fatalf("players must be sorted by id: %+v", players)
	}
	if p0 := players[0]; p0.Name != "a" || p0.Team != 1 || p0.Cls != "sniper" {
		t.Fatalf("snap player 1: %+v", p0)
	}
	p := players[1]
	if p.Name != "b" || p.Team != 0 || p.Cls != "hacker" || !p.Alive || p.Safe {
		t.Fatalf("snap player fields: %+v", p)
	}
	if p.HP != classes["hacker"].hp {
		t.Fatalf("snap hp = %d", p.HP)
	}
	if _, ok := snap["scores"].([2]int); !ok {
		t.Fatalf("snap.scores missing")
	}
	tlMs, ok1 := snap["timeLeftMs"]
	tl, ok2 := snap["timeLeft"]
	if !ok1 || !ok2 || tlMs.(int64) != tl.(int64) {
		t.Fatalf("timeLeft (%v) and timeLeftMs (%v) must both be milliseconds and equal", tl, tlMs)
	}
	if want := w.matchLen.Milliseconds(); tl.(int64) > want || tl.(int64) < want-100 {
		t.Fatalf("fresh match timeLeft = %v, want ~%d", tl, want)
	}
}

// Комната (без WS): join-сообщение создаёт игрока и шлёт welcome, ping — pong,
// второй join игнорируется, leave убирает игрока.
func TestRoomMessageFlow(t *testing.T) {
	m := mustParseEmbeddedMap(t)
	r := newRoom(m)
	r.world.now = func() time.Time { return time.UnixMilli(1_700_000_000_000) }

	c1 := &client{id: 1, send: make(chan message, 8)}
	c2 := &client{id: 2, send: make(chan message, 8)}
	r.handleConnect(c1)
	r.handleConnect(c2)

	r.handleInput(taggedMessage{from: c1, msg: message{"t": "join", "name": "alice", "cls": "sniper"}})
	wl := (<-c1.send)
	if wl["t"] != "welcome" || wl["id"] != uint64(1) || wl["team"] != 0 {
		t.Fatalf("welcome after join: %+v", wl)
	}
	r.handleInput(taggedMessage{from: c2, msg: message{"t": "join", "name": "bob", "cls": "heavy"}})
	wl2 := (<-c2.send)
	if wl2["team"] != 1 {
		t.Fatalf("second player joins the emptier team: %+v", wl2)
	}
	// Двойной join не создаёт второго игрока.
	r.handleInput(taggedMessage{from: c1, msg: message{"t": "join", "name": "alice2", "cls": "hacker"}})
	if got := len(r.world.players); got != 2 {
		t.Fatalf("duplicate join must be ignored, players=%d", got)
	}
	if r.world.players[1].cls != "sniper" || r.world.players[1].name != "alice" {
		t.Fatalf("duplicate join must not mutate the player")
	}

	r.handleInput(taggedMessage{from: c1, msg: message{"t": "ping", "c": 42.0}})
	ponged := (<-c1.send)
	if ponged["t"] != "pong" || ponged["c"] != 42.0 {
		t.Fatalf("ping/pong: %+v", ponged)
	}

	// Тик шлёт snap обоим.
	r.world.simulateTick()
	r.flush()
	s1, s2 := (<-c1.send), (<-c2.send)
	if s1["t"] != "snap" || s2["t"] != "snap" {
		t.Fatalf("both clients must receive snaps: %+v", s1)
	}
	if len(s1["players"].([]snapPlayer)) != 2 {
		t.Fatalf("snap must list both players")
	}

	// Leave: игрок удалён, канал закрыт.
	r.handleLeave(c1)
	if _, ok := r.world.players[1]; ok {
		t.Fatalf("leave must remove the player")
	}
	if _, open := <-c1.send; open {
		t.Fatalf("leave must close the send channel")
	}
}

// Drop-политика: переполненный send-канал не блокирует комнату.
func TestSendDropPolicy(t *testing.T) {
	r := newRoom(mustParseEmbeddedMap(t))
	c := &client{id: 7, send: make(chan message, 1)}
	r.handleConnect(c)
	r.sendTo(c, message{"t": "x"})
	r.sendTo(c, message{"t": "y"}) // дропнута, не блокируется
	if len(c.send) != 1 {
		t.Fatalf("buffer must hold 1, got %d", len(c.send))
	}
}
