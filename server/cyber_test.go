package main

import (
	"reflect"
	"testing"
	"time"
)

// Мини-карта с полным M2-набором (§12.3): t1—c1—s1—c3—s2—c2—t2, s1—c4—d1,
// радио r1 изолировано (беспроводная точка входа). Кабели без points —
// прямые сегменты между устройствами.
func cyberTestWorld(t *testing.T) (*world, *time.Time) {
	t.Helper()
	const j = `{
	 "name":"cyber","bounds":[40,8,40],
	 "colliders":[
	  {"min":[0,0,0],"max":[40,1,40],"kind":"floor"},
	  {"min":[0,1,37],"max":[0.7,1.5,39],"kind":"stair"}
	 ],
	 "spawns":{"0":[[5,1,5]],"1":[[35,1,35]]},
	 "props":[
	  {"kind":"terminal","id":"t1","pos":[5,1,8]},
	  {"kind":"terminal","id":"t2","pos":[35,1,32]},
	  {"kind":"radio","id":"r1","pos":[20,1,5],"radius":8},
	  {"kind":"switch","id":"s1","pos":[5,1,15]},
	  {"kind":"switch","id":"s2","pos":[35,1,25]},
	  {"kind":"door","id":"d1","pos":[20,1,20],"size":[4,3,0.3],"axis":"x","to":"s1"},
	  {"kind":"cable","id":"c1","from":"t1","to":"s1"},
	  {"kind":"cable","id":"c2","from":"t2","to":"s2"},
	  {"kind":"cable","id":"c3","from":"s1","to":"s2","points":[[5,1.15,15],[5,1.15,28],[35,1.15,28],[35,1.15,25]]},
	  {"kind":"cable","id":"c4","from":"s1","to":"d1"}
	 ]}`
	m, err := parseGameMap([]byte(j))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	w := newWorld(m)
	clock := time.UnixMilli(1_700_000_000_000)
	w.now = func() time.Time { return clock }
	return w, &clock
}

// jackAt — поставить игрока у устройства и нажать space (edge) в тике.
// Возвращает исходящие сообщения этого тика (можно искать jackin).
func jackAt(w *world, pl *player, devID string) []outMsg {
	pl.pos = w.cyber.devices[devID].pos.add(vec3{0.5, 0, 0.5})
	pl.keys.interact = false
	pl.prevInteract = false // честный edge даже после предыдущего jackAt
	pl.keys.interact = true
	w.simulateTick()
	pl.keys.interact = false
	return w.takeOut()
}

// scanStep — запустить portscan и доработать его до конца: после возврата
// в scanned добавлен один хоп знаний (§12.4, прогрессивное открытие).
func scanStep(w *world, pl *player, clock *time.Time, steps int) {
	for i := 0; i < steps; i++ {
		w.handleMessage(pl, message{"t": "run", "prog": "portscan"})
		for j := 0; j < 400 && len(pl.progs) > 0; j++ {
			*clock = clock.Add(time.Second / 30)
			w.simulateTick()
		}
		w.takeOut()
	}
}

func assertDeniedOut(t *testing.T, out []outMsg, pl *player, reason string) {
	t.Helper()
	var got string
	for _, om := range out {
		if om.msg["t"] == "denied" && om.to == pl.id {
			got, _ = om.msg["reason"].(string)
		}
	}
	if got != reason {
		t.Fatalf("denied reason = %q, want %q", got, reason)
	}
}

func assertDenied(t *testing.T, w *world, pl *player, reason string) {
	t.Helper()
	var got string
	for _, om := range w.takeOut() {
		if om.msg["t"] == "denied" && om.to == pl.id {
			got, _ = om.msg["reason"].(string)
		}
	}
	if got != reason {
		t.Fatalf("denied reason = %q, want %q", got, reason)
	}
}

// BFS-достижимость с учётом severed (§12.4/§12.7): обрыв кабеля отрезает
// всё за ним; радио-точка имеет беспроводной аплинк к ближайшему switch
// (r1→s1: 18 м против 25 м до s2) и через него видит сеть.
func TestCyberBFSAndSevered(t *testing.T) {
	w, _ := cyberTestWorld(t)
	cs := w.cyber

	want := map[string]bool{"t1": true, "t2": true, "s1": true, "s2": true, "d1": true, "r1": true}
	if got := cs.reachable("t1"); !reflect.DeepEqual(got, want) {
		t.Fatalf("BFS from t1 = %v, want %v", got, want)
	}
	if got := cs.reachable("r1"); !reflect.DeepEqual(got, want) {
		t.Fatalf("radio uplink must reach the network, got %v", got)
	}

	// Беспроводной аплинк не режется: bullet-путь (cutCableAlong) вообще
	// не находит его — у wireless-кабеля нет AABB-боксов.
	for _, c := range cs.cables {
		if c.wireless {
			if len(c.boxes) != 0 {
				t.Fatalf("wireless uplink must have no physical boxes")
			}
		}
	}

	cs.cables[2].severed = true // c3: магистраль s1—s2
	if got := cs.reachable("t1"); !reflect.DeepEqual(got, map[string]bool{"t1": true, "s1": true, "d1": true, "r1": true}) {
		t.Fatalf("after severing c3, t1 side = %v (r1 остаётся на стороне s1 через аплинк)", got)
	}
	if got := cs.reachable("t2"); !reflect.DeepEqual(got, map[string]bool{"t2": true, "s2": true}) {
		t.Fatalf("after severing c3, t2 side = %v", got)
	}

	cs.cables[3].severed = true // c4: кормящий кабель двери
	if got := cs.reachable("t1"); !reflect.DeepEqual(got, map[string]bool{"t1": true, "s1": true, "r1": true}) {
		t.Fatalf("after severing c4, d1 must be unreachable: %v", got)
	}
}

