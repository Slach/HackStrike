package main

import (
	"math/rand"
	"sort"
	"time"
)

// Игровые константы матча (ГДД §3.3): респаун 5 с, лимит 50 фрагов,
// матч 10 минут с момента первого join.
const (
	respawnDelay  = 5 * time.Second
	matchDuration = 10 * time.Minute
	fragLimit     = 50
	maxInputRate  = 60 // input-сообщений в секунду; сверх — отбрасываем
	tickDT        = 1.0 / float64(tickRate)
)

// outMsg — исходящее сообщение; to == 0 значит broadcast.
type outMsg struct {
	to  uint64
	msg message
}

// world — состояние матча. Трогает только горутина комнаты (инвариант 2);
// исходящие сообщения копятся в out и флашатся комнатой.
type world struct {
	m       *gameMap
	players map[uint64]*player
	scores  [2]int
	tick    uint64

	matchActive bool
	matchEndsAt time.Time
	fragLimit   int
	matchLen    time.Duration

	// now инъектится для тестов; в проде time.Now.
	now func() time.Time
	out []outMsg
}

func newWorld(m *gameMap) *world {
	return &world{
		m:         m,
		players:   make(map[uint64]*player),
		fragLimit: fragLimit,
		matchLen:  matchDuration,
		now:       time.Now,
	}
}

func (w *world) sendTo(id uint64, msg message) { w.out = append(w.out, outMsg{id, msg}) }
func (w *world) broadcast(msg message)         { w.out = append(w.out, outMsg{0, msg}) }
func (w *world) takeOut() []outMsg             { o := w.out; w.out = nil; return o }

// pickTeam — балансировка по численности: в меньшую команду, при равенстве в 0.
func (w *world) pickTeam() int {
	counts := [2]int{}
	for _, p := range w.players {
		counts[p.team]++
	}
	if counts[0] <= counts[1] {
		return 0
	}
	return 1
}

// spawnPlayer — (пере)спавн на своей базе: полный HP класса, точка из пула.
func (w *world) spawnPlayer(pl *player, cls string) {
	cls, st := classOr(cls)
	pl.cls = cls
	pos := vec3{0, 1, 0} // fallback для карт без спавнов (тестовые мини-арены)
	if spawns := w.m.teamSpawns(pl.team); len(spawns) > 0 {
		s := spawns[rand.Intn(len(spawns))]
		pos = vec3{s[0], s[1], s[2]}
	}
	pl.pos = pos
	pl.vy = 0
	pl.grounded = true
	pl.hp = st.hp
	pl.alive = true
}

// startMatchIfNeeded — таймер матча стартует с первым игроком (§3.3).
func (w *world) startMatchIfNeeded() {
	if !w.matchActive && len(w.players) > 0 {
		w.matchActive = true
		w.matchEndsAt = w.now().Add(w.matchLen)
	}
}

// addPlayer — вход в игру по "join": баланс команд, спавн, welcome.
func (w *world) addPlayer(id uint64, name, cls string) *player {
	pl := &player{id: id, name: sanitizeName(name), team: w.pickTeam()}
	w.spawnPlayer(pl, cls)
	w.players[id] = pl
	w.startMatchIfNeeded()
	w.sendTo(id, message{"t": "welcome", "id": id, "team": pl.team, "tick": w.tick})
	return pl
}

func (w *world) removePlayer(id uint64) {
	delete(w.players, id)
}

// handleMessage — C→S игровые сообщения (кроме join/ping, это комната).
func (w *world) handleMessage(pl *player, msg message) {
	switch msg["t"] {
	case "input":
		w.handleInput(pl, msg)
	case "fire":
		w.handleFire(pl, msg)
	case "respawn":
		w.handleRespawn(pl, str(msg, "cls"))
	}
}

