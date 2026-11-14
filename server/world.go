package main

import (
	"math/rand"
	"sort"
	"strconv"
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
	posHistoryLen = 8 // тиков позиции для lag compensation (~267 мс)
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
	cyber   *cyberState

	matchActive bool
	matchEndsAt time.Time
	fragLimit   int
	matchLen    time.Duration

	// now инъектится для тестов; в проде time.Now.
	now func() time.Time
	out []outMsg

	// sessions — отключившиеся игроки по имени: F5/обрыв не должен
	// телепортировать домой и сбрасывать захваты (плейтест M2).
	sessions map[string]*session
}

// sessionTTL — сколько ждём вернувшегося игрока.
const sessionTTL = 5 * time.Minute

// session — что переживает переподключение. oldID нужен, чтобы перемапить
// device.owner/vulnedBy на новый id.
type session struct {
	oldID    uint64
	team     int
	cls      string
	pos      vec3
	vy       float64
	grounded bool
	hp       int
	alive    bool
	scanned  map[string]bool
	at       time.Time
}

func newWorld(m *gameMap) *world {
	return &world{
		m:         m,
		players:   make(map[uint64]*player),
		sessions:  make(map[string]*session),
		cyber:     buildCyber(m),
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
	w.jackout(pl) // телепорт (респаун/ребаланс) выкидывает из деки
	cls, st := classOr(cls)
	pl.cls = cls
	pos := vec3{0, 1, 0} // fallback для карт без спавнов (тестовые мини-арены)
	if spawns := w.m.teamSpawns(pl.team); len(spawns) > 0 {
		s := spawns[rand.Intn(len(spawns))]
		pos = vec3{s[0], s[1], s[2]}
	}
	pl.pos = pos
	pl.posHist = pl.posHist[:0] // rewind не должен смотреть на позицию до спавна
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

// uniqueName — имена в комнате уникальны: занятое имя получает суффикс -2,
// -3… (в комнате не должно быть двух «Slach», иначе ростер/киллфед нечитаемы).
func (w *world) uniqueName(want string) string {
	base := sanitizeName(want)
	name := base
	for i := 2; i < 100; i++ {
		taken := false
		for _, p := range w.players {
			if p.name == name {
				taken = true
				break
			}
		}
		if !taken {
			return name
		}
		name = base + "-" + strconv.Itoa(i)
	}
	return name
}

// addPlayer — вход в игру по "join": спавн, welcome. Команда: просьба
// игрока (wantTeam 0|1) уважается, если не создаёт перекос ≥2 (друзья,
// зашедшие вместе, больше не окажутся в одной команде из-за тай-брейка
// балансира); -1 = обычный баланс по численности.
func (w *world) addPlayer(id uint64, name, cls string, wantTeam int) *player {
	team := w.pickTeam()
	if wantTeam == 0 || wantTeam == 1 {
		counts := [2]int{}
		for _, p := range w.players {
			counts[p.team]++
		}
		if counts[wantTeam]+1-counts[1-wantTeam] < 2 {
			team = wantTeam
		}
	}
	pl := &player{id: id, name: w.uniqueName(name), team: team}
	canon := sanitizeName(name)
	if s, ok := w.sessions[canon]; ok && w.now().Sub(s.at) < sessionTTL {
		// Вернувшийся игрок: команда/позиция/класс/hp/знания сети как было,
		// владение устройствами и vulned-заметки перемапливаются на новый id.
		delete(w.sessions, canon)
		team = s.team
		pl.team = team
		pl.cls, pl.pos, pl.vy, pl.grounded = s.cls, s.pos, s.vy, s.grounded
		pl.hp, pl.alive, pl.scanned = s.hp, s.alive, s.scanned
		for _, d := range w.cyber.devices {
			if d.owner == s.oldID {
				d.owner = id
			}
			if d.vulnedBy[s.oldID] {
				d.vulnedBy[id] = true
				delete(d.vulnedBy, s.oldID)
			}
			if d.watcherBy[s.oldID] { // §13.1: F5 не снимает watcher'ы
				d.watcherBy[id] = true
				delete(d.watcherBy, s.oldID)
			}
		}
		if !pl.alive {
			pl.respawnAt = w.now()
		}
	} else {
		w.spawnPlayer(pl, cls)
	}
	w.players[id] = pl
	w.startMatchIfNeeded()
	w.sendTo(id, message{"t": "welcome", "id": id, "team": pl.team, "tick": w.tick})
	return pl
}

func (w *world) removePlayer(id uint64) {
	if pl, ok := w.players[id]; ok {
		// Сессия по имени: F5/обрыв восстанавливает команду, позицию, класс,
		// hp, знания сети; владение устройствами перемапится на новый id
		// при возврате (см. addPlayer). Экспирация — sessionTTL.
		w.sessions[pl.name] = &session{
			oldID:    id,
			team:     pl.team,
			cls:      pl.cls,
			pos:      pl.pos,
			vy:       pl.vy,
			grounded: pl.grounded,
			hp:       pl.hp,
			alive:    pl.alive,
			scanned:  pl.scanned,
			at:       w.now(),
		}
	}
	delete(w.players, id)
}

// rebalanceTeams — если команды перекошены на 2+ (ушёл игрок, призрак
// отключился), последнего пришедшего из большой команды перекидываем в
// меньшую: респаун на новой базе + уведомление {"t":"team"}. Вызывается
// каждый тик — состояние самоизлечивается из любой ситуации.
func (w *world) rebalanceTeams() {
	for {
		counts := [2]int{}
		for _, p := range w.players {
			counts[p.team]++
		}
		from, to := 0, 1
		if counts[1]-counts[0] >= 2 {
			from, to = 1, 0
		} else if counts[0]-counts[1] < 2 {
			return
		}
		// Последний пришедший — максимальный id (id монотонны). Джекнутых
		// не трогаем: телепорт хакера из-под деки ломает сессию сканирования.
		var mover *player
		for _, p := range w.players {
			if p.team == from && !p.jacked && (mover == nil || p.id > mover.id) {
				mover = p
			}
		}
		if mover == nil {
			return // двигать некого (все джекнуты) — подождём, Jack-out ослабит перекос
		}
		mover.team = to
		if mover.alive {
			w.spawnPlayer(mover, mover.cls)
		}
		w.sendTo(mover.id, message{"t": "team", "team": to})
	}
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
	case "jackout": // CTRL/CMD+ALT+DEL, мгновенно (§12.1)
		w.jackout(pl)
	case "run": // программа деки (§12.5)
		w.handleRun(pl, msg)
	case "ctrl": // контроллер устройства (§12.5)
		w.handleCtrl(pl, msg)
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
// инпута (джекнутый стоит) с историей позиций для lag compensation →
// кибер-слой (очереди программ, edge-джек-ин) → проверка конца матча →
// снапшот всем.
func (w *world) simulateTick() {
	w.tick++
	for _, pl := range w.players {
		if pl.alive {
			w.movePlayer(pl, tickDT)
			pl.posHist = append(pl.posHist, pl.pos)
			if len(pl.posHist) > posHistoryLen {
				pl.posHist = pl.posHist[len(pl.posHist)-posHistoryLen:]
			}
		}
		w.cyberTick(pl, tickDT)
		w.interactTick(pl)
	}
	w.matchCheck()
	w.rebalanceTeams()
	w.deckStatusTick()
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
	// Jacked — хакер стоит в деке (M2): тело уязвимо и не двигается. Клиент
	// использует флаг для самоисцеления десинка «сервер джекнут, дека не
	// показана» — иначе ESC мёртв и игрок застревает (плейтест M2-2).
	Jacked bool `json:"jacked,omitempty"`
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
			HP: p.hp, Alive: p.alive, Safe: false, Jacked: p.jacked,
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
		"props":      w.cyber.snapProps(), // M2: двери/кабели/точки входа (§12.5)
	})
}