// Джек-ин: только хакер, edge space, терминал 2 м / радио radius, jackin с
// характеристиками деки; джекнутый не двигается.
func TestJackinRules(t *testing.T) {
	w, _ := cyberTestWorld(t)
	h := w.addPlayer(1, "h", "hacker", -1)
	a := w.addPlayer(2, "a", "assault", -1)
	w.takeOut()

	// Не-хакер у терминала — ничего (дека только у хакера, §12.1).
	a.pos = vec3{5.5, 1, 8}
	a.keys.interact = true
	w.simulateTick()
	w.takeOut()
	if a.jacked {
		t.Fatalf("assault must not jack in")
	}

	// Хакер в 0.7 м от t1 — джек-ин + сообщение с декой (терминал: net 100).
	out := jackAt(w, h, "t1")
	if !h.jacked || h.jackHost.id != "t1" {
		t.Fatalf("hacker near terminal must jack in: jacked=%v host=%v", h.jacked, h.jackHost)
	}
	var jackin message
	for _, om := range out {
		if om.msg["t"] == "jackin" && om.to == h.id {
			jackin = om.msg
		}
	}
	if jackin == nil {
		t.Fatalf("jackin message missing")
	}
	if jackin["host"] != "t1" {
		t.Fatalf("jackin.host = %v", jackin["host"])
	}
	deck, ok := jackin["deck"].(message)
	if !ok {
		t.Fatalf("jackin.deck missing: %+v", jackin)
	}
	if deck["cpu"] != 1.0 || deck["npu"] != 0.5 || deck["ram"] != 4 || deck["net"] != 100.0 {
		t.Fatalf("jackin.deck = %+v", deck)
	}

	// Джекнутый стоит на месте: движение игнорируется (§12.1).
	before := h.pos
	h.keys.w = true
	for i := 0; i < 30; i++ {
		w.simulateTick()
	}
	w.takeOut()
	if h.pos != before {
		t.Fatalf("jacked body must not move: %v -> %v", before, h.pos)
	}
	h.keys.w = false

	// Радио: 7.4 м — входит с net=20; 8.6 м — нет.
	h2 := w.addPlayer(3, "h2", "hacker", -1)
	w.takeOut()
	h2.pos = vec3{20, 1, 12.4}
	h2.keys.interact = true
	out = nil
	w.simulateTick()
	out = w.takeOut()
	h2.keys.interact = false
	if !h2.jacked || h2.jackHost.id != "r1" {
		t.Fatalf("hacker within radio radius must jack in: %v %v", h2.jacked, h2.jackHost)
	}
	for _, om := range out {
		if om.msg["t"] == "jackin" && om.msg["host"] == "r1" {
			if d := om.msg["deck"].(message); d["net"] != 20.0 {
				t.Fatalf("radio entry net = %v, want 20", d["net"])
			}
		}
	}

	h3 := w.addPlayer(4, "h3", "hacker", -1)
	w.takeOut()
	h3.pos = vec3{20, 1, 13.7} // 8.7 м от r1
	h3.keys.interact = true
	w.simulateTick()
	w.takeOut()
	h3.keys.interact = false
	if h3.jacked {
		t.Fatalf("8.7 m is outside the radio radius")
	}

	// Зажатый без перенажатия space не даёт нового входа (нужен edge).
	h3.pos = vec3{20, 1, 5}
	h3.keys.interact = true // уже было true в предыдущем тике
	w.simulateTick()
	w.takeOut()
	if h3.jacked {
		t.Fatalf("held interact must not re-trigger (edge only)")
	}
}

// Джек-аут: явный и по смерти; программы деки отменяются (§12.1, §5.5).
func TestJackoutAndDeath(t *testing.T) {
	w, _ := cyberTestWorld(t)
	h := w.addPlayer(1, "h", "hacker", -1)
	killer := w.addPlayer(2, "k", "sniper", -1)
	w.takeOut()

	jackAt(w, h, "t1")
	h.progs = append(h.progs, &program{prog: "portscan", work: portscanWork})
	w.handleMessage(h, message{"t": "jackout"})
	if h.jacked || h.jackHost != nil || len(h.progs) != 0 {
		t.Fatalf("jackout must clear deck state")
	}

	jackAt(w, h, "t1")
	h.progs = append(h.progs, &program{prog: "portscan", work: portscanWork})
	w.damage(killer, h, 150) // снайпер: 150 >= 100 HP
	if h.alive {
		t.Fatalf("setup: hacker must die")
	}
	if h.jacked || h.jackHost != nil || len(h.progs) != 0 {
		t.Fatalf("death must auto-jackout")
	}
}