// handleInput — кламп частоты (>60/с отбрасываем) и хранение последнего
// инпута; движение применится в тике.
func (w *world) handleInput(pl *player, msg message) {
	now := w.now()
	if pl.inputWindowStart.IsZero() || now.Sub(pl.inputWindowStart) >= time.Second {
		pl.inputWindowStart = now
		pl.inputCount = 0
	}
	pl.inputCount++
	if pl.inputCount > maxInputRate {
		return
	}
	pl.yaw = num(msg, "yaw")
	pl.pitch = clampPitch(num(msg, "pitch"))
	if seq := num(msg, "seq"); seq > 0 {
		pl.inputSeq = uint64(seq)
	}
	if keys, ok := msg["keys"].(map[string]any); ok {
		pl.keys = keysState{
			w:        keyBool(keys, "w"),
			a:        keyBool(keys, "a"),
			s:        keyBool(keys, "s"),
			d:        keyBool(keys, "d"),
			interact: keyBool(keys, "interact"),
		}
	}
}

// handleRespawn — только мёртвым и после respawnAt; класс можно сменить.
func (w *world) handleRespawn(pl *player, cls string) {
	if pl.alive || w.now().Before(pl.respawnAt) {
		return
	}
	w.spawnPlayer(pl, cls)
}

// simulateTick — порядок симуляции: номер тика → движение из последнего
// инпута → проверка конца матча → снапшот всем.
func (w *world) simulateTick() {
	w.tick++
	for _, pl := range w.players {
		if pl.alive {
			w.m.movePlayer(pl, tickDT)
		}
	}
	w.matchCheck()
	w.broadcastSnap()
}

// matchCheck — победа по фрагам или таймеру; после конца счёт и таймер
// сбрасываются, игроки остаются и следующий матч стартует тут же.
func (w *world) matchCheck() {
	if !w.matchActive {
		w.startMatchIfNeeded()
		return
	}
	now := w.now()
	winner := -1
	switch {
	case w.scores[0] >= w.fragLimit:
		winner = 0
	case w.scores[1] >= w.fragLimit:
		winner = 1
	case !now.Before(w.matchEndsAt):
		if w.scores[0] > w.scores[1] {
			winner = 0
		} else if w.scores[1] > w.scores[0] {
			winner = 1
		}
	default:
		return
	}
	w.broadcast(message{"t": "matchend", "scores": w.scores, "winner": winner})
	w.scores = [2]int{}
	w.matchActive = false
}

// timeLeftMs — сколько осталось текущему матчу.
func (w *world) timeLeftMs() int64 {
	if !w.matchActive {
		return w.matchLen.Milliseconds()
	}
	d := w.matchEndsAt.Sub(w.now()).Milliseconds()
	if d < 0 {
		d = 0
	}
	return d
}

type snapPlayer struct {
	ID    uint64  `json:"id"`
	Name  string  `json:"name"`
	Team  int     `json:"team"`
	Cls   string  `json:"cls"`
	X     float64 `json:"x"`
	Y     float64 `json:"y"`
	Z     float64 `json:"z"`
	Yaw   float64 `json:"yaw"`
	Pitch float64 `json:"pitch"`
	HP    int     `json:"hp"`
	Alive bool    `json:"alive"`
	Safe  bool    `json:"safe"` // всегда false в M1
}

func (w *world) broadcastSnap() {
	ids := make([]uint64, 0, len(w.players))
	for id := range w.players {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	players := make([]snapPlayer, 0, len(ids))
	for _, id := range ids {
		p := w.players[id]
		pos := p.pos.round2()
		players = append(players, snapPlayer{
			ID: p.id, Name: p.name, Team: p.team, Cls: p.cls,
			X: pos[0], Y: pos[1], Z: pos[2],
			Yaw: round3(p.yaw), Pitch: round3(p.pitch),
			HP: p.hp, Alive: p.alive, Safe: false,
		})
	}
	// timeLeft — миллисекунды (клиент M1 читает это поле); timeLeftMs —
	// дубль с тем же значением.
	w.broadcast(message{
		"t":          "snap",
		"tick":       w.tick,
		"now":        w.now().UnixMilli(),
		"players":    players,
		"scores":     w.scores,
		"timeLeft":   w.timeLeftMs(),
		"timeLeftMs": w.timeLeftMs(),
	})
}