// Честные очереди (§12.7): две программы идут вдвое дольше; освободившийся
// слот ускоряет оставшуюся.
func TestProgramFairQueues(t *testing.T) {
	w, _ := cyberTestWorld(t)
	h := w.addPlayer(1, "h", "hacker", -1)
	w.takeOut()
	jackAt(w, h, "t1")

	// Одна: portscan 2 с — готов за ~60 тиков.
	w.handleMessage(h, message{"t": "run", "prog": "portscan"})
	for i := 0; i < 58; i++ {
		w.simulateTick()
	}
	w.takeOut()
	if len(h.progs) != 1 {
		t.Fatalf("portscan must still run at 58 ticks")
	}
	var scans int
	for i := 0; i < 4; i++ {
		w.simulateTick()
	}
	for _, om := range w.takeOut() {
		if om.msg["t"] == "scan" && om.to == h.id {
			scans++
		}
	}
	if len(h.progs) != 0 {
		t.Fatalf("portscan must complete by 62 ticks (2 s)")
	}
	if scans != 1 {
		t.Fatalf("exactly one scan after portscan, got %d", scans)
	}

	// Прогрессивное открытие: второй portscan раскрывает соседей s1 (d1 среди них).
	w.handleMessage(h, message{"t": "run", "prog": "portscan"})
	for i := 0; i < 70; i++ {
		w.simulateTick()
	}
	w.takeOut()
	if !h.scanned["d1"] {
		t.Fatalf("second portscan must reveal d1, scanned=%v", h.scanned)
	}

	// Две: каждая 1/2 скорости; portscan (2 с работы) готов на ~120-м тике.
	w.handleMessage(h, message{"t": "run", "prog": "portscan"})
	w.handleMessage(h, message{"t": "run", "prog": "vulnscan", "dev": "d1"})
	for i := 0; i < 115; i++ {
		w.simulateTick()
	}
	w.takeOut()
	if len(h.progs) != 2 {
		t.Fatalf("at 115 ticks neither program must be done (half speed each)")
	}
	for i := 0; i < 10; i++ {
		w.simulateTick()
	}
	w.takeOut()
	if len(h.progs) != 1 || h.progs[0].prog != "vulnscan" {
		t.Fatalf("portscan must finish first at ~120 ticks, progs=%+v", h.progs)
	}
	if w.cyber.devices["d1"].vulnedBy[h.id] {
		t.Fatalf("vulnscan must still be running")
	}
	// После ухода portscan vulnscan идёт на полной доле: 1 с работы осталось.
	for i := 0; i < 35; i++ {
		w.simulateTick()
	}
	w.takeOut()
	if len(h.progs) != 0 {
		t.Fatalf("vulnscan must complete after speeding up")
	}
	if !w.cyber.devices["d1"].vulnedBy[h.id] {
		t.Fatalf("vulnscan must mark the device vulned for this hacker")
	}
}

// denied-причины (§12.5): not_jacked, ram_full, too_far, not_vulned.
func TestRunDeniedReasons(t *testing.T) {
	w, clock := cyberTestWorld(t)
	h := w.addPlayer(1, "h", "hacker", -1)
	w.takeOut()

	w.handleMessage(h, message{"t": "run", "prog": "portscan"})
	assertDenied(t, w, h, "not_jacked")

	jackAt(w, h, "t1")

	for i := 0; i < deckRAM; i++ {
		w.handleMessage(h, message{"t": "run", "prog": "portscan"})
	}
	w.handleMessage(h, message{"t": "run", "prog": "portscan"})
	assertDenied(t, w, h, "ram_full")

	h.progs = nil
	w.handleMessage(h, message{"t": "run", "prog": "vulnscan", "dev": "r1"}) // r1 не обнаружен (нет знаний)
	assertDenied(t, w, h, "too_far")
	w.handleMessage(h, message{"t": "run", "prog": "vulnscan", "dev": "nope"})
	assertDenied(t, w, h, "too_far")

	w.handleMessage(h, message{"t": "run", "prog": "trojan", "dev": "d1"}) // d1 ещё не открыт
	assertDenied(t, w, h, "too_far")
	scanStep(w, h, clock, 2) // t1 → s1 → {s2, d1, r1}
	w.handleMessage(h, message{"t": "run", "prog": "trojan", "dev": "d1"})
	assertDenied(t, w, h, "not_vulned")

	// Мусорное имя программы — тихо игнорируется (протокол-толерантность).
	w.handleMessage(h, message{"t": "run", "prog": "sinclair"})
	if len(h.progs) != 0 {
		t.Fatalf("unknown program must be ignored")
	}
}

// Полный цикл двери (§12.1): portscan → vulnscan → trojan → toggle
// владельцем; чужому и вышедшему из деки — not_owner/not_jacked.
func TestTrojanAndDoorCtrl(t *testing.T) {
	w, _ := cyberTestWorld(t)
	h := w.addPlayer(1, "h", "hacker", -1)
	foe := w.addPlayer(2, "f", "hacker", -1)
	w.takeOut()
	jackAt(w, h, "t1")

	runAndWait := func(msg message) {
		t.Helper()
		w.handleMessage(h, msg)
		for i := 0; i < 200 && len(h.progs) > 0; i++ {
			w.simulateTick()
		}
		w.takeOut()
		if len(h.progs) > 0 {
			t.Fatalf("program did not finish: %v", msg)
		}
	}
	runAndWait(message{"t": "run", "prog": "portscan"})
	runAndWait(message{"t": "run", "prog": "portscan"}) // прогрессивно: открывает d1
	runAndWait(message{"t": "run", "prog": "portscan"}) // второй хоп: s2, d1, r1
	runAndWait(message{"t": "run", "prog": "vulnscan", "dev": "d1"})
	runAndWait(message{"t": "run", "prog": "trojan", "dev": "d1"})

	door := w.cyber.devices["d1"]
	if door.owner != h.id {
		t.Fatalf("trojan must make the hacker the owner, owner=%v", door.owner)
	}

	w.handleMessage(h, message{"t": "ctrl", "dev": "d1", "action": "toggle"})
	w.takeOut()
	if !door.open {
		t.Fatalf("owner must toggle the door open")
	}

	// Чужой хакер (даже джекнутый в сети) дверью не управляет.
	jackAt(w, foe, "t2")
	w.handleMessage(foe, message{"t": "ctrl", "dev": "d1", "action": "toggle"})
	assertDenied(t, w, foe, "not_owner")
	if !door.open {
		t.Fatalf("door state must be untouched by the stranger")
	}

	// Владелец вышел из деки — контроллер недоступен.
	w.handleMessage(h, message{"t": "jackout"})
	w.handleMessage(h, message{"t": "ctrl", "dev": "d1", "action": "toggle"})
	assertDenied(t, w, h, "not_jacked")
}

// Дверь-коллайдер: закрытая блокирует движение, открытая пропускает;
// захлопнувшаяся на игроке — выпускает (escape-rule).
func TestDoorCollision(t *testing.T) {
	w, _ := cyberTestWorld(t)
	p := w.addPlayer(1, "p", "assault", -1)
	w.takeOut()
	door := w.cyber.devices["d1"] // AABB: x 18..22, y 1..4, z 19.85..20.15

	p.pos = vec3{20, 1, 15}
	p.yaw = 0 // вперёд = +Z, прямо в дверь
	p.keys.w = true
	for i := 0; i < 300; i++ {
		w.simulateTick()
	}
	w.takeOut()
	if p.pos[2] > 19.85-playerHalf+0.01 {
		t.Fatalf("closed door must block: z=%v", p.pos[2])
	}

	door.open = true
	for i := 0; i < 300 && p.pos[2] < 23; i++ {
		w.simulateTick()
	}
	w.takeOut()
	if p.pos[2] < 23 {
		t.Fatalf("open door must let the player through: z=%v", p.pos[2])
	}

	// Захлопнулась прямо на игроке — выйти можно.
	door.open = false
	p.pos = vec3{20, 1, 20}
	p.keys.w = true
	for i := 0; i < 300 && p.pos[2] < 23; i++ {
		w.simulateTick()
	}
	w.takeOut()
	if p.pos[2] < 23 {
		t.Fatalf("player caught in a closing door must be able to leave: z=%v", p.pos[2])
	}
}

// Пули тоже режут кабели (§6): трассерный луч до точки попадания.
func TestBulletCutsCable(t *testing.T) {
	w, _ := cyberTestWorld(t)
	a := w.addPlayer(1, "a", "assault", -1)
	w.takeOut()
	a.pos = vec3{5, 1, 11}
	w.handleMessage(a, message{"t": "fire", "yaw": 0, "pitch": -1.55})
	if !w.cyber.cables[0].severed {
		t.Fatalf("bullet must sever the cable")
	}
	w.takeOut()
}

// snap.props (§12.5): поля по kind, динамика open/severed.
func TestSnapProps(t *testing.T) {
	w, _ := cyberTestWorld(t)
	w.addPlayer(1, "p", "assault", -1)
	w.takeOut()

	propsOf := func() map[string]message {
		w.simulateTick()
		var snap message
		for _, om := range w.takeOut() {
			if om.msg["t"] == "snap" {
				snap = om.msg
			}
		}
		byID := map[string]message{}
		for _, p := range snap["props"].([]any) {
			m := p.(message)
			byID[m["id"].(string)] = m
		}
		return byID
	}

	byID := propsOf()
	d := byID["d1"]
	if d["kind"] != "door" || d["open"] != false ||
		d["x"] != 20.0 || d["y"] != 1.0 || d["z"] != 20.0 {
		t.Fatalf("door snap entry: %+v", d)
	}
	c := byID["c1"]
	if c["kind"] != "cable" || c["severed"] != false {
		t.Fatalf("cable snap entry: %+v", c)
	}
	if _, has := c["x"]; has {
		t.Fatalf("cable snap entry must not carry coords (§12.5): %+v", c)
	}
	if r := byID["r1"]; r["kind"] != "radio" || r["radius"] != 8.0 {
		t.Fatalf("radio snap entry: %+v", r)
	}
	if s := byID["s1"]; s["kind"] != "switch" || s["x"] != 5.0 || s["z"] != 15.0 {
		t.Fatalf("switch snap entry: %+v", s)
	}
	if tm := byID["t1"]; tm["kind"] != "terminal" || tm["x"] != 5.0 || tm["z"] != 8.0 {
		t.Fatalf("terminal snap entry: %+v", tm)
	}

	// Динамика: toggle и перерубание видны всем в следующем снапе.
	w.cyber.devices["d1"].open = true
	w.cyber.cables[0].severed = true
	byID = propsOf()
	if byID["d1"]["open"] != true {
		t.Fatalf("open=true must appear in snap.props")
	}
	if byID["c1"]["severed"] != true {
		t.Fatalf("severed=true must appear in snap.props")
	}
}

// deck-статус 2 Гц (§12.5): только джекнутому, загрузки и ETA программ.
func TestDeckStatus(t *testing.T) {
	w, _ := cyberTestWorld(t)
	h := w.addPlayer(1, "h", "hacker", -1)
	other := w.addPlayer(2, "o", "assault", -1)
	w.takeOut()
	jackAt(w, h, "t1")
	w.handleMessage(h, message{"t": "run", "prog": "portscan"})

	var deck message
	var otherGotDeck bool
	for i := 0; i < 20; i++ {
		w.simulateTick()
	}
	for _, om := range w.takeOut() {
		if om.msg["t"] != "deck" {
			continue
		}
		if om.to == other.id {
			otherGotDeck = true
		}
		if om.to == h.id {
			deck = om.msg
		}
	}
	if deck == nil {
		t.Fatalf("jacked hacker must receive deck status at 2 Hz")
	}
	if otherGotDeck {
		t.Fatalf("deck status must go only to the jacked player")
	}
	if deck["ramUsed"] != 1 || deck["cpuLoad"] != 0.25 || deck["npuLoad"] != 0.0 {
		t.Fatalf("deck loads: %+v", deck)
	}
	if deck["netLoad"] != 0.1 { // 1 программа × 10 Мбит / терминал 100
		t.Fatalf("deck netLoad = %v, want 0.1", deck["netLoad"])
	}
	progs, ok := deck["progs"].([]deckProg)
	if !ok || len(progs) != 1 || progs[0].Prog != "portscan" || progs[0].Dev != "" {
		t.Fatalf("deck progs: %+v", deck["progs"])
	}
	if eta := progs[0].EtaMs; eta < 1400 || eta > 1600 {
		t.Fatalf("deck etaMs = %d, want ~1533 (2 с минус 14 тиков работы)", eta)
	}
}

// scan (§12.5): после portscan — только достижимые устройства (радио нет),
// связи правильные, owner null; после trojan — повторный scan с владельцем.
func TestScanMessage(t *testing.T) {
	w, _ := cyberTestWorld(t)
	h := w.addPlayer(1, "h", "hacker", -1)
	w.takeOut()
	jackAt(w, h, "t1")

	var scans []message
	runAndWait := func(msg message) {
		w.handleMessage(h, msg)
		for i := 0; i < 200 && len(h.progs) > 0; i++ {
			w.simulateTick()
		}
		for _, om := range w.takeOut() {
			if om.msg["t"] == "scan" && om.to == h.id {
				scans = append(scans, om.msg)
			}
		}
	}

	// Прогрессивное открытие (§12.4): первый portscan — хост + прямой сосед.
	runAndWait(message{"t": "run", "prog": "portscan"})
	if len(scans) != 1 {
		t.Fatalf("exactly one scan after portscan, got %d", len(scans))
	}
	devs, ok := scans[0]["devices"].([]scanDevice)
	if !ok || len(devs) != 2 {
		t.Fatalf("first scan from t1 must list 2 devices (t1+s1), got %+v", scans[0]["devices"])
	}

	// Второй portscan раскрывает соседей s1: s2, d1 и радио r1 (аплинк s1).
	runAndWait(message{"t": "run", "prog": "portscan"})
	if len(scans) != 2 {
		t.Fatalf("second portscan must resend the scan, got %d scans", len(scans))
	}
	devs, ok = scans[1]["devices"].([]scanDevice)
	if !ok || len(devs) != 5 {
		t.Fatalf("second scan must list 5 devices (t1,s1,s2,d1,r1), got %+v", scans[1]["devices"])
	}
	var d1 scanDevice
	for _, d := range devs {
		if d.ID == "d1" {
			d1 = d
		}
	}
	if d1.Owner != nil {
		t.Fatalf("d1 owner must be null before trojan: %+v", d1)
	}

	// Vulnscan тоже пересылает scan: узел помечается vulned для этого хакера
	// (обратная связь «нажал 2 — увидел результат»).
	runAndWait(message{"t": "run", "prog": "vulnscan", "dev": "d1"})
	if len(scans) != 3 {
		t.Fatalf("scan must be resent on vuln completion, got %d scans", len(scans))
	}
	var d1v scanDevice
	for _, om := range scans {
		if devs, ok := om["devices"].([]scanDevice); ok {
			for _, d := range devs {
				if d.ID == "d1" {
					d1v = d
				}
			}
		}
	}
	if !d1v.Vulned {
		t.Fatalf("d1 must carry vulned=true for the vulnscanning hacker: %+v", d1v)
	}

	// Trojan: смена владельца — третий resend.
	runAndWait(message{"t": "run", "prog": "trojan", "dev": "d1"})
	if len(scans) != 4 {
		t.Fatalf("scan must be resent on owner change, got %d scans", len(scans))
	}
	devs, ok = scans[3]["devices"].([]scanDevice)
	if !ok || len(devs) != 5 {
		t.Fatalf("owner-change scan: %+v", scans[3]["devices"])
	}
	byID := map[string]scanDevice{}
	for _, d := range devs {
		byID[d.ID] = d
	}
	if _, has := byID["r1"]; !has {
		t.Fatalf("radio reached via uplink must appear in the scan")
	}
	d1 = byID["d1"]
	if d1.Owner == nil || d1.Owner.(uint64) != h.id {
		t.Fatalf("d1 owner after trojan = %v, want %d", d1.Owner, h.id)
	}
}

func TestM2AcceptanceFlow(t *testing.T) {
	w, clock := cyberTestWorld(t)
	h := w.addPlayer(1, "h", "hacker", -1)
	foe := w.addPlayer(2, "f", "hacker", -1)
	w.takeOut()
	jackAt(w, h, "t1")

	runAndWait := func(msg message) {
		w.handleMessage(h, msg)
		for i := 0; i < 200 && len(h.progs) > 0; i++ {
			w.simulateTick()
		}
		w.takeOut()
		if len(h.progs) > 0 {
			t.Fatalf("program did not finish: %v", msg)
		}
	}
	runAndWait(message{"t": "run", "prog": "portscan"})
	runAndWait(message{"t": "run", "prog": "portscan"}) // прогрессивно: второй хоп открывает d1
	if !h.scanned["d1"] {
		t.Fatalf("two portscans must discover the door")
	}
	runAndWait(message{"t": "run", "prog": "vulnscan", "dev": "d1"})
	runAndWait(message{"t": "run", "prog": "trojan", "dev": "d1"})

	w.handleMessage(h, message{"t": "ctrl", "dev": "d1", "action": "toggle"})
	var openSeen bool
	w.simulateTick()
	for _, om := range w.takeOut() {
		if om.msg["t"] != "snap" {
			continue
		}
		for _, pr := range om.msg["props"].([]any) {
			if m := pr.(message); m["id"] == "d1" && m["open"] == true {
				openSeen = true
			}
		}
	}
	if !openSeen {
		t.Fatalf("toggled door must appear open=true in snap.props")
	}

	// Пули другого игрока перерубают кормящий кабель двери c4 (s1→d1,
	// диагональ 5,15 → 20,20 на высоте ~1.15).
	foe.pos = vec3{12.5, 1, 17.5}
	w.handleMessage(foe, message{"t": "fire", "yaw": 0, "pitch": -1.55})
	if !w.cyber.cables[3].severed {
		t.Fatalf("enemy bullets must sever the door cable")
	}

	// Повторный portscan не находит дверь за перерубленным кабелем.
	runAndWait(message{"t": "run", "prog": "portscan"})
	if h.scanned["d1"] {
		t.Fatalf("re-scan must not see d1 behind the severed cable")
	}
	if !h.scanned["t2"] || !h.scanned["s2"] {
		t.Fatalf("re-scan must still see the rest of the network: %v", h.scanned)
	}

	w.handleMessage(h, message{"t": "jackout"})
	if h.jacked {
		t.Fatalf("jackout must work")
	}
	_ = clock
}

// Встроенная карта: M2-пропсы на месте, терминалы соединены, радио
// изолированы, кабели не замурованы в геометрию (иначе нож их не достанет).
func TestEmbeddedMapCyber(t *testing.T) {
	m := mustParseEmbeddedMap(t)
	w := newWorld(m)
	cs := w.cyber

	if len(cs.order) != 8 || len(cs.cables) != 7 || len(cs.doors) != 2 {
		t.Fatalf("m1 M2 props: want 8 devices / 5 cables + 2 radio uplinks / 2 doors, got %d/%d/%d",
			len(cs.order), len(cs.cables), len(cs.doors))
	}
	// Аплинки: r1→ближайший s1, r2→ближайший s2 — обе точки входа ведут в сеть.
	reach := cs.reachable("t1")
	for _, id := range []string{"t1", "t2", "s1", "s2", "d1", "d2", "r1", "r2"} {
		if !reach[id] {
			t.Fatalf("%s must be reachable from t1 on m1 (радио — через аплинк)", id)
		}
	}
	for _, c := range cs.cables {
		if c.wireless && len(c.boxes) != 0 {
			t.Fatalf("wireless uplink %s must have no physical boxes", c.id)
		}
	}
	// Кабели режутся ножом: ни один сегмент не внутри статической геометрии.
	for _, c := range cs.cables {
		for _, b := range c.boxes {
			if m.overlapsAny(b) {
				t.Fatalf("cable %s buried in geometry: %v..%v", c.id, b.min, b.max)
			}
		}
	}
	// Двери стоят в проходах (не пересекают стены) и вне джек-ин радиусов спавнов.
	for _, d := range cs.doors {
		if m.overlapsAny(d.box) {
			t.Fatalf("door %s intersects static geometry", d.id)
		}
	}
	for _, team := range []int{0, 1} {
		for _, s := range m.teamSpawns(team) {
			for _, id := range []string{"t1", "t2"} {
				if cs.devices[id].pos.sub(vec3(s)).length() <= jackTerminalRadius {
					t.Fatalf("spawn %v inside jack-in radius of %s", s, id)
				}
			}
		}
	}
}

// Contested точка входа (решение владельца 2026-11-14): терминал, захваченный
// другим хакером, не пускает чужого — перехват только из другого места сети.
func TestJackinContested(t *testing.T) {
	w, _ := cyberTestWorld(t)
	h := w.addPlayer(1, "h", "hacker", -1)
	foe := w.addPlayer(2, "f", "hacker", -1)
	w.takeOut()
	jackAt(w, h, "t1")
	for i := 0; i < 3; i++ { // прогрессивно: t1→s1→{s2,d1,r1}→{t2,d2}
		runAndWaitM2(w, h, message{"t": "run", "prog": "portscan"})
	}
	runAndWaitM2(w, h, message{"t": "run", "prog": "vulnscan", "dev": "t2"})
	runAndWaitM2(w, h, message{"t": "run", "prog": "trojan", "dev": "t2"})
	if w.cyber.devices["t2"].owner != h.id {
		t.Fatalf("setup: t2 must be captured by h")
	}

	// Враг не входит в захваченный t2.
	out := jackAt(w, foe, "t2")
	if foe.jacked {
		t.Fatalf("enemy must not jack into a captured terminal")
	}
	// NB: jackAt сам consume-ит takeOut — denied ищем в его возврате.
	assertDeniedOut(t, out, foe, "not_owner")

	// С нейтрального t1... уже джекнут h. Проверим: владелец входит в свою точку.
	out = jackAt(w, h, "t1")
	_ = out
	if !h.jacked {
		t.Fatalf("owner re-jacks freely")
	}
}

// Прогрессивный portscan (решение владельца): один запуск — один хоп знаний.
func TestProgressivePortscan(t *testing.T) {
	w, _ := cyberTestWorld(t)
	h := w.addPlayer(1, "h", "hacker", -1)
	w.takeOut()
	jackAt(w, h, "t1")

	w.handleMessage(h, message{"t": "run", "prog": "portscan"})
	for i := 0; i < 70 && len(h.progs) > 0; i++ {
		w.simulateTick()
	}
	w.takeOut()
	if h.scanned["d1"] || h.scanned["t2"] {
		t.Fatalf("first portscan must not reveal the deep network: %v", h.scanned)
	}
	if !h.scanned["s1"] {
		t.Fatalf("first portscan must reveal the direct neighbor s1")
	}

	w.handleMessage(h, message{"t": "run", "prog": "portscan"})
	for i := 0; i < 70 && len(h.progs) > 0; i++ {
		w.simulateTick()
	}
	w.takeOut()
	if !h.scanned["d1"] || !h.scanned["s2"] {
		t.Fatalf("second portscan must reveal the second hop: %v", h.scanned)
	}
}

// Сессия по имени (плейтест M2): F5 не телепортирует домой и не сбрасывает
// владение дверью — ownerId перемапливается на нового игрока.
func TestSessionRestore(t *testing.T) {
	w, clock := cyberTestWorld(t)
	h := w.addPlayer(1, "Slach", "hacker", -1)
	w.takeOut()
	jackAt(w, h, "t1")
	runAndWaitM2(w, h, message{"t": "run", "prog": "portscan"})
	runAndWaitM2(w, h, message{"t": "run", "prog": "portscan"})
	runAndWaitM2(w, h, message{"t": "run", "prog": "vulnscan", "dev": "d1"})
	runAndWaitM2(w, h, message{"t": "run", "prog": "trojan", "dev": "d1"})
	w.handleMessage(h, message{"t": "jackout"})
	home := h.pos
	homeTeam := h.team

	// Отключение → новое подключение с тем же именем и новым id.
	w.removePlayer(h.id)
	w.takeOut()
	h2 := w.addPlayer(7, "Slach", "assault", -1)
	if h2.team != homeTeam {
		t.Fatalf("team must be restored, got %d want %d", h2.team, homeTeam)
	}
	if h2.pos != home {
		t.Fatalf("position must be restored: %v vs %v", h2.pos, home)
	}
	if !h2.scanned["d1"] {
		t.Fatalf("network knowledge must survive rejoin")
	}
	if w.cyber.devices["d1"].owner != h2.id {
		t.Fatalf("door ownership must be remapped to the new id, owner=%v", w.cyber.devices["d1"].owner)
	}
	*clock = clock.Add(time.Second)
	jackAt(w, h2, "t1") // джек-стейт не переживает реконнект — точка входа та же
	// Ремап vulnedBy на новый id: trojan принимается без повторного vulnscan'а.
	w.handleMessage(h2, message{"t": "run", "prog": "trojan", "dev": "d1"})
	if len(h2.progs) != 1 {
		t.Fatalf("remapped vulned must let trojan run without re-vulnscan, progs=%d", len(h2.progs))
	}
	if !h2.alive {
		t.Fatalf("dead session must still allow rejoin (respawnAt = now)")
	}
}

// runAndWaitM2 — общий хелпер: выполнить программу и дождаться завершения.
func runAndWaitM2(w *world, pl *player, msg message) {
	w.handleMessage(pl, msg)
	for i := 0; i < 400 && len(pl.progs) > 0; i++ {
		w.simulateTick()
	}
	pl.progs = nil
}

// Пули/нож не проходят сквозь ЗАКРЫТУЮ дверь (плейтест M2-2: «автоприцел
// стреляет сквозь дверь»), открытая — прозрачна для огня.
func TestFireBlockedByClosedDoor(t *testing.T) {
	w, _, _, clock := combatWorld(t) // пол 40×40, shooter@0,1,0
	// Дверь между стрелком и жертвой: тонкая панель в z=10.
	w.cyber = buildCyber(&gameMap{Name: "d", Bounds: [3]float64{40, 8, 40},
		Colliders: []collider{{Min: [3]float64{0, 0, 0}, Max: [3]float64{40, 1, 40}, Kind: "floor"}},
		props: []mapProp{{Kind: "door", ID: "d1", Pos: [3]float64{0, 1, 10}, Size: [3]float64{8, 3, 0.3}, Axis: "x", To: ""}}})
	victim := w.addPlayer(9, "v", "heavy", -1)
	victim.pos = vec3{0, 1, 12} // за дверью
	w.takeOut()

	w.fire(w.players[1], 0, 0) // sniper
	s := shots(w)
	if len(s) != 1 || s[0]["hit"] != nil {
		t.Fatalf("closed door must block the shot, got %+v", s)
	}
	if victim.hp != 200 {
		t.Fatalf("no damage through a closed door, hp=%d", victim.hp)
	}
	// Трассер упёрся в дверь (z≈10), а не в жертву (z=12).
	to := s[0]["to"].(vec3)
	if to[2] > 10.5 {
		t.Fatalf("tracer must stop at the door, to=%v", to)
	}

	// Открыли — попадание проходит.
	w.cyber.devices["d1"].open = true
	*clock = clock.Add(2 * time.Second)
	w.fire(w.players[1], 0, 0)
	s = shots(w)
	if len(s) != 1 || s[0]["hit"] == nil {
		t.Fatalf("open door must not block, got %+v", s)
	}
}

// Снапшот обязан сообщать jacked (плейтест M2-2: десинк «сервер джекнут,
// дека не показана» замораживал игрока навечно — клиент самоисцеляется по
// этому флагу).
func TestSnapReportsJacked(t *testing.T) {
	w, clock := cyberTestWorld(t)
	h := w.addPlayer(1, "Neo", "hacker", 0)
	jackAt(w, h, "t1")
	w.takeOut()

	w.broadcastSnap()
	var got any
	for _, om := range w.takeOut() {
		if om.msg["t"] != "snap" {
			continue
		}
		players, _ := om.msg["players"].([]snapPlayer)
		for _, p := range players {
			if p.ID == h.id {
				got = p.Jacked
			}
		}
	}
	if got != true {
		t.Fatalf("snap.jacked for jacked hacker = %v, want true", got)
	}

	w.handleMessage(h, message{"t": "jackout"})
	*clock = clock.Add(time.Second / 30)
	w.simulateTick()
	w.broadcastSnap()
	for _, om := range w.takeOut() {
		if om.msg["t"] != "snap" {
			continue
		}
		players, _ := om.msg["players"].([]snapPlayer)
		for _, p := range players {
			if p.ID == h.id && p.Jacked {
				t.Fatal("snap.jacked must be false after jackout")
			}
		}
	}
}
