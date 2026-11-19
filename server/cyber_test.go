package main

import (
	"reflect"
	"strings"
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

// BFS-достижимость (§12.4): радио-точка имеет беспроводной аплинк к
// ближайшему switch (r1→s1) и через него видит сеть. M2-2: кабели всегда целы.
func TestCyberBFS(t *testing.T) {
	w, _ := cyberTestWorld(t)
	cs := w.cyber

	want := map[string]bool{"t1": true, "t2": true, "s1": true, "s2": true, "d1": true, "r1": true}
	if got := cs.reachable("t1"); !reflect.DeepEqual(got, want) {
		t.Fatalf("BFS from t1 = %v, want %v", got, want)
	}
	if got := cs.reachable("r1"); !reflect.DeepEqual(got, want) {
		t.Fatalf("radio uplink must reach the network, got %v", got)
	}

	// M2-2: перерубания нет — топология постоянна.
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

// snap.props (§12.5): поля по kind, динамика open.
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
	if _, has := byID["c1"]; has {
		t.Fatalf("cables are not in snap.props anymore (M2-2): %+v", byID["c1"])
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

	// Динамика: toggle виден всем в следующем снапе.
	w.cyber.devices["d1"].open = true
	byID = propsOf()
	if byID["d1"]["open"] != true {
		t.Fatalf("open=true must appear in snap.props")
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

	// M2-2: перерубания нет — повторный portscan видит ту же сеть.
	runAndWait(message{"t": "run", "prog": "portscan"})
	if !h.scanned["d1"] || !h.scanned["t2"] || !h.scanned["s2"] {
		t.Fatalf("re-scan must still see the network: %v", h.scanned)
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

	// M4-объект 1: газы g1/g2 (зеркальные крылья, кабели c8→s2, c14→s1).
	// M4-объект 2 (§14.4): кибер-слой 2 этажа — +5 устройств (s3, t3, d3,
	// cam3, cam4) и +5 кабелей (c9 стояк s2—s3, c10 s3—d3, c11 t3—s3,
	// c12 s3—cam3, c13 s3—cam4).
	// §14.6.1 (ревизия v1): огонь lv1..lv3 — НЕ устройство; клапаны
	// v1..v3 — устройства (+3 к графе), кабели c15/c16/c17 (+3).
	// итерация 3 (§16.5): SRV1 — +1 устройство и +2 кабеля (c33/c34 к s1/s2);
	// код-замок: d4/d5/d6 — +3 двери и +3 кабеля (c35–c37 к s3); клавиатуры
	// на ОБЕИХ сторонах d3–d6 — +8 устройств и +8 кабелей (c380–c387 к s3).
	// итерация 5 (§16.6): NETSAFE — +1 устройство и +1 кабель (c38 к s3, ветка 10).
	if len(cs.order) != 33 || len(cs.cables) != 33 || len(cs.doors) != 6 || len(cs.gases) != 2 {
		t.Fatalf("m1 props: want 33 devices / 31 cables + 2 radio uplinks / 6 doors / 2 gas, got %d/%d/%d/%d",
			len(cs.order), len(cs.cables), len(cs.doors), len(cs.gases))
	}
	if len(cs.fires) != 3 {
		t.Fatalf("m1 must carry 3 fire strips lv1..lv3 (§14.6.1), got %d", len(cs.fires))
	}
	for _, lv := range cs.fires {
		if _, leaked := cs.devices[lv.id]; leaked {
			t.Fatalf("fire %s must not leak into the cyber graph", lv.id)
		}
		if lv.valve == nil {
			t.Fatalf("fire %s must reference its valve (§14.6.1)", lv.id)
		}
	}
	// Клапаны в графе и привязаны к своим switch'ам (v1→s1, v2→s2, v3→s3).
	for _, id := range []string{"v1", "v2", "v3"} {
		if _, ok := cs.devices[id]; !ok {
			t.Fatalf("valve %s must be a cyber device (§14.6.1)", id)
		}
	}
	if cs.fires[0].valve.id != "v1" || cs.fires[1].valve.id != "v2" || cs.fires[2].valve.id != "v3" {
		t.Fatalf("fire→valve binding broken: %s→%s %s→%s %s→%s",
			cs.fires[0].id, cs.fires[0].valve.id, cs.fires[1].id, cs.fires[1].valve.id, cs.fires[2].id, cs.fires[2].valve.id)
	}
	// Аплинки: r1→ближайший s1, r2→ближайший s2 — обе точки входа ведут в сеть.
	// 2 этаж в графе через стояк c9 s2—s3.
	reach := cs.reachable("t1")
	for _, id := range []string{"t1", "t2", "s1", "s2", "d1", "d2", "g1", "g2", "r1", "r2", "cam1", "cam2",
		"s3", "t3", "d3", "cam3", "cam4"} {
		if !reach[id] {
			t.Fatalf("%s must be reachable from t1 on m1 (радио — через аплинк)", id)
		}
	}
	// Двери и газ стоят в проходах/комнатах (не пересекают стены) и вне
	// джек-ин радиусов спавнов. Газ по определению наполняет комнату от пола
	// (min y=0) — пересечение с floor допустимо и ожидаемо, поэтому для газа
	// проверяем только нe-floor коллайдеры.
	for _, d := range cs.doors {
		if m.overlapsAny(d.box) {
			t.Fatalf("door %s intersects static geometry", d.id)
		}
	}
	for _, g := range cs.gases {
		for _, c := range m.Colliders {
			if c.Kind == "floor" {
				continue
			}
			if boxesOverlap(g.box, aabb{vec3(c.Min), vec3(c.Max)}) {
				t.Fatalf("gas %s intersects %s collider %v..%v", g.id, c.Kind, c.Min, c.Max)
			}
		}
	}
	// §14.6.1: полосы огня стоят НА плите (низ 1.0 / 8.0 точно по верху
	// floor — касание, boxesOverlap строгая, не пересекает); floor
	// пропускаем, как у газа, — все не-floor коллайдеры обязаны быть чисты.
	for _, lv := range cs.fires {
		for _, c := range m.Colliders {
			if c.Kind == "floor" {
				continue
			}
			if boxesOverlap(lv.box, aabb{vec3(c.Min), vec3(c.Max)}) {
				t.Fatalf("fire %s intersects %s collider %v..%v", lv.id, c.Kind, c.Min, c.Max)
			}
		}
	}
	for _, team := range []int{0, 1} {
		for _, s := range m.teamSpawns(team) {
			// t3 — точка входа 2 этажа: спавны на первом (y=1), тривиально
			// далеко, но фиксируем инвариант «не на спавне» (§8).
			for _, id := range []string{"t1", "t2", "t3"} {
				if cs.devices[id].pos.sub(vec3(s)).length() <= jackTerminalRadius {
					t.Fatalf("spawn %v inside jack-in radius of %s", s, id)
				}
			}
			// Корпуса устройств (плейтест: «не проходить сквозь сервера,
			// терминалы, камеры и свитчи») не должны накрывать спавн.
			for _, db := range m.deviceBoxes {
				if boxesOverlap(playerBoxAt(vec3(s)), db) {
					t.Fatalf("spawn %v overlaps device body %v", s, db)
				}
			}
		}
	}
	// И сами корпуса не вмурованы в стены (иначе двойная блокировка).
	for _, db := range m.deviceBoxes {
		for _, c := range m.Colliders {
			if c.Kind == "floor" || c.Kind == "stair" {
				continue
			}
			if boxesOverlap(db, aabb{vec3(c.Min), vec3(c.Max)}) {
				t.Fatalf("device body %v intersects %s collider", db, c.Kind)
			}
		}
	}
}

// M4 §14.4: кибер-слой 2 этажа на встроенной карте. Достижим в графе от t1
// через стояк c9 s2—s3; прогрессивный portscan от t1 (hop1 s1 → hop2 s2,d1,
// r1,cam1 → hop3 s3,t2,d2,cam2,g1 → hop4 t3,d3,cam3,cam4) открывает 2 этаж;
// d3 достижима (reachableFor, §13.5) с точки входа t3 и перехватывается с неё
// trojan'ом — т.е. валидация достижимости handleRun/handleCtrl пройдена.
func TestEmbeddedMapCyberFloor2(t *testing.T) {
	m := mustParseEmbeddedMap(t)
	w := newWorld(m)

	// Стояк: 2 этаж в едином графе с нижним сегментом.
	if !w.cyber.reachable("t1")["s3"] {
		t.Fatalf("s3 must be reachable from t1 via the s2—s3 trunk cable")
	}

	h := w.addPlayer(1, "h", "hacker", -1)
	w.takeOut()
	jackAt(w, h, "t1")
	for i := 0; i < 4; i++ { // hop3 открывает s3, hop4 — t3 (т.е. «3+» хопов)
		runAndWaitM2(w, h, message{"t": "run", "prog": "portscan"})
	}
	if !h.scanned["s3"] || !h.scanned["t3"] {
		t.Fatalf("progressive portscans must discover the second floor: scanned=%v", h.scanned)
	}

	// Переход на точку входа 2 этажа: джек-аут, джек-ин у t3 (стоя на плите
	// террасы y=8), дверь data-отсека достижима от неё.
	w.handleMessage(h, message{"t": "jackout"})
	jackAt(w, h, "t3")
	// Тело из лавы: lv3 покрывает весь пол комнаты (плейтест «лава по всей
	// поверхности»), t3 — в её центре, 25 HP/с убивает за тики. Тест
	// проверяет ТОПОЛОГИЮ (t3 → d3), а не урон среды — джекнутый хакер
	// работает из сети, телу достаточно быть живым.
	h.pos = vec3{19, 8, 32} // коридор 2 этажа к западу от d5
	if !h.jacked || h.jackHost.id != "t3" {
		t.Fatalf("hacker must be able to jack into the second-floor entry t3")
	}
	if !w.reachableFor("t3", h)["d3"] {
		t.Fatalf("d3 must be reachable for the hacker from the t3 entry")
	}

	// Trojan на d3 с t3: handleRun валидирует scanned+reachableFor — too_far
	// здесь означал бы, что BFS от t3 не видит дверь.
	runAndWaitM2(w, h, message{"t": "run", "prog": "vulnscan", "dev": "d3"})
	runAndWaitM2(w, h, message{"t": "run", "prog": "trojan", "dev": "d3"})
	if w.cyber.devices["d3"].owner != h.id {
		t.Fatalf("d3 captured from t3 must end owned by h, owner=%v", w.cyber.devices["d3"].owner)
	}
	// §16.7: d3 заперта код-замком — троян НЕ отпирает её, toggle denied
	// locked. После кода с клавиатуры (TestCodeLock) toggle работает.
	w.handleMessage(h, message{"t": "ctrl", "dev": "d3", "action": "toggle"})
	assertDenied(t, w, h, "locked")
	if w.cyber.devices["d3"].open {
		t.Fatalf("locked d3 must not open by trojan toggle")
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
	assertDeniedOut(t, out, foe, "enemy_team") // ред. 2026-11-17: по команде

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
	// §16.1 ревизия «хром»: инвентарь деки кладём в сессию (cp до отката)
	h.items = []dataItem{{Name: "door_key", MB: 60, Enc: true}}
	home := h.pos
	homeTeam := h.team

	// Отключение → новое подключение с тем же именем и новым id.
	w.removePlayer(h.id)
	w.takeOut()
	// Ревизия 2026-11-17: явно выбранный ДРУГОЙ класс уважается (владелец:
	// «выбираю хакер — всё равно не хакер») — assault остаётся assault.
	h2 := w.addPlayer(7, "Slach", "assault", -1)
	if h2.cls != "assault" {
		t.Fatalf("explicitly chosen different class must be honored, got %s", h2.cls)
	}
	// Для проверки ремапа знаний перезаходим тем же классом, что в сессии.
	w.removePlayer(h2.id)
	w.takeOut()
	h2 = w.addPlayer(7, "Slach", "hacker", -1)
	if h2.cls != "hacker" {
		t.Fatalf("same-class rejoin must restore session class, got %s", h2.cls)
	}
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
	if len(h2.items) != 1 || h2.items[0].Name != "door_key" {
		t.Fatalf("deck inventory must survive rejoin, items=%v", h2.items)
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

// runCollectM3 — как runAndWaitM2, но возвращает исходящие завершившегося
// тика (alert'ы, scan): дождаться финиша программы и забрать аутпут.
func runCollectM3(w *world, pl *player, msg message) []outMsg {
	w.handleMessage(pl, msg)
	for i := 0; i < 400 && len(pl.progs) > 0; i++ {
		w.simulateTick()
	}
	if len(pl.progs) > 0 {
		panic("runCollectM3: program did not finish")
	}
	return w.takeOut()
}

// ensureVulned — решение владельца (c) 2026-11-16 «vulnscan = отмычка»:
// утилиты (watcher/firewall/antivirus) на чужих/нейтральных устройствах
// требуют завершённого vulnscan. Прогоняем его перед установкой (персистит,
// повторно не тратится).
func ensureVulned(w *world, pl *player, dev string) {
	if w.cyber.devices[dev] == nil || w.cyber.devices[dev].vulnedBy[pl.id] {
		return
	}
	runAndWaitM2(w, pl, message{"t": "run", "prog": "vulnscan", "dev": dev})
}

// findAlert — ищет alert для игрока по устройству; nil = не было.
func findAlert(out []outMsg, to uint64, dev string) message {
	return findAlertSrc(out, to, dev, "")
}

// findAlertSrc — то же, но с фильтром по src ("watcher"/"firewall"/...;
// "" — любой). §13.1: на watched-устройстве alert'ы разных источников
// не должны мешать друг друга.
func findAlertSrc(out []outMsg, to uint64, dev, src string) message {
	for _, om := range out {
		if om.msg["t"] == "alert" && om.to == to && om.msg["dev"] == dev {
			if src == "" || om.msg["src"] == src {
				return om.msg
			}
		}
	}
	return nil
}

// countAlerts — число alert'ов для игрока по устройству с фильтром по src
// и relay ("*" — любое значение поля).
func countAlerts(out []outMsg, to uint64, dev, src string, relay any) int {
	n := 0
	for _, om := range out {
		if om.msg["t"] != "alert" || om.to != to || om.msg["dev"] != dev {
			continue
		}
		if src != "" && om.msg["src"] != src {
			continue
		}
		if relay != "*" && om.msg["relay"] != relay {
			continue
		}
		n++
	}
	return n
}

// Watcher — инфраструктура разведки (M3 §13.1, ред. плейтеста 2026-11-15):
// установка (too_far без скана), триггер на чужой jack-in с ev=jackin
// (владельцу, даже не в деке, ровно один alert на событие), свой вход не
// триггерит, журнал пишется и читается в scan.devices[].log только хозяином,
// ретрансляция живому союзнику (relay:true), смерть гасит alert/радар
// (журнал — нет), респаун переподключает без переустановки.
func TestWatcher(t *testing.T) {
	w, clock := cyberTestWorld(t)
	// Команды сбалансированы (2×2): иначе rebalanceTeams перекидывает игрока
	// между командами и рвёт предположения теста о союзничестве.
	h := w.addPlayer(1, "h", "hacker", 0)   // team 0: хозяин watcher'а
	foe := w.addPlayer(2, "f", "hacker", 1) // team 1: актор событий
	killer := w.addPlayer(3, "k", "sniper", 1)
	ally := w.addPlayer(4, "a", "hacker", 0) // team 0: получатель relay
	w.takeOut()
	jackAt(w, h, "t1")

	// Цель не открыта portscan'ом — too_far (как vulnscan/trojan).
	w.handleMessage(h, message{"t": "run", "prog": "watcher", "dev": "t2"})
	assertDenied(t, w, h, "too_far")

	// Открыли сеть до t2, поставили watcher: триггер живёт на устройстве,
	// слот деки свободен.
	for i := 0; i < 3; i++ {
		runAndWaitM2(w, h, message{"t": "run", "prog": "portscan"})
	}
	ensureVulned(w, h, "t2")
	runAndWaitM2(w, h, message{"t": "run", "prog": "watcher", "dev": "t2"})
	if !w.cyber.devices["t2"].watcherBy[h.id] {
		t.Fatalf("watcher must be installed on t2")
	}
	if len(h.progs) != 0 {
		t.Fatalf("installed watcher must free the deck slot (lives on the device)")
	}
	// scan помечает устройство watched:true для хозяина (§13.2).
	w.sendScan(h)
	var watchedSeen bool
	for _, om := range w.takeOut() {
		if om.msg["t"] != "scan" || om.to != h.id {
			continue
		}
		for _, d := range om.msg["devices"].([]scanDevice) {
			if d.ID == "t2" && d.Watched {
				watchedSeen = true
			}
		}
	}
	if !watchedSeen {
		t.Fatalf("scan must mark t2 watched for the owner")
	}

	// Чужой джек-ин в t2 — ровно один alert хозяину (джекнутому) с ev=jackin.
	out := jackAt(w, foe, "t2")
	alert := findAlertSrc(out, h.id, "t2", "watcher")
	if alert == nil {
		t.Fatalf("owner must get an alert on enemy jack-in")
	}
	if alert["who"] != foe.id {
		t.Fatalf("alert.who = %v, want %d", alert["who"], foe.id)
	}
	if alert["ev"] != "jackin" {
		t.Fatalf("alert.ev = %v, want jackin (§13.1 №2)", alert["ev"])
	}
	if _, ok := alert["prog"]; ok {
		t.Fatalf("jackin alert must not carry prog: %v", alert)
	}
	if countAlerts(out, h.id, "t2", "watcher", nil) != 1 {
		t.Fatalf("exactly one watcher alert per event, no relay to the owner himself")
	}

	// Повторный вход триггерится снова; хозяину НЕ в деке — тоже доходит.
	w.handleMessage(foe, message{"t": "jackout"})
	w.handleMessage(h, message{"t": "jackout"})
	out = jackAt(w, foe, "t2")
	if findAlertSrc(out, h.id, "t2", "watcher") == nil {
		t.Fatalf("offline (not jacked) owner must still receive the alert")
	}

	// Журнал событий (§13.1 №1): пишется с момента установки watcher'а,
	// свои события тоже; приходит в scan.devices[].log только хозяину.
	// К этому моменту: своя установка + два чужих джек-ина (сверху).
	t2 := w.cyber.devices["t2"]
	if len(t2.log) != 3 || t2.log[0].Ev != "install" || t2.log[0].Who != h.id ||
		t2.log[1].Ev != "jackin" || t2.log[1].Who != foe.id ||
		t2.log[2].Ev != "jackin" || t2.log[2].Who != foe.id {
		t.Fatalf("journal must hold install + 2 jack-ins: %+v", t2.log)
	}
	w.sendScan(h)
	var log []logEntry
	for _, om := range w.takeOut() {
		if om.msg["t"] != "scan" || om.to != h.id {
			continue
		}
		for _, d := range om.msg["devices"].([]scanDevice) {
			if d.ID == "t2" {
				log = d.Log
			}
		}
	}
	if len(log) != 3 || log[2].Ev != "jackin" || log[2].Who != foe.id {
		t.Fatalf("scan.devices[].log must carry the journal for the owner: %+v", log)
	}
	// Чужой scan — журнал не раздуваем трафик (§13.2): foe джекнут в t2,
	// portscan открывает t2, но чужой watcher-журнал в его scan не попадает.
	runAndWaitM2(w, foe, message{"t": "run", "prog": "portscan"})
	if !foe.scanned["t2"] {
		t.Fatalf("setup: foe must have scanned t2")
	}
	w.sendScan(foe)
	var foeSawT2 bool
	for _, om := range w.takeOut() {
		if om.msg["t"] != "scan" || om.to != foe.id {
			continue
		}
		for _, d := range om.msg["devices"].([]scanDevice) {
			if d.ID == "t2" {
				foeSawT2 = true
				if len(d.Log) != 0 {
					t.Fatalf("journal must be sent only to the watcher owner: %+v", d.Log)
				}
			}
		}
	}
	if !foeSawT2 {
		t.Fatalf("setup: foe scan must contain t2")
	}

	// Свой вход в наблюдаемое устройство не триггерит, но пишется в журнал
	// (журнал — история устройства, а не только угроз).
	jackAt(w, h, "t1") // хазяин не в деке — возвращаемся
	ensureVulned(w, h, "t1")
	runAndWaitM2(w, h, message{"t": "run", "prog": "watcher", "dev": "t1"})
	w.handleMessage(h, message{"t": "jackout"})
	out = jackAt(w, h, "t1")
	if findAlertSrc(out, h.id, "t1", "watcher") != nil {
		t.Fatalf("own jack-in must not fire the watcher")
	}
	t1log := w.cyber.devices["t1"].log
	if len(t1log) != 2 || t1log[0].Ev != "install" || t1log[1].Ev != "jackin" || t1log[1].Who != h.id {
		t.Fatalf("own jack-in must be written to the journal: %+v", t1log)
	}

	// Ретрансляция (§13.1 №4): живому союзнику хозяина — дубль с relay:true,
	// самому хозяину и актору дубль не приходит.
	w.handleMessage(foe, message{"t": "jackout"})
	out = jackAt(w, foe, "t2")
	ra := findAlertSrc(out, ally.id, "t2", "watcher")
	if ra == nil || ra["relay"] != true {
		t.Fatalf("ally must receive the relayed alert: %v", ra)
	}
	if ra["who"] != foe.id || ra["ev"] != "jackin" {
		t.Fatalf("relay must carry the event context: %v", ra)
	}
	if findAlertSrc(out, h.id, "t2", "watcher") == nil {
		t.Fatalf("owner must still receive his own alert")
	}
	if countAlerts(out, h.id, "t2", "watcher", true) != 0 {
		t.Fatalf("the owner must not receive a relay duplicate of his own alert")
	}
	if countAlerts(out, foe.id, "t2", "watcher", "*") != 0 {
		t.Fatalf("the actor must not receive a relay of his own action")
	}

	// Смерть хозяина: триггеры гаснут (§5.5) — уведомления нет, но журнал
	// живёт на устройстве и продолжает писаться (§13.1).
	w.damage(killer, h, 150)
	if h.alive {
		t.Fatalf("setup: hacker must die")
	}
	w.handleMessage(foe, message{"t": "jackout"})
	out = jackAt(w, foe, "t2")
	if findAlertSrc(out, h.id, "t2", "watcher") != nil {
		t.Fatalf("dead owner must not receive alerts")
	}
	if countAlerts(out, ally.id, "t2", "watcher", "*") != 0 {
		t.Fatalf("dead owner's ally must not receive relay either")
	}
	last := t2.log[len(t2.log)-1]
	if last.Who != foe.id || last.Ev != "jackin" {
		t.Fatalf("journal keeps living while the owner is dead: %+v", t2.log)
	}
	if !w.cyber.devices["t2"].watcherBy[h.id] {
		t.Fatalf("death must NOT uninstall the watcher (it lives in the network)")
	}

	// Респаун: триггеры переподключаются мгновенно, без переустановки.
	*clock = clock.Add(6 * time.Second)
	w.handleMessage(h, message{"t": "respawn", "cls": "hacker"})
	if !h.alive {
		t.Fatalf("setup: hacker must be respawned")
	}
	w.handleMessage(foe, message{"t": "jackout"})
	out = jackAt(w, foe, "t2")
	if findAlertSrc(out, h.id, "t2", "watcher") == nil {
		t.Fatalf("respawned owner must receive alerts again without reinstalling")
	}
}

// Триггеры на кибер-события (§13.1 №2): установка чужой программы и смена
// владельца (trojan) дают alert с ev=install/owner и prog; своя установка не
// триггерит; отбитый antivirus'ом trojan — не событие (установки не было).
func TestWatcherInstallTriggers(t *testing.T) {
	w, clock := firewallTestWorld(t) // t1—s1—t2—s2, r2 за s2
	h := w.addPlayer(1, "h", "hacker", 0)
	foe := w.addPlayer(2, "f", "hacker", 1)
	w.takeOut()
	jackAt(w, h, "t1")
	scanStep(w, h, clock, 4) // s1, t2, s2, r2+cam1 — вся сеть
	ensureVulned(w, h, "t2")
	runAndWaitM2(w, h, message{"t": "run", "prog": "watcher", "dev": "t2"})

	// Своя установка программы на своём watched-устройстве — не событие
	// (пишется в журнал, alert'а нет).
	ensureVulned(w, h, "t2")
	out := runCollectM3(w, h, message{"t": "run", "prog": "firewall", "dev": "t2"})
	if findAlertSrc(out, h.id, "t2", "watcher") != nil {
		t.Fatalf("own install must not fire the watcher")
	}

	// Чужая установка: атакующий заходит с r2, firewall на watched t2.
	if out := jackAt(w, foe, "r2"); !foe.jacked {
		t.Fatalf("setup: foe must jack into r2, out=%v", out)
	}
	scanStep(w, foe, clock, 2) // r2, s2, t2
	ensureVulned(w, foe, "t2")
	out = runCollectM3(w, foe, message{"t": "run", "prog": "firewall", "dev": "t2"})
	a := findAlertSrc(out, h.id, "t2", "watcher")
	if a == nil || a["ev"] != "install" || a["prog"] != "firewall" || a["who"] != foe.id {
		t.Fatalf("foreign firewall install must alert the watcher owner with ev=install: %v", a)
	}
	if countAlerts(out, h.id, "t2", "watcher", "*") != 1 {
		t.Fatalf("exactly one alert per event")
	}

	// Чужой antivirus на watched-устройстве — событие install.
	ensureVulned(w, foe, "t2")
	out = runCollectM3(w, foe, message{"t": "run", "prog": "antivirus", "dev": "t2"})
	a = findAlertSrc(out, h.id, "t2", "watcher")
	if a == nil || a["ev"] != "install" || a["prog"] != "antivirus" {
		t.Fatalf("foreign antivirus install must alert with ev=install prog=antivirus: %v", a)
	}

	// Смена владельца: vulnscan+trojan -> ev=owner prog=trojan.
	runCollectM3(w, foe, message{"t": "run", "prog": "vulnscan", "dev": "t2"})
	out = runCollectM3(w, foe, message{"t": "run", "prog": "trojan", "dev": "t2"})
	a = findAlertSrc(out, h.id, "t2", "watcher")
	if a == nil || a["ev"] != "owner" || a["prog"] != "trojan" {
		t.Fatalf("owner change via trojan must alert with ev=owner prog=trojan: %v", a)
	}

	// Отбитый antivirus'ом trojan — НЕ событие (§13.1 №2): хозяин antivirus'а
	// h переустанавливает щит, атакующий бьёт trojan'ом снова — repelled
	// (владелец t2 — сам foe, повторный trojan не меняет владельца → install).
	ensureVulned(w, h, "t2")
	runCollectM3(w, h, message{"t": "run", "prog": "antivirus", "dev": "t2"})
	// §13.6 (2026-11-17): установка AV стёрла foe'vuln-метку — пере-вскрытие.
	ensureVulned(w, foe, "t2")
	out = runCollectM3(w, foe, message{"t": "run", "prog": "trojan", "dev": "t2"})
	assertDeniedOut(t, out, foe, "antivirus")
	if findAlertSrc(out, h.id, "t2", "watcher") != nil {
		t.Fatalf("a repelled trojan is not an install/owner event: no watcher alert")
	}
	if a := findAlertSrc(out, h.id, "t2", "antivirus"); a == nil {
		t.Fatalf("setup: antivirus owner must get its own alert (§13.6)")
	}

	// Журнал устройства — история всех событий, включая чужие (§13.1 №1).
	var installs, owners int
	for _, e := range w.cyber.devices["t2"].log {
		switch e.Ev {
		case "install":
			installs++
		case "owner":
			owners++
		}
	}
	if installs < 3 || owners < 1 {
		t.Fatalf("journal must hold installs+owner changes: %+v", w.cyber.devices["t2"].log)
	}
}

// Журнал: ring-buffer ёмкости 20, переполнение вытесняет старейшую (§13.1 №1).
func TestWatcherJournalOverflow(t *testing.T) {
	w, clock := firewallTestWorld(t)
	h := w.addPlayer(1, "h", "hacker", 0)
	foe := w.addPlayer(2, "f", "hacker", 1)
	w.takeOut()
	jackAt(w, h, "t1")
	scanStep(w, h, clock, 4)
	ensureVulned(w, h, "t2")
	runAndWaitM2(w, h, message{"t": "run", "prog": "watcher", "dev": "t2"})

	// 24 записи: свой jack-in в t2 x24 (не триггерит, но пишется).
	for i := 0; i < 24; i++ {
		w.handleMessage(h, message{"t": "jackout"})
		jackAt(w, h, "t2")
		w.takeOut()
	}
	log := w.cyber.devices["t2"].log
	if len(log) != watcherLogCap {
		t.Fatalf("journal must cap at %d, got %d", watcherLogCap, len(log))
	}
	if log[0].Ev != "jackin" {
		t.Fatalf("newest entries must be kept: %+v", log)
	}

	// Журнал пишет только пока на устройстве есть watcher; alert'ы чужих
	// событий после удаления watcher'а не доходят (§5.5/§13.1).
	delete(w.cyber.devices["t2"].watcherBy, h.id)
	n := len(log)
	w.handleMessage(foe, message{"t": "jackout"})
	out := jackAt(w, foe, "t2")
	if len(w.cyber.devices["t2"].log) != n {
		t.Fatalf("journal stops without a watcher: %+v", w.cyber.devices["t2"].log)
	}
	if findAlertSrc(out, h.id, "t2", "watcher") != nil {
		t.Fatalf("no watchers — no alerts")
	}
}

// Радар-срез (§13.1 №3): 1 Гц джекнутые хакеры в BFS-сегменте ОТ watched-
// устройства; сам хозяин не в срезе; живой хозяин джек-аутнутый — срез всё
// равно идёт; чужой firewall режет видимость за собой; мёртвому хозяину —
// тишина.
func TestWatcherRadar(t *testing.T) {
	w, clock := firewallTestWorld(t) // t1—s1—t2—s2—{d1,r2,cam1}
	// Команды 2×3 с первого加入 (wantTeam уважается только без перекоса ≥2,
	// иначе addPlayer/rebalanceTeams перекидуют игрока и рвут предпосылки
	// о союзничестве). ally2 jacked: rebalanceTeams не двигает джекнутых.
	h := w.addPlayer(1, "h", "hacker", 0)
	victim := w.addPlayer(2, "v", "hacker", 1)
	ally2 := w.addPlayer(3, "b", "hacker", 0)
	jackAt(w, ally2, "t1")
	hidden := w.addPlayer(4, "x", "hacker", 1)
	foe := w.addPlayer(5, "f", "hacker", 1)
	if foe.team != 1 || hidden.team != 1 || ally2.team != 0 {
		t.Fatalf("setup: teams must honor requests: %d %d %d", foe.team, hidden.team, ally2.team)
	}
	w.takeOut()

	// Хозяин ставит watcher на t2 (сегмент = вся карта).
	jackAt(w, h, "t1")
	scanStep(w, h, clock, 4)
	ensureVulned(w, h, "t2")
	runAndWaitM2(w, h, message{"t": "run", "prog": "watcher", "dev": "t2"})
	w.handleMessage(h, message{"t": "jackout"}) // живый вне деки — радар идёт

	// victim джек-инется в t1 (сегмент от t2), hidden — за future st2=r2.
	if out := jackAt(w, victim, "t1"); !victim.jacked {
		t.Fatalf("setup: victim must jack into t1, out=%v", out)
	}
	if out := jackAt(w, hidden, "r2"); !hidden.jacked {
		t.Fatalf("setup: hidden must jack into r2, out=%v", out)
	}
	w.takeOut()

	// До установки firewall: срез на каждом radarFeedEvery-тике, victim виден,
	// hidden виден (сегмент общий), хозяина в срезе нет.
	radars := func(n int) []message {
		var got []message
		for i := 0; i < n; i++ {
			*clock = clock.Add(time.Second / 30)
			w.simulateTick()
			for _, om := range w.takeOut() {
				if om.msg["t"] == "radar" && om.to == h.id && om.msg["dev"] == "t2" {
					got = append(got, om.msg)
				}
			}
		}
		return got
	}
	radWho := func(m message) []radarWho {
		who, _ := m["who"].([]radarWho)
		return who
	}
	seen := func(who []radarWho, id uint64) bool {
		for _, p := range who {
			if p.ID == id {
				return true
			}
		}
		return false
	}
	sweeps := radars(radarFeedEvery + 1)
	if len(sweeps) < 1 {
		t.Fatalf("radar must stream at 1 Hz to the living owner")
	}
	if len(sweeps) > 2 {
		t.Fatalf("radar must not exceed 1 Hz: %d", len(sweeps))
	}
	who := radWho(sweeps[len(sweeps)-1])
	if !seen(who, victim.id) || !seen(who, hidden.id) {
		t.Fatalf("both jacked hackers in the segment must be seen: %+v", who)
	}
	if seen(who, h.id) {
		t.Fatalf("the owner himself must not be in the sweep")
	}
	for _, p := range who {
		if p.ID == victim.id && (p.Host != "t1" || p.Name != "v" || p.Team != 1 || p.Cls != "hacker") {
			t.Fatalf("sweep entry must carry id/name/team/cls/host: %+v", p)
		}
	}

	// Пустой срез тоже шлётся (§13.1 №3): все джек-аутнулись — who пустой.
	w.handleMessage(victim, message{"t": "jackout"})
	w.handleMessage(hidden, message{"t": "jackout"})
	w.handleMessage(ally2, message{"t": "jackout"})
	sweeps = radars(radarFeedEvery + 1)
	if len(sweeps) == 0 || len(radWho(sweeps[len(sweeps)-1])) != 0 {
		t.Fatalf("an empty sweep must be sent (UI: «сегмент чист»)")
	}

	// Firewall закрывает транзит: foe ставит фильтр на s2 (союзник hidden).
	// hidden снова джек-инется за фильтром.
	if out := jackAt(w, foe, "r2"); !foe.jacked {
		t.Fatalf("setup: foe must jack into r2, out=%v", out)
	}
	scanStep(w, foe, clock, 2) // r2, s2
	ensureVulned(w, foe, "s2")
	runAndWaitM2(w, foe, message{"t": "run", "prog": "firewall", "dev": "s2"})
	w.handleMessage(hidden, message{"t": "jackout"})
	if out := jackAt(w, hidden, "r2"); !hidden.jacked {
		t.Fatalf("setup: hidden re-jacks r2, out=%v", out)
	}
	if out := jackAt(w, victim, "t1"); !victim.jacked {
		t.Fatalf("setup: victim re-jacks t1, out=%v", out)
	}
	sweeps = radars(radarFeedEvery + 1)
	who = radWho(sweeps[len(sweeps)-1])
	if !seen(who, victim.id) {
		t.Fatalf("victim before the filter must stay visible: %+v", who)
	}
	if seen(who, hidden.id) {
		t.Fatalf("a hacker behind an enemy firewall must not be radar-visible: %+v", who)
	}

	// Смерть хозяина: радар гаснет (§5.5), срезов нет. (ally2 jacked —
	// rebalanceTeams его не тронет; id 6.)
	killer := w.addPlayer(6, "k", "sniper", 1)
	w.takeOut()
	w.damage(killer, h, 150)
	if h.alive {
		t.Fatalf("setup: radar owner must die")
	}
	if got := radars(45); len(got) != 0 {
		t.Fatalf("dead owner must not receive radar sweeps: %d", len(got))
	}
}

// Упор чужого portscan'а в firewall на watched-устройстве — запись журнала
// scanhit без watcher-alert'а (§13.1 №1: событие firewall, а не триггер).
func TestWatcherScanhit(t *testing.T) {
	w, clock := firewallTestWorld(t)
	h := w.addPlayer(1, "h", "hacker", 0)
	foe := w.addPlayer(2, "f", "hacker", 1)
	w.takeOut()
	jackAt(w, h, "t1")
	scanStep(w, h, clock, 4)
	ensureVulned(w, h, "t2")
	runAndWaitM2(w, h, message{"t": "run", "prog": "watcher", "dev": "t2"})
	ensureVulned(w, h, "t2")
	runAndWaitM2(w, h, message{"t": "run", "prog": "firewall", "dev": "t2"})
	w.takeOut()

	if out := jackAt(w, foe, "t1"); !foe.jacked {
		t.Fatalf("setup: foe must jack into t1, out=%v", out)
	}
	scanStep(w, foe, clock, 3) // до упора в t2
	out := runCollectM3(w, foe, message{"t": "run", "prog": "portscan"})
	if countAlerts(out, h.id, "t2", "watcher", "*") != 0 {
		t.Fatalf("scanhit must not fire a watcher alert")
	}
	if findAlertSrc(out, h.id, "t2", "firewall") == nil {
		t.Fatalf("setup: firewall alert must go to the firewall owner")
	}
	hit := w.cyber.devices["t2"].log[len(w.cyber.devices["t2"].log)-1]
	if hit.Ev != "scanhit" || hit.Who != foe.id {
		t.Fatalf("scanhit must be journaled: %+v", w.cyber.devices["t2"].log)
	}
}

// Пули/нож не проходят сквозь ЗАКРЫТУЮ дверь (плейтест M2-2: «автоприцел
// стреляет сквозь дверь»), открытая — прозрачна для огня.
func TestFireBlockedByClosedDoor(t *testing.T) {
	w, _, _, clock := combatWorld(t) // пол 40×40, shooter@0,1,0
	// Дверь между стрелком и жертвой: тонкая панель в z=10.
	w.cyber = buildCyber(&gameMap{Name: "d", Bounds: [3]float64{40, 8, 40},
		Colliders: []collider{{Min: [3]float64{0, 0, 0}, Max: [3]float64{40, 1, 40}, Kind: "floor"}},
		props:     []mapProp{{Kind: "door", ID: "d1", Pos: [3]float64{0, 1, 10}, Size: [3]float64{8, 3, 0.3}, Axis: "x", To: ""}}})
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

// firewallTestWorld — карта для сегментации (§13.5): t1—s1—t2(шлюз)—s2,
// s2—d1, s2—cam1, радио r2 с аплинком к s2 (вторая точка входа в сегмент
// за t2).
func firewallTestWorld(t *testing.T) (*world, *time.Time) {
	t.Helper()
	const j = `{
	 "name":"fwtest","bounds":[40,8,40],
	 "colliders":[
	  {"min":[0,0,0],"max":[40,1,40],"kind":"floor"},
	  {"min":[0,1,37],"max":[0.7,1.5,39],"kind":"stair"}
	 ],
	 "spawns":{"0":[[5,1,5]],"1":[[35,1,35]]},
	 "props":[
	  {"kind":"terminal","id":"t1","pos":[5,1,8]},
	  {"kind":"switch","id":"s1","pos":[5,1,15]},
	  {"kind":"terminal","id":"t2","pos":[20,1,20]},
	  {"kind":"switch","id":"s2","pos":[28,1,20]},
	  {"kind":"door","id":"d1","pos":[28,1,27],"size":[3,3,0.3],"axis":"x","to":"s2"},
	  {"kind":"radio","id":"r2","pos":[28,1,13],"radius":8},
	  {"kind":"camera","id":"cam1","pos":[28,2.6,20]},
	  {"kind":"cable","id":"c1","from":"t1","to":"s1"},
	  {"kind":"cable","id":"c5","from":"s1","to":"t2"},
	  {"kind":"cable","id":"c6","from":"t2","to":"s2"},
	  {"kind":"cable","id":"c7","from":"s2","to":"d1"},
	  {"kind":"cable","id":"c8","from":"s2","to":"cam1"}
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

// Firewall (M3 §13.5, редакция «сетевая сегментация» 2026-11-15): установка
// (too_far без скана); скан чужого не раскрывает сегмент
// за D, D сам видим (firewalled/firewalledBy в scan); ранее открытое гаснет;
// jack-in в D чужим проходит; обход через вторую точку входа; vulnscan+trojan
// выкуривает; ровно один alert src=firewall на упор portscan'а; союзники
// не режутся.
func TestFirewall(t *testing.T) {
	w, clock := firewallTestWorld(t)
	h := w.addPlayer(1, "h", "hacker", 0)   // team 0: защитник
	foe := w.addPlayer(2, "f", "hacker", 1) // team 1: атакующий
	ally := w.addPlayer(3, "a", "hacker", 0)
	w.takeOut()

	// runCollect — как runAndWaitM2, но возвращает исходящие (нужны alert'ы).
	runCollect := func(pl *player, msg message) []outMsg {
		w.handleMessage(pl, msg)
		for i := 0; i < 400 && len(pl.progs) > 0; i++ {
			w.simulateTick()
		}
		if len(pl.progs) > 0 {
			t.Fatalf("program did not finish: %v", msg)
		}
		return w.takeOut()
	}
	scan := func(pl *player, steps int) {
		for i := 0; i < steps; i++ {
			runCollect(pl, message{"t": "run", "prog": "portscan"})
		}
	}

	// --- Установка: цель не открыта — too_far (kind-ограничения больше нет,
	// ред. плейтеста M3 2026-11-15: firewall на любое устройство).
	jackAt(w, h, "t1")
	w.handleMessage(h, message{"t": "run", "prog": "firewall", "dev": "t2"})
	assertDenied(t, w, h, "too_far")
	scan(h, 1) // t1, s1

	// Атакующий заранее раскрывает сеть (4 хопа — вся, включая сегмент за t2).
	out := jackAt(w, foe, "t1")
	if !foe.jacked {
		t.Fatalf("setup: foe must jack into neutral t1, out=%v", out)
	}
	scan(foe, 4)
	for _, id := range []string{"t2", "s2", "d1", "r2"} {
		if !foe.scanned[id] {
			t.Fatalf("setup: foe must have scanned %s: %v", id, foe.scanned)
		}
	}

	// Защитник раскрывает сеть и ставит firewall на шлюз t2: фильтр живёт
	// на устройстве, слот деки свободен.
	scan(h, 4)
	ensureVulned(w, h, "t2")
	runCollect(h, message{"t": "run", "prog": "firewall", "dev": "t2"})
	if w.cyber.devices["t2"].firewalled != h.id {
		t.Fatalf("firewall must be installed on t2 by h")
	}
	if len(h.progs) != 0 {
		t.Fatalf("installed firewall must free the deck slot (lives on the device)")
	}

	// Ранее открытое «за t2» гаснет у чужого (живой вид сети), t2 сам видим
	// и помечен firewalled + firewalledBy (бейдж «чей», §13.2).
	for _, id := range []string{"s2", "d1", "r2"} {
		if foe.scanned[id] {
			t.Fatalf("installing the firewall must fade %s from the enemy scan", id)
		}
	}
	if !foe.scanned["t2"] || !foe.scanned["t1"] || !foe.scanned["s1"] {
		t.Fatalf("the gateway t2 itself must stay visible to the enemy: %v", foe.scanned)
	}
	w.sendScan(foe)
	var fwSeen bool
	for _, om := range w.takeOut() {
		if om.msg["t"] != "scan" || om.to != foe.id {
			continue
		}
		for _, d := range om.msg["devices"].([]scanDevice) {
			if d.ID == "t2" && d.Firewalled && d.FirewalledBy == h.id {
				fwSeen = true
			}
		}
	}
	if !fwSeen {
		t.Fatalf("scan must mark t2 firewalled + firewalledBy=%d", h.id)
	}

	// Повторный portscan чужого: сегмент НЕ раскрывается, скан упёрлся —
	// ровно один alert src=firewall хозяину на запуск.
	out = runCollect(foe, message{"t": "run", "prog": "portscan"})
	if foe.scanned["s2"] || foe.scanned["d1"] || foe.scanned["r2"] {
		t.Fatalf("enemy portscan must not reveal the segment behind the firewall: %v", foe.scanned)
	}
	alerts := 0
	for _, om := range out {
		if om.msg["t"] == "alert" && om.to == h.id && om.msg["dev"] == "t2" {
			alerts++
			if om.msg["src"] != "firewall" {
				t.Fatalf("alert src = %v, want firewall", om.msg["src"])
			}
			if om.msg["who"] != foe.id {
				t.Fatalf("alert.who = %v, want %d", om.msg["who"], foe.id)
			}
		}
	}
	if alerts != 1 {
		t.Fatalf("scan hit must fire exactly one firewall alert, got %d", alerts)
	}

	// Джек-ин в само D чужим проходит (замок входа убран) — но скан из D
	// упирается в фильтр: распространение «от D» — тоже трафик через D.
	w.handleMessage(foe, message{"t": "jackout"})
	out = jackAt(w, foe, "t2")
	if !foe.jacked {
		t.Fatalf("enemy jack-in into the firewalled device itself must pass, out=%v", out)
	}
	runCollect(foe, message{"t": "run", "prog": "portscan"})
	for _, id := range []string{"s1", "s2", "d1"} {
		if foe.scanned[id] {
			t.Fatalf("scan from inside the firewalled gateway must not spread to %s: %v", id, foe.scanned)
		}
	}
	if !foe.scanned["t2"] {
		t.Fatalf("the gateway itself must stay visible: %v", foe.scanned)
	}

	// Обход через вторую точку входа: радио r2 (аплинк → s2) раскрывает
	// сегмент, не проходя через t2; сеть хозяина за t2 не видна.
	w.handleMessage(foe, message{"t": "jackout"})
	out = jackAt(w, foe, "r2")
	if !foe.jacked {
		t.Fatalf("setup: foe must jack into r2, out=%v", out)
	}
	scan(foe, 3)
	for _, id := range []string{"r2", "s2", "d1", "t2"} {
		if !foe.scanned[id] {
			t.Fatalf("second entry point must reveal the segment incl %s: %v", id, foe.scanned)
		}
	}
	if foe.scanned["s1"] || foe.scanned["t1"] {
		t.Fatalf("scan must not spread THROUGH the firewalled gateway: %v", foe.scanned)
	}

	// vulnscan+trojan на D выкуривает firewall; после этого сегмент снова
	// проходим насквозь (распространение через t2 открыто).
	runCollect(foe, message{"t": "run", "prog": "vulnscan", "dev": "t2"})
	runCollect(foe, message{"t": "run", "prog": "trojan", "dev": "t2"})
	if w.cyber.devices["t2"].firewalled != 0 || w.cyber.devices["t2"].owner != foe.id {
		t.Fatalf("enemy trojan must flush the firewall and take ownership: fw=%v owner=%v",
			w.cyber.devices["t2"].firewalled, w.cyber.devices["t2"].owner)
	}
	runCollect(foe, message{"t": "run", "prog": "portscan"})
	runCollect(foe, message{"t": "run", "prog": "portscan"})
	if !foe.scanned["s1"] || !foe.scanned["t1"] {
		t.Fatalf("after the firewall is flushed the scan must cross t2: %v", foe.scanned)
	}

	// Союзники и владелец фильтра не режутся (firewall снова стоит).
	ensureVulned(w, h, "t2")
	runCollect(h, message{"t": "run", "prog": "firewall", "dev": "t2"})
	if w.cyber.devices["t2"].firewalled != h.id {
		t.Fatalf("setup: firewall must be reinstalled by h")
	}
	out = jackAt(w, ally, "t1")
	if !ally.jacked {
		t.Fatalf("setup: ally must jack into t1, out=%v", out)
	}
	scan(ally, 4)
	for _, id := range []string{"t2", "s2", "d1", "r2"} {
		if !ally.scanned[id] {
			t.Fatalf("ally must not be cut by the owner's firewall, missing %s: %v", id, ally.scanned)
		}
	}
	runCollect(h, message{"t": "run", "prog": "portscan"})
	for _, id := range []string{"s2", "d1", "r2"} {
		if !h.scanned[id] {
			t.Fatalf("owner must not be cut by own firewall, missing %s: %v", id, h.scanned)
		}
	}

	// Смерть хозяина: firewall живёт в сети, но alert'ы мёртвым не шлём —
	// упор чужого скана в фильтр проходит тихо.
	killer := w.addPlayer(4, "k", "sniper", 1)
	w.takeOut()
	w.damage(killer, h, 150)
	if h.alive {
		t.Fatalf("setup: firewall owner must die")
	}
	if w.cyber.devices["t2"].firewalled == 0 {
		t.Fatalf("death must NOT uninstall the firewall (it lives in the network)")
	}
	w.handleMessage(foe, message{"t": "jackout"})
	out = jackAt(w, foe, "t1")
	if !foe.jacked {
		t.Fatalf("setup: foe re-jacks t1, out=%v", out)
	}
	out = runCollect(foe, message{"t": "run", "prog": "portscan"})
	for _, om := range out {
		if om.msg["t"] == "alert" && om.to == h.id {
			t.Fatalf("dead firewall owner must not receive alerts: %v", om.msg)
		}
	}
	if foe.scanned["s2"] {
		t.Fatalf("the live firewall must still segment the enemy scan: %v", foe.scanned)
	}
	_ = clock
}

// Firewall на любое устройство (§13.5, ред. плейтеста M3 2026-11-15):
// firewall на switch разрезает карту пополам (t1-сторона не видит
// s2-сторону и наоборот), ставится на конечные устройства (дверь/камера),
// союзники и владелец проходят свободно.
func TestFirewallAnyDevice(t *testing.T) {
	w, _ := firewallTestWorld(t)
	h := w.addPlayer(1, "h", "hacker", 0)   // team 0: защитник
	foe := w.addPlayer(2, "f", "hacker", 1) // team 1: атакующий
	ally := w.addPlayer(3, "a", "hacker", 0)
	w.takeOut()

	runCollect := func(pl *player, msg message) {
		w.handleMessage(pl, msg)
		for i := 0; i < 400 && len(pl.progs) > 0; i++ {
			w.simulateTick()
		}
		if len(pl.progs) > 0 {
			t.Fatalf("program did not finish: %v", msg)
		}
	}
	scan := func(pl *player, steps int) {
		for i := 0; i < steps; i++ {
			runCollect(pl, message{"t": "run", "prog": "portscan"})
		}
	}

	// Обе стороны заранее раскрывают сеть (фильтра ещё нет).
	jackAt(w, h, "t1")
	scan(h, 5) // t1, s1, t2, s2, d1/r2/cam1 — вся сеть
	jackAt(w, foe, "t1")
	scan(foe, 5)
	for _, id := range []string{"t2", "s2", "d1", "r2", "cam1"} {
		if !foe.scanned[id] {
			t.Fatalf("setup: foe must have scanned %s before the firewall", id)
		}
	}

	// Firewall на switch s1 — классическое место фильтра: линк s1↔t2
	// перерезан, карта разрезана. Ранее открытое гаснет у чужого и
	// повторным portscan'ом не возвращается.
	ensureVulned(w, h, "s1")
	runCollect(h, message{"t": "run", "prog": "firewall", "dev": "s1"})
	if w.cyber.devices["s1"].firewalled != h.id {
		t.Fatalf("firewall must be installable on a switch (any device, §13.5)")
	}
	for _, id := range []string{"t2", "s2", "d1", "r2", "cam1"} {
		if foe.scanned[id] {
			t.Fatalf("firewall on s1 must fade %s from the enemy scan", id)
		}
	}
	scan(foe, 5)
	for _, id := range []string{"t2", "s2", "d1", "r2", "cam1"} {
		if foe.scanned[id] {
			t.Fatalf("enemy portscan must not cross the firewalled switch to %s", id)
		}
	}
	if !foe.scanned["t1"] || !foe.scanned["s1"] {
		t.Fatalf("t1-side must stay visible to the enemy: %v", foe.scanned)
	}

	// Обратная сторона: с r2 (аплинк → s2) чужой видит s2-сторону, но не
	// проходит через firewalled s1 к t1-стороне.
	w.handleMessage(foe, message{"t": "jackout"})
	jackAt(w, foe, "r2")
	scan(foe, 5)
	for _, id := range []string{"r2", "s2", "d1", "cam1", "t2"} {
		if !foe.scanned[id] {
			t.Fatalf("s2-side must be visible from r2 incl %s: %v", id, foe.scanned)
		}
	}
	// Сам s1 (интерфейс фильтра) виден, но за ним — никого.
	if !foe.scanned["s1"] {
		t.Fatalf("the firewalled switch itself must stay visible (interface): %v", foe.scanned)
	}
	if foe.scanned["t1"] {
		t.Fatalf("scan from s2-side must not cross the firewalled switch to t1: %v", foe.scanned)
	}

	// Конечные устройства: firewall на дверь и камеру ставится (зависит от
	// достижимости per-player — защитник проходит сквозь свой фильтр на s1).
	ensureVulned(w, h, "d1")
	runCollect(h, message{"t": "run", "prog": "firewall", "dev": "d1"})
	if w.cyber.devices["d1"].firewalled != h.id {
		t.Fatalf("firewall must be installable on a door")
	}
	ensureVulned(w, h, "cam1")
	runCollect(h, message{"t": "run", "prog": "firewall", "dev": "cam1"})
	if w.cyber.devices["cam1"].firewalled != h.id {
		t.Fatalf("firewall must be installable on a camera")
	}

	// Союзники и владелец проходят свободно: ally с t1 видит всю сеть
	// сквозь фильтры хозяина на s1/d1/cam1.
	jackAt(w, ally, "t1")
	scan(ally, 5)
	for _, id := range []string{"t2", "s2", "d1", "r2", "cam1"} {
		if !ally.scanned[id] {
			t.Fatalf("ally must not be cut by the owner's firewalls, missing %s: %v", id, ally.scanned)
		}
	}
	runCollect(h, message{"t": "run", "prog": "portscan"})
	for _, id := range []string{"t2", "s2", "d1", "r2", "cam1"} {
		if !h.scanned[id] {
			t.Fatalf("owner must not be cut by own firewalls, missing %s: %v", id, h.scanned)
		}
	}
}

// Antivirus (M3 §13.6): установка (too_far без скана, слот свободен,
// antivirused в scan), чужой trojan отбит (denied antivirus атакующему,
// ровно один alert src=antivirus хозяину, владение НЕ перешло, чужой firewall
// НЕ выкурён, antivirus изношен), свой trojan проходит, гонка версий:
// переустановка снова отбивает, без переустановки повторная попытка
// атакующего проходит (тупика нет).
func TestAntivirus(t *testing.T) {
	w, _ := cyberTestWorld(t)
	h := w.addPlayer(1, "h", "hacker", 0)   // team 0: защитник
	foe := w.addPlayer(2, "f", "hacker", 1) // team 1: атакующий
	w.takeOut()

	// runCollect — как runAndWaitM2, но возвращает исходящие сообщения
	// (нужны denied/alert от завершившейся программы).
	runCollect := func(pl *player, msg message) []outMsg {
		w.handleMessage(pl, msg)
		for i := 0; i < 400 && len(pl.progs) > 0; i++ {
			w.simulateTick()
		}
		if len(pl.progs) > 0 {
			t.Fatalf("program did not finish: %v", msg)
		}
		return w.takeOut()
	}

	jackAt(w, h, "t1")
	// Цель не открыта portscan'ом — too_far (как watcher/firewall).
	w.handleMessage(h, message{"t": "run", "prog": "antivirus", "dev": "t2"})
	assertDenied(t, w, h, "too_far")

	for i := 0; i < 3; i++ {
		runAndWaitM2(w, h, message{"t": "run", "prog": "portscan"})
	}
	ensureVulned(w, h, "t2")
	runCollect(h, message{"t": "run", "prog": "antivirus", "dev": "t2"})
	ensureVulned(w, h, "t2")
	runCollect(h, message{"t": "run", "prog": "firewall", "dev": "t2"}) // для интеракции с выкуриванием
	if w.cyber.devices["t2"].antivirused != h.id || w.cyber.devices["t2"].firewalled != h.id {
		t.Fatalf("setup: antivirus+firewall must be installed on t2 by h")
	}
	if len(h.progs) != 0 {
		t.Fatalf("installed antivirus must free the deck slot (lives on the device)")
	}
	// scan помечает устройство antivirused:true (наблюдаемый процесс — всем,
	// кто скавш; здесь — хозяину).
	w.sendScan(h)
	var avSeen bool
	for _, om := range w.takeOut() {
		if om.msg["t"] != "scan" || om.to != h.id {
			continue
		}
		for _, d := range om.msg["devices"].([]scanDevice) {
			if d.ID == "t2" && d.Antivirused {
				avSeen = true
			}
		}
	}
	if !avSeen {
		t.Fatalf("scan must mark t2 antivirused")
	}

	// Свой trojan проходит свободно (свой antivirus свою команду не бьёт):
	// antivirus на d1, h троянит d1 — владение перешло, antivirus не изношен.
	ensureVulned(w, h, "d1")
	runCollect(h, message{"t": "run", "prog": "antivirus", "dev": "d1"})
	runCollect(h, message{"t": "run", "prog": "vulnscan", "dev": "d1"})
	runCollect(h, message{"t": "run", "prog": "trojan", "dev": "d1"})
	if w.cyber.devices["d1"].owner != h.id {
		t.Fatalf("own trojan must pass own antivirus, owner=%v", w.cyber.devices["d1"].owner)
	}
	if w.cyber.devices["d1"].antivirused != h.id {
		t.Fatalf("own trojan must NOT wear the antivirus")
	}

	// Чужой trojan на t2 отбит: denied antivirus, ровно один alert
	// src=antivirus хозяину, владение НЕ перешло, firewall НЕ выкурён,
	// antivirus изношен (гонка версий).
	out := foePrepTrojan(t, w, foe)
	assertDeniedOut(t, out, foe, "antivirus")
	alerts := 0
	for _, om := range out {
		if om.msg["t"] == "alert" && om.to == h.id && om.msg["dev"] == "t2" {
			alerts++
			if om.msg["src"] != "antivirus" {
				t.Fatalf("alert src = %v, want antivirus", om.msg["src"])
			}
		}
	}
	if alerts != 1 {
		t.Fatalf("repelled trojan must fire exactly one antivirus alert, got %d", alerts)
	}
	t2 := w.cyber.devices["t2"]
	if t2.owner != 0 || t2.firewalled != h.id {
		t.Fatalf("repelled trojan must not change owner or flush firewall: owner=%v fw=%v", t2.owner, t2.firewalled)
	}
	if t2.antivirused != 0 {
		t.Fatalf("antivirus must be worn out after repelling one trojan")
	}

	// Гонка версий: защитник переустановил — повторная попытка снова отбита.
	ensureVulned(w, h, "t2")
	runCollect(h, message{"t": "run", "prog": "antivirus", "dev": "t2"})
	if t2.antivirused != h.id {
		t.Fatalf("setup: antivirus must be reinstalled")
	}
	ensureVulned(w, foe, "t2") // AV (строкой выше) стёрл метку foe (§13.6)
	out = runCollect(foe, message{"t": "run", "prog": "trojan", "dev": "t2"})
	assertDeniedOut(t, out, foe, "antivirus")

	// Контр-плей без тупика: без переустановки повторный trojan проходит —
	// владение перешло, чужой firewall выкурен, вход открыт.
	ensureVulned(w, foe, "t2") // вторая установка AV тоже стирала метку (§13.6)
	out = runCollect(foe, message{"t": "run", "prog": "trojan", "dev": "t2"})
	if t2.owner != foe.id {
		t.Fatalf("retry trojan must succeed against the worn-out antivirus, owner=%v", t2.owner)
	}
	if t2.firewalled != 0 {
		t.Fatalf("successful trojan must flush the old firewall")
	}
	w.handleMessage(foe, message{"t": "jackout"})
	out = jackAt(w, foe, "t2")
	if !foe.jacked {
		t.Fatalf("jack-in must pass after capturing t2, out=%v", out)
	}
}

// foePrepTrojan — атакующий входит в сеть с нейтральной точки, открывает t2,
// vulnscan'ит и запускает trojan; возвращает исходящие сообщения trojan'а.
func foePrepTrojan(t *testing.T, w *world, foe *player) []outMsg {
	t.Helper()
	out := jackAt(w, foe, "t1")
	if !foe.jacked {
		t.Fatalf("setup: foe must jack into neutral t1, out=%v", out)
	}
	for i := 0; i < 3; i++ {
		runAndWaitM2(w, foe, message{"t": "run", "prog": "portscan"})
	}
	runAndWaitM2(w, foe, message{"t": "run", "prog": "vulnscan", "dev": "t2"})
	w.handleMessage(foe, message{"t": "run", "prog": "trojan", "dev": "t2"})
	for i := 0; i < 400 && len(foe.progs) > 0; i++ {
		w.simulateTick()
	}
	if len(foe.progs) > 0 {
		t.Fatalf("setup: trojan must finish")
	}
	return w.takeOut()
}

// --- M3, объект 4: камера (§13.7) -------------------------------------------

// cameraTestWorld — мини-карта с камерой: t1—c1—s1—c2—cam1. Стена x∈[14,15]
// между камерой (20,2.6,20) и зоной z≈20 слева: игрок за ней в радиусе, но
// без LOS.
func cameraTestWorld(t *testing.T) (*world, *time.Time) {
	t.Helper()
	const j = `{
	 "name":"camtest","bounds":[40,8,40],
	 "colliders":[
	  {"min":[0,0,0],"max":[40,1,40],"kind":"floor"},
	  {"min":[14,1,19.5],"max":[15,4,20.5],"kind":"wall"},
	  {"min":[0,1,37],"max":[0.7,1.5,39],"kind":"stair"}
	 ],
	 "spawns":{"0":[[5,1,5]],"1":[[35,1,35]]},
	 "props":[
	  {"kind":"terminal","id":"t1","pos":[5,1,8]},
	  {"kind":"switch","id":"s1","pos":[5,1,15]},
	  {"kind":"camera","id":"cam1","pos":[20,2.6,20]},
	  {"kind":"cable","id":"c1","from":"t1","to":"s1"},
	  {"kind":"cable","id":"c2","from":"cam1","to":"s1"}
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

// camFrames — все cam-кадры для игрока по устройству из пачки исходящих.
func camFrames(out []outMsg, to uint64, dev string) [][]camSeen {
	var frames [][]camSeen
	for _, om := range out {
		if om.msg["t"] != "cam" || om.to != to || om.msg["dev"] != dev {
			continue
		}
		seen, _ := om.msg["seen"].([]camSeen)
		frames = append(frames, seen)
	}
	return frames
}

func seenIDs(frame []camSeen) map[uint64]bool {
	ids := make(map[uint64]bool, len(frame))
	for _, s := range frame {
		ids[s.ID] = true
	}
	return ids
}

// Камера (§13.7): в сети после portscan, trojan-захват требует vulnscan,
// владелец получает ленту (радиус 12 м + LOS), чужой не получает, мёртвые и
// за стеной в ленту не попадают, firewall — bad_target, antivirus отбивает
// чужой trojan.
func TestCamera(t *testing.T) {
	w, clock := cameraTestWorld(t)
	h := w.addPlayer(1, "h", "hacker", -1)
	foe := w.addPlayer(2, "f", "hacker", -1)
	w.takeOut()
	jackAt(w, h, "t1")

	// Камера — устройство сети: BFS от t1, portscan открывает её со 2-го хопа.
	if !w.cyber.reachable("t1")["cam1"] {
		t.Fatalf("cam1 must be reachable from t1")
	}
	w.handleMessage(h, message{"t": "run", "prog": "trojan", "dev": "cam1"})
	assertDenied(t, w, h, "too_far") // ещё не открыта portscan'ом
	for i := 0; i < 2; i++ {
		runAndWaitM2(w, h, message{"t": "run", "prog": "portscan"})
	}
	if !h.scanned["cam1"] {
		t.Fatalf("two portscans must discover cam1, scanned=%v", h.scanned)
	}
	// scan сообщает kind=camera (кибер-карта рисует сенсор).
	w.sendScan(h)
	var kindSeen string
	for _, om := range w.takeOut() {
		if om.msg["t"] != "scan" {
			continue
		}
		for _, d := range om.msg["devices"].([]scanDevice) {
			if d.ID == "cam1" {
				kindSeen = d.Kind
			}
		}
	}
	if kindSeen != "camera" {
		t.Fatalf("scan must report cam1 kind=camera, got %q", kindSeen)
	}

	// Захват: vulnscan обязателен, потом trojan → владелец.
	w.handleMessage(h, message{"t": "run", "prog": "trojan", "dev": "cam1"})
	assertDenied(t, w, h, "not_vulned")
	runAndWaitM2(w, h, message{"t": "run", "prog": "vulnscan", "dev": "cam1"})
	runAndWaitM2(w, h, message{"t": "run", "prog": "trojan", "dev": "cam1"})
	if w.cyber.devices["cam1"].owner != h.id {
		t.Fatalf("trojan must capture cam1, owner=%v", w.cyber.devices["cam1"].owner)
	}

	// Зона видимости: near в радиусе с LOS; wallMan — в радиусе за стеной
	// (не виден); far — вне радиуса; мёртвый — не виден.
	near := w.addPlayer(3, "near", "assault", 1)
	wallMan := w.addPlayer(4, "wall", "assault", 1)
	far := w.addPlayer(5, "far", "sniper", 1)
	w.takeOut()
	near.pos = vec3{26, 1, 20}    // ~6 м от камеры, LOS чист
	wallMan.pos = vec3{10, 1, 20} // ~10 м, но стена x14..15 режет LOS
	far.pos = vec3{35, 1, 35}     // ~15 м — вне радиуса 12

	// Владелец получает кадры 2 Гц; до первого camFeedEvery-тика их нет.
	for i := 0; i < 45; i++ {
		*clock = clock.Add(time.Second / 30)
		w.simulateTick()
	}
	out := w.takeOut()
	frames := camFrames(out, h.id, "cam1")
	if len(frames) == 0 {
		t.Fatalf("owner must receive cam frames at 2 Hz")
	}
	last := frames[len(frames)-1]
	ids := seenIDs(last)
	if !ids[near.id] {
		t.Fatalf("player within radius+LOS must be seen: %v", last)
	}
	if ids[wallMan.id] {
		t.Fatalf("player behind a wall must not be seen (LOS, §13.7)")
	}
	if ids[far.id] {
		t.Fatalf("player beyond 12 m must not be seen")
	}
	// Чужой НЕ получает ленту (в т.ч. пустую).
	if frames := camFrames(out, foe.id, "cam1"); len(frames) != 0 {
		t.Fatalf("non-owner must not receive cam frames, got %d", len(frames))
	}

	// Мёртвый выпадает из ленты; пустая зона = пустой кадр (UI чистится).
	killer := w.addPlayer(6, "k", "sniper", 0)
	w.takeOut()
	w.damage(killer, near, 150)
	if near.alive {
		t.Fatalf("setup: near must die")
	}
	for i := 0; i < 16; i++ {
		*clock = clock.Add(time.Second / 30)
		w.simulateTick()
	}
	frames = camFrames(w.takeOut(), h.id, "cam1")
	if len(frames) == 0 {
		t.Fatalf("frames must keep flowing (2 Hz)")
	}
	if ids := seenIDs(frames[len(frames)-1]); ids[near.id] {
		t.Fatalf("dead player must not be seen")
	}

	// snap.props: камера всем, owner — для LED-индикатора.
	w.broadcastSnap()
	var camProp message
	for _, om := range w.takeOut() {
		if om.msg["t"] != "snap" {
			continue
		}
		for _, p := range om.msg["props"].([]any) {
			if m := p.(message); m["id"] == "cam1" {
				camProp = m
			}
		}
	}
	if camProp == nil || camProp["kind"] != "camera" || camProp["owner"] != h.id {
		t.Fatalf("snap.props must carry cam1 with kind/owner: %+v", camProp)
	}

	// firewall на камеру ставится (любое устройство, §13.5 ред. 2026-11-15).
	w.handleMessage(h, message{"t": "run", "prog": "firewall", "dev": "cam1"})
	for i := 0; i < 400 && len(h.progs) > 0; i++ {
		w.simulateTick()
	}
	if len(h.progs) != 0 || w.cyber.devices["cam1"].firewalled != h.id {
		t.Fatalf("firewall must be installable on a camera (any device): fw=%v",
			w.cyber.devices["cam1"].firewalled)
	}

	// antivirus на камере работает: чужой trojan отбит (гонка версий §13.6).
	runCollect := func(pl *player, msg message) []outMsg {
		w.handleMessage(pl, msg)
		for i := 0; i < 400 && len(pl.progs) > 0; i++ {
			w.simulateTick()
		}
		if len(pl.progs) > 0 {
			t.Fatalf("program did not finish: %v", msg)
		}
		return w.takeOut()
	}
	ensureVulned(w, h, "cam1")
	runCollect(h, message{"t": "run", "prog": "antivirus", "dev": "cam1"})
	if w.cyber.devices["cam1"].antivirused != h.id {
		t.Fatalf("setup: antivirus must sit on cam1")
	}
	foeOut := foePrepTrojanCam(t, w, foe)
	assertDeniedOut(t, foeOut, foe, "antivirus")
	if w.cyber.devices["cam1"].antivirused != 0 {
		t.Fatalf("antivirus must be worn out after repelling one trojan")
	}
	if w.cyber.devices["cam1"].owner != h.id {
		t.Fatalf("repelled trojan must not change camera owner")
	}
}

// foePrepTrojanCam — атакующий входит с нейтральной точки, открывает камеру,
// vulnscan'ит и троянит; возвращает исходящие trojan'а.
func foePrepTrojanCam(t *testing.T, w *world, foe *player) []outMsg {
	t.Helper()
	out := jackAt(w, foe, "t1")
	if !foe.jacked {
		t.Fatalf("setup: foe must jack into t1, out=%v", out)
	}
	for i := 0; i < 2; i++ {
		runAndWaitM2(w, foe, message{"t": "run", "prog": "portscan"})
	}
	runAndWaitM2(w, foe, message{"t": "run", "prog": "vulnscan", "dev": "cam1"})
	w.handleMessage(foe, message{"t": "run", "prog": "trojan", "dev": "cam1"})
	for i := 0; i < 400 && len(foe.progs) > 0; i++ {
		w.simulateTick()
	}
	if len(foe.progs) > 0 {
		t.Fatalf("setup: trojan must finish")
	}
	return w.takeOut()
}

// Плейтест M3: повторный джек-ин восстанавливает знания (scan при jackin,
// §12.5) — табы захваченных устройств не теряются после jackout.
func TestJackinResendsScan(t *testing.T) {
	w, _ := cyberTestWorld(t)
	h := w.addPlayer(1, "h", "hacker", -1)
	w.takeOut()
	jackAt(w, h, "t1")

	// Раскрыли два хопа сети и захватили дверь.
	runAndWaitM2(w, h, message{"t": "run", "prog": "portscan"})
	runAndWaitM2(w, h, message{"t": "run", "prog": "portscan"})
	runAndWaitM2(w, h, message{"t": "run", "prog": "vulnscan", "dev": "d1"})
	runAndWaitM2(w, h, message{"t": "run", "prog": "trojan", "dev": "d1"})

	// jackout и повторный вход в ту же точку — scan приходит сразу, с
	// владением: клиент восстановит таб устройства двери.
	w.handleMessage(h, message{"t": "jackout"})
	w.takeOut()
	msgs := jackAt(w, h, "t1")
	var scanSeen, doorOwned bool
	for _, om := range msgs {
		if om.msg["t"] != "scan" {
			continue
		}
		scanSeen = true
		for _, d := range om.msg["devices"].([]scanDevice) {
			if d.ID == "d1" && d.Owner == h.id {
				doorOwned = true
			}
		}
	}
	if !scanSeen || !doorOwned {
		t.Fatalf("re-jackin must resend scan with ownership: scan=%v doorOwned=%v", scanSeen, doorOwned)
	}

	// А с нуля (новый игрок, знаний нет) — scan не приходит.
	foe := w.addPlayer(2, "f", "hacker", -1)
	w.takeOut()
	for _, om := range jackAt(w, foe, "t2") {
		if om.msg["t"] == "scan" {
			t.Fatalf("fresh jackin must not send scan")
		}
	}
}

// Решение владельца (c) 2026-11-16 «vulnscan = отмычка»: утилиты на чужих/
// нейтральных устройствах требуют vulnscan; на своих (трояновых) — нет.
func TestUtilityVulnscanGate(t *testing.T) {
	w, clock := cyberTestWorld(t)
	h := w.addPlayer(1, "h", "hacker", 0)
	w.takeOut()
	jackAt(w, h, "t1")
	scanStep(w, h, clock, 4) // вся сеть: s1, s2, t2, d1, r1

	// Нейтральное устройство без vulnscan — not_vulned (watcher, firewall,
	// antivirus одинаково).
	for _, prog := range []string{"watcher", "firewall", "antivirus"} {
		w.handleMessage(h, message{"t": "run", "prog": prog, "dev": "t2"})
		assertDenied(t, w, h, "not_vulned")
	}

	// vulnscan один раз — отмычка для всех утилит сразу (персистит).
	ensureVulned(w, h, "t2")
	runAndWaitM2(w, h, message{"t": "run", "prog": "watcher", "dev": "t2"})
	runAndWaitM2(w, h, message{"t": "run", "prog": "firewall", "dev": "t2"})
	if !w.cyber.devices["t2"].watcherBy[h.id] || w.cyber.devices["t2"].firewalled != h.id {
		t.Fatalf("vulnscan must unlock watcher+firewall on t2")
	}

	// Своё (трояновое) устройство — утилиты без vulnscan на target: trojan
	// сам требует vulnscan, поэтому берём устройство, где h ставил trojan.
	ensureVulned(w, h, "d1")
	runAndWaitM2(w, h, message{"t": "run", "prog": "trojan", "dev": "d1"})
	// simulate: vulnedBy[d1] есть — но проверяем именно ветку «своё»: убираем
	// троян нельзя, поэтому проверяем antivirus на своём d1 (владелец h).
	runAndWaitM2(w, h, message{"t": "run", "prog": "antivirus", "dev": "d1"})
	if w.cyber.devices["d1"].antivirused != h.id {
		t.Fatalf("utility on OWN device must install without extra vulnscan")
	}
}

// Точки входа contested по КОМАНДЕ (§12.5, ред. 2026-11-17): терминал
// союзника-хакера открыт для джек-ина своей команды, чужой команды —
// denied enemy_team.
func TestJackinTeamContested(t *testing.T) {
	w, _ := cyberTestWorld(t)
	ally := w.addPlayer(1, "ally", "hacker", -1)
	me := w.addPlayer(2, "me", "hacker", -1)
	foe := w.addPlayer(3, "foe", "hacker", -1)
	foe.team = 1 - ally.team
	me.team = ally.team
	w.takeOut()

	// Терминал t2 захвачен союзником — джек-ин разрешён.
	w.cyber.devices["t2"].owner = ally.id
	out := jackAt(w, me, "t2")
	if !me.jacked {
		t.Fatalf("teammate-owned entry point must allow jack-in")
	}
	for _, om := range out {
		if om.msg["t"] == "denied" && om.to == me.id {
			t.Fatalf("teammate-owned entry point must not deny: %v", om.msg)
		}
	}
	w.handleMessage(me, message{"t": "jackout"})
	w.takeOut()

	// Тот же терминал захвачен врагом — denied enemy_team.
	w.cyber.devices["t2"].owner = foe.id
	out = jackAt(w, me, "t2")
	assertDeniedOut(t, out, me, "enemy_team")
	if me.jacked {
		t.Fatalf("enemy-owned entry point must not allow jack-in")
	}

	// Свой собственный терминал — по-прежнему разрешён.
	w.cyber.devices["t2"].owner = me.id
	if !jackOwn(t, w, me) {
		t.Fatalf("own entry point must allow jack-in")
	}

	// Хозяин вне players (сессия истекла) — трактуется как вражеский.
	w.handleMessage(me, message{"t": "jackout"})
	w.takeOut()
	delete(w.players, foe.id)
	w.cyber.devices["t2"].owner = foe.id
	out = jackAt(w, me, "t2")
	assertDeniedOut(t, out, me, "enemy_team")
}

// jackOwn — вспомогательная: джек-ин с ожиданием успеха.
func jackOwn(t *testing.T, w *world, pl *player) bool {
	t.Helper()
	jackAt(w, pl, "t2")
	return pl.jacked
}

// TestAntivirusWipesForeignVuln — §13.6 (решение владельца 2026-11-17
// «пере-вскрытие после AV»): завершившаяся установка antivirus стирает
// ЧУЖИЕ vuln-метки устройства — чужой софт после этого снова требует
// vulnscan (denied not_vulned); метка самого установщика остаётся.
func TestAntivirusWipesForeignVuln(t *testing.T) {
	w := netTestWorld(t, 60)
	a := w.addPlayer(1, "h1", "hacker", 0) // установит antivirus
	b := w.addPlayer(2, "h2", "hacker", 1) // чужой с vuln-меткой
	w.takeOut()
	jackIn(t, w, a, "t1")
	jackIn(t, w, b, "t2")
	ensureVulned(w, a, "d1")
	ensureVulned(w, b, "d1")
	if !w.cyber.devices["d1"].vulnedBy[a.id] || !w.cyber.devices["d1"].vulnedBy[b.id] {
		t.Fatalf("both vuln marks expected before AV")
	}
	runAndWaitM2(w, a, message{"t": "run", "prog": "antivirus", "dev": "d1"})
	if w.cyber.devices["d1"].antivirused != a.id {
		t.Fatalf("antivirus not installed")
	}
	if !w.cyber.devices["d1"].vulnedBy[a.id] {
		t.Fatalf("installer's own vuln mark must survive")
	}
	if w.cyber.devices["d1"].vulnedBy[b.id] {
		t.Fatalf("foreign vuln mark must be wiped by AV")
	}
	// Следствие: чужой watcher на d1 теперь denied not_vulned.
	w.handleMessage(b, message{"t": "run", "prog": "watcher", "dev": "d1"})
	out := w.takeOut()
	found := false
	for _, m := range out {
		if m.to == b.id && m.msg["reason"] == "not_vulned" {
			found = true
		}
	}
	if !found {
		t.Fatalf("watcher after AV must be denied not_vulned")
	}
}

// TestScanSoftOnlyOwnerVisible — §9.2 (панель «ПРОЦЕССЫ»): состав софта
// устройства виден ТОЛЬКО владельцу (трояновому хозяину); чужой видит
// устройство без поля soft.
func TestScanSoftOnlyOwnerVisible(t *testing.T) {
	w := netTestWorld(t, 60)
	a := w.addPlayer(1, "h1", "hacker", 0)
	b := w.addPlayer(2, "h2", "hacker", 1)
	w.takeOut()
	jackIn(t, w, a, "t1")
	jackIn(t, w, b, "t2")
	// a захватывает d1 трояном (нужен vulnscan), ставит firewall и watcher.
	ensureVulned(w, a, "d1")
	runAndWaitM2(w, a, message{"t": "run", "prog": "trojan", "dev": "d1"})
	runAndWaitM2(w, a, message{"t": "run", "prog": "firewall", "dev": "d1"})
	runAndWaitM2(w, a, message{"t": "run", "prog": "watcher", "dev": "d1"})
	w.takeOut()
	w.sendScan(a)
	scanA := w.takeOut()
	w.sendScan(b)
	scanB := w.takeOut()
	softOf := func(out []outMsg, id uint64) int {
		n := 0
		for _, m := range out {
			if m.to != id || m.msg["t"] != "scan" {
				continue
			}
			devs, _ := m.msg["devices"].([]scanDevice)
			for _, d := range devs {
				n += len(d.Soft)
			}
		}
		return n
	}
	if got := softOf(scanA, a.id); got < 3 {
		t.Fatalf("owner soft entries = %d, want >=3 (trojan+firewall+watcher)", got)
	}
	if got := softOf(scanB, b.id); got != 0 {
		t.Fatalf("foreign soft entries = %d, want 0 (hidden)", got)
	}
}

// TestExpensiveJackin — §12.1 «дорогой вход» (решение владельца 2026-11-17):
// джек-ин у камеры (не точка входа) требует 6 с установки канала: до 6 с —
// не джекнут (прогресс идёт), отход из радиуса прерывает; после 6 с —
// джекнут, NET деки = худший кабель устройства. Чужой владелец камеры
// enemy_team НЕ ставит (contested только у точек входа).
func TestExpensiveJackin(t *testing.T) {
	w, clock := cyberTestWorld(t)
	h := w.addPlayer(1, "h1", "hacker", 0)
	// d1 — дверь, НЕ точка входа. Владелец — враг: contested enemy_team
	// должен НЕ применяться к не-точкам входа (§12.1).
	w.cyber.devices["d1"].owner = 99
	w.players[99] = &player{id: 99, team: 1}
	// Хакер у двери, жмёт space.
	h.pos = w.cyber.devices["d1"].pos
	h.keys.interact = true
	w.interactTick(h)
	if h.jacking == nil || h.jacked {
		t.Fatalf("device jack-in must start a channel, jacking=%v jacked=%v", h.jacking, h.jacked)
	}
	h.keys.interact = false
	// 3 с: ещё в канале.
	for i := 0; i < 90; i++ {
		*clock = clock.Add(time.Second / 30)
		w.simulateTick()
	}
	if h.jacked {
		t.Fatalf("channel must take 6s, jacked early")
	}
	// Отход из радиуса (по горизонтали — вертикаль не считается, камера
	// висит выше) — отмена.
	h.pos = h.pos.add(vec3{5, 0, 0})
	w.simulateTick()
	if h.jacking != nil {
		t.Fatalf("walking away must cancel the channel")
	}
	// Завершение: обратно, снова space, 6.5 с.
	h.pos = w.cyber.devices["d1"].pos
	h.keys.interact = true
	w.interactTick(h)
	h.keys.interact = false
	for i := 0; i < 200; i++ {
		*clock = clock.Add(time.Second / 30)
		w.simulateTick()
	}
	if !h.jacked || h.jackHost.id != "d1" {
		t.Fatalf("after 6.5s must be jacked into d1: jacked=%v host=%v", h.jacked, h.jackHost)
	}
	// NET деки камеры — худший кабель (не паспортные 100).
	if net := w.deckNet(h); net >= 100 {
		t.Fatalf("device jack-in deck net = %v, want worst cable (<100)", net)
	}
}

// ── M5 итерация 2: MEM + cp + rm (§16.1/§16.2) ────────────────────────

// cpSetup — хакер захватил t1 (там seed-данные door_key 60 МБ) и стоит
// в джек-ине. Возвращает мир, игрока и часы.
func cpSetup(t *testing.T) (*world, *player, *time.Time) {
	t.Helper()
	w, clock := cyberTestWorld(t)
	h := w.addPlayer(1, "h1", "hacker", 0)
	w.takeOut()
	jackAt(w, h, "t1")
	runAndWaitM2(w, h, message{"t": "run", "prog": "portscan"})
	ensureVulned(w, h, "t1")
	runAndWaitM2(w, h, message{"t": "run", "prog": "trojan", "dev": "t1"})
	// §16.5: door_key сеется на SRV1 (за щитом); трансферные тесты проверяют
	// механику cp/mv/rm — кладём item прямо на захваченный t1.
	w.cyber.devices["t1"].items = append(w.cyber.devices["t1"].items, dataItem{Name: "door_key", MB: 60, Enc: true})
	w.takeOut()
	return w, h, clock
}

func findProg(pl *player, prog string) *program {
	for _, p := range pl.progs {
		if p.prog == prog {
			return p
		}
	}
	return nil
}

// TestMvDeckTransfer — §16.2 ревизия 3: mv door_key из троянового t1 в деку:
// 60 МБ по магистрали 40 = 1.5 с чистой полосы; item переезжает (не копия).
func TestMvDeckTransfer(t *testing.T) {
	w, h, clock := cpSetup(t)
	w.handleMessage(h, message{"t": "run", "prog": "mv", "dev": "t1", "dst": "deck"})
	p := findProg(h, "mv")
	if p == nil {
		t.Fatalf("mv not started")
	}
	// Локальный трансфер (t1 = точка входа деки): полоса = входной канал
	// хоста; в cyberTestWorld c1 без явного bw → дефолт-магистраль 40.
	if p.mb != 60 || p.mbps != 40 {
		t.Fatalf("mv mb/mbps = %d/%v, want 60/40", p.mb, p.mbps)
	}
	// Резервация в деку: 60 из 256 занято сразу.
	if used := w.deckItemsUsed(h); used != 60 {
		t.Fatalf("deck reservation = %d, want 60", used)
	}
	for i := 0; i < 4*30 && len(h.progs) > 0; i++ {
		*clock = clock.Add(time.Second / 30)
		w.simulateTick()
	}
	if len(h.items) != 1 || h.items[0].Name != "door_key" || h.items[0].MB != 60 {
		t.Fatalf("door_key must land in deck, items=%v", h.items)
	}
	if hostHasItem(w.cyber.devices["t1"], "door_key") {
		t.Fatalf("door_key must leave t1 (mv = transfer)")
	}
	if used := w.deckItemsUsed(h); used != 60 {
		t.Fatalf("deck after transfer = %d, want 60 (item, reservation gone)", used)
	}
	// Wire (§16.1): deck-сообщение обязано нести инвентарь — плейтест:
	// data[] не клалось в сообщение, дека на клиенте была вечно пуста.
	// Deck-тик 2 Гц (раз в 15 тиков) — флашим буфер (там до-финишные deck'и)
	// и крутим до ближайшего окна после завершения трансфера.
	w.takeOut()
	var deckMsg message
	for i := 0; i < 30 && deckMsg == nil; i++ {
		*clock = clock.Add(time.Second / 30)
		w.simulateTick()
		for _, om := range w.takeOut() {
			if om.msg["t"] == "deck" && om.to == h.id {
				deckMsg = om.msg
			}
		}
	}
	inv, ok := deckMsg["data"].([]dataItem)
	if !ok || len(inv) != 1 || inv[0].Name != "door_key" {
		t.Fatalf("deck message must carry data inventory, got %+v", deckMsg["data"])
	}
}

// TestCpCopyKeepsSrc — §16.2 ревизия 3 (владелец «cp это КОПИРОВАНИЕ»):
// cp оставляет экземпляр в источнике — MEM занят на обеих сторонах;
// точный повтор dup; та же копия на другой приёмник легальна.
func TestCpCopyKeepsSrc(t *testing.T) {
	w, h, clock := cpSetup(t)
	w.handleMessage(h, message{"t": "run", "prog": "cp", "dev": "t1", "dst": "deck"})
	for i := 0; i < 4*30 && len(h.progs) > 0; i++ {
		*clock = clock.Add(time.Second / 30)
		w.simulateTick()
	}
	if len(h.items) != 1 || h.items[0].Name != "door_key" {
		t.Fatalf("deck must hold the copy, items=%v", h.items)
	}
	if !hostHasItem(w.cyber.devices["t1"], "door_key") {
		t.Fatalf("cp must keep the source copy (not mv)")
	}
	if used := w.deckItemsUsed(h); used != 60 {
		t.Fatalf("deck after copy = %d, want 60", used)
	}
	// Тот же item с того же источника в тот же приёмник — dup.
	w.takeOut()
	w.handleMessage(h, message{"t": "run", "prog": "cp", "dev": "t1", "dst": "deck"})
	out := w.takeOut()
	if !hasDenied(out, h.id, "dup") {
		t.Fatalf("exact repeat copy must be denied dup")
	}
	// Копия на ДРУГОЙ приёмник легальна (t2 тоже seed с door_key — dup
	// там и правда должен сработать; свитч s1 — MEM 16 < 60; берём r1
	// (радио 64 МБ) через два хопа скана).
	runAndWaitM2(w, h, message{"t": "run", "prog": "portscan"})
	runAndWaitM2(w, h, message{"t": "run", "prog": "portscan"})
	r1 := w.cyber.devices["r1"]
	r1.owner = h.id
	w.handleMessage(h, message{"t": "run", "prog": "cp", "dev": "t1", "dst": "r1", "data": "door_key"})
	if findProg(h, "cp") == nil {
		t.Fatalf("copy to another dst must start")
	}
	// радио-аплинк 5 МБ/с: 60 МБ = 12 с чистой полосы — окно с запасом
	for i := 0; i < 15*30 && len(h.progs) > 0; i++ {
		*clock = clock.Add(time.Second / 30)
		w.simulateTick()
	}
	if !hostHasItem(r1, "door_key") || !hostHasItem(w.cyber.devices["t1"], "door_key") {
		t.Fatalf("copy: both src and dst must hold door_key")
	}
}

// TestCpDenied — §16.2: dup и mem_full.
func TestCpDenied(t *testing.T) {
	w, h, clock := cpSetup(t)
	// первый трансфер резервировал 60 — второй такой же упрётся в dup.
	w.handleMessage(h, message{"t": "run", "prog": "cp", "dev": "t1", "dst": "deck"})
	w.takeOut()
	w.handleMessage(h, message{"t": "run", "prog": "cp", "dev": "t1", "dst": "deck"})
	out := w.takeOut()
	if !hasDenied(out, h.id, "dup") {
		t.Fatalf("second cp of same item must be denied dup")
	}
	// Wire (§16.2 ред. «красный мигающий бар»): denied несёт prog+data.
	deniedWire := false
	for _, om := range out {
		if om.to == h.id && om.msg["t"] == "denied" && om.msg["prog"] == "cp" && om.msg["data"] == "door_key" {
			deniedWire = true
		}
	}
	if !deniedWire {
		t.Fatalf("data-op denied must carry prog+data on wire")
	}
	// mem_full: докачать до отказа нельзя (t1 один item) — вместо этого
	// деку почти заполняем и пробуем второй item большего размера: seed
	// дополнительного item'а на t2 (владелец h) через прямой доступ.
	w2dev := w.cyber.devices["t2"]
	w2dev.owner = h.id
	w2dev.items = append(w2dev.items, dataItem{Name: "big", MB: 220, Enc: true})
	// t2 открыть сканом (прогрессивно: s1 → s2 → t2 — три хопа).
	for i := 0; i < 3; i++ {
		runAndWaitM2(w, h, message{"t": "run", "prog": "portscan"})
	}
	w.handleMessage(h, message{"t": "run", "prog": "cp", "dev": "t2", "dst": "deck", "data": "big"})
	if findProg(h, "cp") == nil {
		// 60 уже зарезервировано, 220 не влезает в 256 — mem_full
		out = w.takeOut()
		if !hasDenied(out, h.id, "mem_full") {
			t.Fatalf("oversized transfer must be denied mem_full")
		}
	} else {
		t.Fatalf("220+60 > 256 must be denied before start")
	}
	// Дождёмся первого трансфера — он не пострадал (резервации честные).
	for i := 0; i < 4*30 && len(h.progs) > 0; i++ {
		*clock = clock.Add(time.Second / 30)
		w.simulateTick()
	}
	if len(h.items) != 1 || h.items[0].Name != "door_key" {
		t.Fatalf("reserved transfer must complete despite second denied one")
	}
}

func hasDenied(out []outMsg, to uint64, reason string) bool {
	for _, m := range out {
		if m.to == to && m.msg["t"] == "denied" && m.msg["reason"] == reason {
			return true
		}
	}
	return false
}

// TestCpCancelFirewall — §16.2 «отмена»: чужой firewall встал на линке
// зафиксированного маршрута — трансфер умирает, резервация ушла.
func TestCpCancelFirewall(t *testing.T) {
	w, h, clock := cpSetup(t)
	// h захватил t1; перелогинимся в t2, чтобы маршрут t1→дека шёл через s1.
	w.handleMessage(h, message{"t": "jackout"})
	w.takeOut()
	jackAt(w, h, "t2")
	runAndWaitM2(w, h, message{"t": "run", "prog": "portscan"})
	runAndWaitM2(w, h, message{"t": "run", "prog": "portscan"})
	// Тяжёлый item (200 МБ = 5 с по магистрали 40): firewall успеет в середину.
	w.cyber.devices["t1"].items = append(w.cyber.devices["t1"].items, dataItem{Name: "blob", MB: 200, Enc: true})
	// Враг (id 2, другая команда) входит через радио r1: вся подготовка ДО
	// старта трансфера (портсканы+вулнскан ~7 с симуляции), firewall — после.
	foe := w.addPlayer(2, "f2", "hacker", 1)
	w.takeOut()
	jackAt(w, foe, "r1")
	runAndWaitM2(w, foe, message{"t": "run", "prog": "portscan"})
	runAndWaitM2(w, foe, message{"t": "run", "prog": "portscan"})
	ensureVulned(w, foe, "s1")
	w.handleMessage(h, message{"t": "run", "prog": "cp", "dev": "t1", "dst": "deck", "data": "blob"})
	p := findProg(h, "cp")
	if p == nil {
		t.Fatalf("cp not started")
	}
	if len(p.path) == 0 || p.path[1] != "s1" {
		t.Fatalf("setup: route must go through s1, path=%v", p.path)
	}
	runAndWaitM2(w, foe, message{"t": "run", "prog": "firewall", "dev": "s1"})
	for i := 0; i < 5*30 && len(h.progs) > 0; i++ {
		*clock = clock.Add(time.Second / 30)
		w.simulateTick()
	}
	if len(h.progs) != 0 {
		t.Fatalf("cp must be cancelled by enemy firewall on route")
	}
	if len(h.items) != 0 {
		t.Fatalf("cancelled transfer must not deliver data")
	}
	if used := w.deckItemsUsed(h); used != 0 {
		t.Fatalf("reservation must be released on cancel, used=%d", used)
	}
}

// TestRmAndDupChaff — §16.2: rm удаляет item с хоста; chaff-цикл
// «переслать → rm → ...» (mv-ноги: cp оставил бы копию в источнике).
func TestRmAndDupChaff(t *testing.T) {
	w, h, clock := cpSetup(t)
	w.handleMessage(h, message{"t": "run", "prog": "mv", "dev": "t1", "dst": "deck"})
	for i := 0; i < 4*30 && len(h.progs) > 0; i++ {
		*clock = clock.Add(time.Second / 30)
		w.simulateTick()
	}
	// Слить обратно на t1 (chaff-закладка, mv) и удалить с деки.
	w.handleMessage(h, message{"t": "run", "prog": "mv", "dev": "deck", "dst": "t1", "data": "door_key"})
	if findProg(h, "mv") == nil {
		t.Fatalf("deck->host mv must start (chaff)")
	}
	for i := 0; i < 4*30 && len(h.progs) > 0; i++ {
		*clock = clock.Add(time.Second / 30)
		w.simulateTick()
	}
	if !hostHasItem(w.cyber.devices["t1"], "door_key") || len(h.items) != 0 {
		t.Fatalf("chaff: door_key must move back to t1")
	}
	// rm на своём хосте, 0.5 с.
	w.handleMessage(h, message{"t": "run", "prog": "rm", "dev": "t1", "data": "door_key"})
	if p := findProg(h, "rm"); p == nil || p.work != 0.5 {
		t.Fatalf("rm must run 0.5s")
	}
	for i := 0; i < 30 && len(h.progs) > 0; i++ {
		*clock = clock.Add(time.Second / 30)
		w.simulateTick()
	}
	if hostHasItem(w.cyber.devices["t1"], "door_key") {
		t.Fatalf("rm must delete the item")
	}
	// И снова cp/mv с t1 нечему (item удалён; dup уже не мешает, но и
	// качать нечего — fast-path не находит items).
	w.handleMessage(h, message{"t": "run", "prog": "mv", "dev": "t1", "dst": "deck"})
	if findProg(h, "mv") != nil {
		t.Fatalf("mv of removed item must not start")
	}
}

// TestDeathWipesDeckMEM — §16.1: смерть хакера стирает MEM его деки.
func TestDeathWipesDeckMEM(t *testing.T) {
	w, h, _ := cpSetup(t)
	w.handleMessage(h, message{"t": "run", "prog": "cp", "dev": "t1", "dst": "deck"})
	for i := 0; i < 4*30 && len(h.progs) > 0; i++ {
		w.simulateTick()
	}
	if len(h.items) != 1 {
		t.Fatalf("setup: door_key in deck")
	}
	foe := w.addPlayer(2, "f2", "assault", 1)
	foe.pos = h.pos
	w.damage(foe, h, 500)
	if len(h.items) != 0 {
		t.Fatalf("death must wipe deck MEM, items=%v", h.items)
	}
}

// TestSeedTwoDoorKeys — решение владельца 2026-11-17: door_key сеется ДВУМЯ
// копиями (t1+t2), rm убивает навсегда — матч-киллер исключён наличием
// TestSeedDoorKeyOnSrv1 — §16.5 (ревизия 2026-11-18): door_key живёт на SRV1
// (одна копия — соревноваться короче), SRV1 стартует со щитом ×3, имя ключа —
// поколение door_keyYYYYMMDDHHII.
func TestSeedDoorKeyOnSrv1(t *testing.T) {
	// SRV1 живёт во встроенной карте — крошечный cyberTestWorld его не несёт.
	w := newWorld(mustParseEmbeddedMap(t))
	now := time.Now()
	w.now = func() time.Time { return now }
	srv := w.cyber.devices["srv1"]
	if srv == nil {
		t.Fatalf("map must carry srv1")
	}
	if srv.shield != 3 {
		t.Fatalf("srv1 shield = %d, want 3", srv.shield)
	}
	if len(srv.items) != 1 || !strings.HasPrefix(srv.items[0].Name, "door_key") || srv.items[0].MB != 60 {
		t.Fatalf("srv1 must hold one door_key generation, items=%v", srv.items)
	}
	if w.cyber.devices["t1"].items != nil || w.cyber.devices["t2"].items != nil {
		t.Fatalf("t1/t2 must not hold door_key anymore")
	}
	// Ротация T=120 с: следующее поколение появляется и код меняется.
	code0 := w.doorKeyCode
	now = now.Add(121 * time.Second)
	w.simulateTick()
	if len(srv.items) != 2 {
		t.Fatalf("rotation must add a new generation, items=%v", srv.items)
	}
	if w.doorKeyCode == code0 || w.doorKeyPrevCode != code0 {
		t.Fatalf("rotation must change code with grace: prev=%s cur=%s (old %s)", w.doorKeyPrevCode, w.doorKeyCode, code0)
	}
	if !w.doorKeyValid(nil, code0) || !w.doorKeyValid(nil, w.doorKeyCode) {
		t.Fatalf("current and previous generation codes must be valid")
	}
	// Решение владельца: все поколения матча копятся (6 × 60 = 360 ≤ 512):
	// хакер без SRV1 не знает, какой ключ валидный. Ещё 4 ротации → всего 6.
	for i := 0; i < 4; i++ {
		now = now.Add(121 * time.Second)
		w.simulateTick()
	}
	if n := len(srv.items); n != 6 {
		t.Fatalf("generations accumulate within a match, got %d items, want 6", n)
	}
	if total := 6 * 60; total > srv.mem {
		t.Fatalf("6 generations (%d MB) must fit srv MEM %d", total, srv.mem)
	}
	// Новый матч: ключи из прошлого раунда не переезжают (§16.5).
	h := w.addPlayer(1, "h", "hacker", -1)
	w.takeOut()
	h.items = []dataItem{{Name: "door_key_old", MB: 60, Enc: true}}
	w.matchActive = false
	w.startMatchIfNeeded()
	if len(srv.items) != 1 || len(h.items) != 0 {
		t.Fatalf("new match must reset door_key (srv=%v deck=%v)", srv.items, h.items)
	}
}

// TestCodeLock — §16.7: d3 заперта код-замком; ввод кода с клавиатуры:
// верный (текущее поколение) открывает, неверный — N/4 подсказка и журнал,
// из деки вводить нельзя, троян на d3 не отпирает запертую.
func TestCodeLock(t *testing.T) {
	w := newWorld(mustParseEmbeddedMap(t))
	now := time.Now()
	w.now = func() time.Time { return now }
	h := w.addPlayer(1, "h", "hacker", -1)
	w.takeOut()
	d3 := w.cyber.devices["d3"]
	if !d3.locked {
		t.Fatalf("d3 must start locked")
	}
	// у двери: позиция в радиусе
	h.pos = vec3{32, 8, 41}
	code := w.doorKeyCode
	// неверный код — N/4 и jurnal
	w.handleMessage(h, message{"t": "enter", "dev": "d3", "code": "0000"})
	out := w.takeOut()
	var hint message
	for _, om := range out {
		if om.msg["t"] == "code" && om.to == h.id {
			hint = om.msg
		}
	}
	if hint == nil || hint["ok"] != false {
		t.Fatalf("wrong code must answer ok=false, got %+v", hint)
	}
	if _, has := hint["match"]; !has {
		t.Fatalf("wrong code must carry N/4 hint")
	}
	// анти-флуд 1/2 с: повтор сразу не перебирает код, но отвечает
	// (match=-1) — молчание вешало панель на «ПРОВЕРКА…»
	w.handleMessage(h, message{"t": "enter", "dev": "d3", "code": "1111"})
	flooded := false
	for _, om := range w.takeOut() {
		if om.msg["t"] == "code" && om.msg["match"] == -1 {
			flooded = true
		}
	}
	if !flooded {
		t.Fatalf("enter flood must be answered with match=-1")
	}
	// верный код после паузы открывает и разлочивает
	now = now.Add(3 * time.Second)
	w.handleMessage(h, message{"t": "enter", "dev": "d3", "code": code})
	okMsg := false
	for _, om := range w.takeOut() {
		if om.msg["t"] == "code" && om.msg["ok"] == true {
			okMsg = true
		}
	}
	if !okMsg || d3.locked || !d3.open {
		t.Fatalf("valid code must unlock+open d3: okMsg=%v locked=%v open=%v", okMsg, d3.locked, d3.open)
	}
}

// --- §16.4 decrypt ------------------------------------------------------------

// decryptWorld — мир для decrypt-тестов: cyberTestWorld + SRV-станция на s1
// (cable 20). seedData сеет door_key на SRV1 сам (§16.5).
func decryptWorld(t *testing.T) (*world, *player, *time.Time) {
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
	  {"kind":"srv","id":"srv1","pos":[20,1,33]},
	  {"kind":"safe","id":"netsafe","pos":[20,1,27]},
	  {"kind":"physafe","id":"physafe","pos":[20,1,36]},
	  {"kind":"door","id":"d1","pos":[20,1,20],"size":[4,3,0.3],"axis":"x","to":"s1"},
	  {"kind":"cable","id":"c1","from":"t1","to":"s1"},
	  {"kind":"cable","id":"c2","from":"t2","to":"s2"},
	  {"kind":"cable","id":"c3","from":"s1","to":"s2","points":[[5,1.15,15],[5,1.15,28],[35,1.15,28],[35,1.15,25]]},
	  {"kind":"cable","id":"c4","from":"s1","to":"d1"},
	  {"kind":"cable","id":"c5","from":"s1","to":"srv1","bw":20},
	  {"kind":"cable","id":"c6","from":"s1","to":"netsafe","bw":10}
	 ]}`
	m, err := parseGameMap([]byte(j))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	w := newWorld(m)
	clock := time.UnixMilli(1_700_000_000_000)
	w.now = func() time.Time { return clock }
	h := w.addPlayer(1, "h1", "hacker", 0)
	w.takeOut()
	jackAt(w, h, "t1")
	// Троян на SRV ставим напрямую (щит — механика vulnscan/trojan, здесь не
	// тестируется); знания скана — напрямую (топология t1-s1-srv1 тривиальна).
	w.cyber.devices["srv1"].owner = h.id
	h.scanned = map[string]bool{"t1": true, "srv1": true}
	w.takeOut()
	return w, h, &clock
}

func hasWire(out []outMsg, to uint64, typ string) bool {
	for _, m := range out {
		if m.to == to && m.msg["t"] == typ {
			return true
		}
	}
	return false
}

// TestDecryptSrvJob — §16.4: джоба на SRV (NPU ×3 = 6 МБ/с): 60 МБ = 10 с.
// Результат enc:false + код поколения; codes команде; job-прогресс (старт +
// 1 Гц); джоба живёт на хосте — переживает джек-аут; смена владельца SRV
// mid-job джобу не отменяет (перехват).
func TestDecryptSrvJob(t *testing.T) {
	w, h, clock := decryptWorld(t)
	srv := w.cyber.devices["srv1"]
	if len(srv.items) == 0 || !srv.items[0].Enc {
		t.Fatalf("seedData must leave an encrypted door_key on srv1")
	}
	w.handleMessage(h, message{"t": "run", "prog": "decrypt", "dev": "srv1", "data": srv.items[0].Name})
	if len(srv.jobs) != 1 {
		t.Fatalf("srv job not started")
	}
	if out := w.takeOut(); !hasWire(out, h.id, "job") {
		t.Fatalf("job start must carry an immediate progress message")
	}
	// джек-аут запустившего: джоба живёт на хосте
	w.handleMessage(h, message{"t": "jackout"})
	if len(srv.jobs) != 1 {
		t.Fatalf("job must survive jackout (lives on the host)")
	}
	// 2 с тика: job 1 Гц виден + смена владельца mid-job не отменяет джобу
	for i := 0; i < 2*30; i++ {
		*clock = clock.Add(time.Second / 30)
		w.simulateTick()
	}
	srv.owner = 999 // перехват: результат достанется новому владельцу хоста
	if len(srv.jobs) != 1 {
		t.Fatalf("owner change mid-job must NOT cancel the job")
	}
	for i := 0; i < 9*30; i++ {
		*clock = clock.Add(time.Second / 30)
		w.simulateTick()
	}
	it := srv.items[0]
	if it.Enc || it.Code == "" || it.Code != w.doorKeyCodeNow(it.Name) {
		t.Fatalf("item must be decrypted with the generation code, got enc=%v code=%q", it.Enc, it.Code)
	}
	out := w.takeOut()
	if !hasWire(out, h.id, "codes") {
		t.Fatalf("finished decrypt must send codes to the initiator team")
	}
	foundCode := false
	for _, m := range out {
		if m.msg["t"] == "codes" && m.msg["door"] == it.Code {
			foundCode = true
		}
	}
	if !foundCode {
		t.Fatalf("codes must carry the decrypted door code %q", it.Code)
	}
}

// TestDecryptNpuDenied — §16.4: decrypt только на NPU-хостах (дека/SRV);
// терминал — denied npu («НУЖЕН NPU»).
func TestDecryptNpuDenied(t *testing.T) {
	w, h, _ := decryptWorld(t)
	t1 := w.cyber.devices["t1"]
	t1.owner = h.id
	t1.items = []dataItem{{Name: "junk", MB: 10, Enc: true}}
	w.handleMessage(h, message{"t": "run", "prog": "decrypt", "dev": "t1", "data": "junk"})
	if !hasDenied(w.takeOut(), h.id, "npu") {
		t.Fatalf("terminal must be denied npu")
	}
}

// TestDecryptDeckJob — §16.4: джоба на деке — процесс деки (NPU ×1, 2 МБ/с:
// 60 МБ = 30 с), отменяется джек-аутом; результат enc:false + код в MEM деки.
func TestDecryptDeckJob(t *testing.T) {
	w, h, clock := decryptWorld(t)
	h.items = append(h.items, dataItem{Name: "door_key", MB: 60, Enc: true})
	w.handleMessage(h, message{"t": "run", "prog": "decrypt", "dev": "deck", "data": "door_key"})
	p := findProg(h, "decrypt")
	if p == nil {
		t.Fatalf("deck decrypt not started")
	}
	if p.work != 30 {
		t.Fatalf("deck decrypt work = %v, want 30 (60 МБ / 2 МБ/с)", p.work)
	}
	for i := 0; i < 31*30 && len(h.progs) > 0; i++ {
		*clock = clock.Add(time.Second / 30)
		w.simulateTick()
	}
	if len(h.progs) != 0 {
		t.Fatalf("deck job must finish in 30 s")
	}
	if len(h.items) != 1 || h.items[0].Enc || h.items[0].Code == "" {
		t.Fatalf("deck item must be decrypted with code, items=%v", h.items)
	}
	out := w.takeOut()
	if !hasWire(out, h.id, "codes") {
		t.Fatalf("deck decrypt must send codes to the team")
	}
	// уже расшифрованный item — decrypted (denied; owner: не смешивать
	// «уже скопировано» и «уже расшифровано» в одном reason)
	w.handleMessage(h, message{"t": "run", "prog": "decrypt", "dev": "deck", "data": "door_key"})
	if !hasDenied(w.takeOut(), h.id, "decrypted") {
		t.Fatalf("decrypt of a plain (enc:false) item must be denied decrypted")
	}
	// джек-аут отменяет дековую джобу (процесс деки, §16.4)
	h.items[0].Enc = true
	w.handleMessage(h, message{"t": "run", "prog": "decrypt", "dev": "deck", "data": "door_key"})
	for i := 0; i < 2*30; i++ {
		*clock = clock.Add(time.Second / 30)
		w.simulateTick()
	}
	w.handleMessage(h, message{"t": "jackout"})
	if findProg(h, "decrypt") != nil {
		t.Fatalf("deck job must die on jackout")
	}
}

// TestDecryptNpuQueue — §16.4 честная NPU-очередь: две джобы на SRV = каждая
// ×0.5 (3 МБ/с): на 10-й секунде ни одна не готова, к 21-й — обе.
func TestDecryptNpuQueue(t *testing.T) {
	w, h, clock := decryptWorld(t)
	srv := w.cyber.devices["srv1"]
	srv.items = append(srv.items, dataItem{Name: "door_key_2", MB: 60, Enc: true})
	w.handleMessage(h, message{"t": "run", "prog": "decrypt", "dev": "srv1", "data": srv.items[0].Name})
	w.handleMessage(h, message{"t": "run", "prog": "decrypt", "dev": "srv1", "data": "door_key_2"})
	if len(srv.jobs) != 2 {
		t.Fatalf("two jobs must queue, got %d", len(srv.jobs))
	}
	for i := 0; i < 10*30; i++ {
		*clock = clock.Add(time.Second / 30)
		w.simulateTick()
	}
	if srv.items[0].Enc == false || srv.items[1].Enc == false {
		t.Fatalf("fair queue: 10 s of two jobs (half rate) must not finish either")
	}
	for i := 0; i < 11*30; i++ {
		*clock = clock.Add(time.Second / 30)
		w.simulateTick()
	}
	if srv.items[0].Enc || srv.items[1].Enc {
		t.Fatalf("both jobs must finish by 21 s at half rate")
	}
}

// TestNetSafe — §16.6 (итерация 5): safe_key сеется на NETSAFE (MEM 128,
// БЕЗ NPU — decrypt-станции только SRV/дека): decrypt на месте — denied npu;
// путь — cp на деку (ветка 10: 120 МБ = 12 с) → decrypt → код сейфа команде
// (codes.safe, HUD «КОД СЕЙФА»); safe-код фиксирован на матч и не равен
// коду d3; новый матч пересеивает safe_key.
func TestNetSafe(t *testing.T) {
	w, h, clock := decryptWorld(t)
	ns := w.cyber.devices["netsafe"]
	if len(ns.items) != 1 || ns.items[0].Name != "safe_key" || ns.items[0].MB != 120 || !ns.items[0].Enc {
		t.Fatalf("seedData must seed safe_key 120 enc on netsafe, got %v", ns.items)
	}
	if ns.npu > 0 {
		t.Fatalf("NETSAFE must have no NPU (decrypt-stations are SRV/deck)")
	}

	// --- §16.6 итерация 5.5: экспоненциальный backoff на сетевые попытки ---
	h.scanned["netsafe"] = true
	// 1-й сетевой vulnscan — база сейфа 8 с (плейтест «слишком быстро»)
	runAndWaitM2(w, h, message{"t": "run", "prog": "vulnscan", "dev": "netsafe"})
	if ns.vulnedBy[h.id] != true {
		t.Fatalf("first network vulnscan must finish")
	}
	// пеня за КАЖДЫЙ старт — «подряд» растёт сразу.
	// trojan: база 10 с ×2 = 20 с
	w.takeOut()
	w.handleMessage(h, message{"t": "run", "prog": "trojan", "dev": "netsafe"})
	p2 := findProg(h, "trojan")
	if p2 == nil {
		t.Fatalf("network trojan must start (slow, not denied)")
	}
	if p2.work != 20 {
		t.Fatalf("network trojan right after vulnscan = %v, want 20 (10 x2)", p2.work)
	}
	slow := false
	for _, m := range w.takeOut() {
		if m.msg["t"] == "slow" && m.msg["mult"] == 2 {
			slow = true
		}
	}
	if !slow {
		t.Fatalf("backed-off start must carry a slow message (x2)")
	}
	// следующая попытка vulnscan — база 8 ×4 = 32 с
	w.handleMessage(h, message{"t": "run", "prog": "vulnscan", "dev": "netsafe"})
	p3 := findProg(h, "vulnscan")
	if p3 == nil || p3.work != 32 {
		t.Fatalf("next vulnscan must be x4 (32 s), got work=%v", p3.work)
	}
	// очередь длинная (trojan 20 + vulnscan 32 при делении) — хвост доедаем
	for i := 0; i < 90*30 && len(h.progs) > 0; i++ {
		*clock = clock.Add(time.Second / 30)
		w.simulateTick()
	}
	// спад: −1 ступень/90 с; было 3 ступени → +5 мин = 0.
	// Проверяем ВТОРЫМ хакером той же команды — заодно доказываем per-team
	// (h после trojan — владелец, exempt)
	h2 := w.addPlayer(3, "h2", "hacker", 0)
	w.takeOut()
	jackAt(w, h2, "t1")
	h2.scanned = map[string]bool{"t1": true, "netsafe": true}
	*clock = clock.Add(5 * time.Minute)
	w.handleMessage(h2, message{"t": "run", "prog": "vulnscan", "dev": "netsafe"})
	p4 := findProg(h2, "vulnscan")
	if p4 == nil || p4.work != 8 {
		t.Fatalf("after decay vulnscan must be back to base 8 s, got work=%v", p4.work)
	}
	w.takeOut()
	// ЛОКАЛЬНЫЙ путь — без пени: джек-ин в сам сейф
	w.handleMessage(h, message{"t": "jackout"})
	jackAt(w, h, "netsafe")
	// «дорогой вход»: 6 с установки канала у сейфа
	for i := 0; i < 7*30; i++ {
		*clock = clock.Add(time.Second / 30)
		w.simulateTick()
	}
	if h.jackHost == nil || h.jackHost.id != "netsafe" {
		t.Fatalf("hacker must jack into netsafe (expensive entry)")
	}
	w.handleMessage(h, message{"t": "run", "prog": "vulnscan", "dev": "netsafe"})
	p5 := findProg(h, "vulnscan")
	if p5 == nil || p5.work != 3 {
		t.Fatalf("LOCAL vulnscan at the safe must have no penalty, got work=%v", p5.work)
	}
	// вернуться в t1 — дальше идёт исходный cp/decrypt сценарий
	w.handleMessage(h, message{"t": "jackout"})
	jackAt(w, h, "t1")
	ns.owner = h.id
	h.scanned["netsafe"] = true
	// decrypt на месте — denied npu
	w.handleMessage(h, message{"t": "run", "prog": "decrypt", "dev": "netsafe", "data": "safe_key"})
	if !hasDenied(w.takeOut(), h.id, "npu") {
		t.Fatalf("NETSAFE must be denied npu")
	}
	// cp на деку: ветка 10 МБ/с (c6) — бутылочка маршрута; 120 МБ = 12 с
	w.handleMessage(h, message{"t": "run", "prog": "cp", "dev": "netsafe", "dst": "deck", "data": "safe_key"})
	p := findProg(h, "cp")
	if p == nil {
		t.Fatalf("cp netsafe->deck must start")
	}
	if p.mb != 120 || p.mbps != 10 {
		t.Fatalf("cp mb/mbps = %d/%v, want 120/10 (branch cable c6)", p.mb, p.mbps)
	}
	for i := 0; i < 13*30 && len(h.progs) > 0; i++ {
		*clock = clock.Add(time.Second / 30)
		w.simulateTick()
	}
	if !deckHasItem(h, "safe_key") {
		t.Fatalf("deck must hold the safe_key copy")
	}
	if !hostHasItem(ns, "safe_key") {
		t.Fatalf("cp must keep the source copy on netsafe")
	}
	// decrypt на деке (NPU ×1): 120 МБ / 2 = 60 с
	w.handleMessage(h, message{"t": "run", "prog": "decrypt", "dev": "deck", "data": "safe_key"})
	for i := 0; i < 61*30 && len(h.progs) > 0; i++ {
		*clock = clock.Add(time.Second / 30)
		w.simulateTick()
	}
	it := h.items[0]
	if it.Name != "safe_key" || it.Enc || it.Code == "" {
		t.Fatalf("safe_key must be decrypted with the safe code, got %+v", it)
	}
	if it.Code == w.doorKeyCode {
		t.Fatalf("safe code must differ from the d3 code")
	}
	out := w.takeOut()
	found := false
	for _, m := range out {
		if m.msg["t"] == "codes" && m.msg["safe"] == it.Code {
			found = true
		}
	}
	if !found {
		t.Fatalf("finished decrypt must send codes.safe to the team")
	}
	if w.safeCodes[h.team] != it.Code {
		t.Fatalf("team must know the safe code permanently")
	}
	// новый матч: safe_key пересеян на NETSAFE, узнанные коды стёрты
	w.doorCodes = map[int]string{}
	w.safeCodes = map[int]string{}
	w.resetDoorKey()
	if !hostHasItem(ns, "safe_key") || ns.items[0].Enc == false {
		t.Fatalf("new match must reseed an encrypted safe_key on netsafe")
	}
	if w.safeCodes[h.team] != "" {
		t.Fatalf("known codes must be wiped on a new match")
	}
}

// TestPhysafe — §16.6 (итерация 7): взятие space (любой класс), ввод кода
// сейфа у PHYSAFE → канал «вскрываем 3 с», урон прерывает, рестарт не даёт
// +10 повторно, успех — matchend reason=extract; смерть носителя роняет сейф;
// доставка на базу стартует канал сама, отход из зоны прерывает.
func TestPhysafe(t *testing.T) {
	w, h, clock := decryptWorld(t)
	if !w.physafePresent {
		t.Fatalf("decryptWorld must carry a physafe prop")
	}
	w.takeOut()
	// space у сейфа — берёт (любой класс; h — хакер, но джек-аут обязательный:
	// джекнутый не двигается и ничего не берёт)
	w.handleMessage(h, message{"t": "jackout"})
	h.pos = vec3{20.5, 1, 36.5}
	h.prevInteract = false // честный edge после jackAt
	h.keys.interact = true
	w.simulateTick()
	h.keys.interact = false
	if w.physafe.carrier == 0 {
		t.Fatalf("space near the physafe must take it (any class)")
	}
	if !h.carry {
		t.Fatalf("carrier flag must be set on the player")
	}
	// несущий: ввод кода у сейфа невозможен (сейф уже у него)
	w.handleMessage(h, message{"t": "enter", "dev": "physafe", "code": w.safeCode})
	if !hasDenied(w.takeOut(), h.id, "bad_target") {
		t.Fatalf("carrier must be denied code entry")
	}
	// смерть носителя роняет сейф на месте
	foe := w.addPlayer(2, "f", "assault", 1)
	w.damage(foe, h, 999)
	if w.physafe.carrier != 0 || w.physafe.pos[0] != h.pos[0] {
		t.Fatalf("death must drop the physafe at the body")
	}
	w.takeOut()
	// воскресим носителя для crack-сценария (тест не про респаун)
	h.alive = true
	h.hp = 100

	// crack-канал: неверный код — N/4 (ok=false), верный — канал + +10 фрагов
	w.handleMessage(h, message{"t": "enter", "dev": "physafe", "code": "0000"})
	out := w.takeOut()
	hint := false
	for _, m := range out {
		if m.msg["t"] == "code" && m.msg["ok"] == false {
			hint = true
		}
	}
	if !hint {
		t.Fatalf("wrong code must answer ok=false with an N/4 hint")
	}
	w.handleMessage(h, message{"t": "enter", "dev": "physafe", "code": w.safeCode})
	out = w.takeOut()
	okMsg := false
	for _, m := range out {
		if m.msg["t"] == "code" && m.msg["ok"] == true {
			okMsg = true
		}
	}
	if !okMsg || w.physafe.chKind != "crack" {
		t.Fatalf("valid code must start the crack channel")
	}
	if w.scores[h.team] != 10 {
		t.Fatalf("first channel start must award +10 frags, scores=%v", w.scores)
	}
	// урон по вскрывающему прерывает канал
	w.damage(foe, h, 1)
	if w.physafe.chKind != "" {
		t.Fatalf("damage to the cracker must break the channel")
	}
	// рестарт канала: +10 НЕ начисляются повторно
	w.handleMessage(h, message{"t": "enter", "dev": "physafe", "code": w.safeCode})
	w.takeOut()
	if w.scores[h.team] != 10 {
		t.Fatalf("channel restart must not re-award frags")
	}
	// успех: 3 с у сейфа → extract win + matchend reason=extract
	for i := 0; i < 4*30; i++ {
		*clock = clock.Add(time.Second / 30)
		w.simulateTick()
	}
	out = w.takeOut()
	win, end := false, false
	for _, m := range out {
		if m.msg["t"] == "extract" && m.msg["stage"] == "win" {
			win = true
		}
		if m.msg["t"] == "matchend" && m.msg["reason"] == "extract" {
			end = true
		}
	}
	if !win || !end {
		t.Fatalf("3 s channel must win the match: win=%v end=%v", win, end)
	}

	// base-канал: другой класс у спавна — канал стартует сам
	w.matchActive = true
	w.physafe.pos = vec3{20, 1, 36}
	w.physafe.carrier = 0
	foe.pos = vec3{20.5, 1, 36.5}
	foe.prevInteract = false
	foe.keys.interact = true
	w.simulateTick()
	foe.keys.interact = false
	if w.physafe.carrier != foe.id {
		t.Fatalf("any class must be able to take the physafe")
	}
	foe.pos = vec3{35, 1, 35} // точка спавна команды 1
	for i := 0; i < 2*30; i++ { // 2 с < канала: не даём врагу выиграть
		*clock = clock.Add(time.Second / 30)
		w.simulateTick()
	}
	if w.physafe.chKind != "base" {
		t.Fatalf("standing in the base zone must auto-start the base channel, kind=%q", w.physafe.chKind)
	}
	// отход из зоны прерывает
	foe.pos = vec3{20, 1, 36}
	*clock = clock.Add(time.Second / 30)
	w.simulateTick()
	if w.physafe.chKind != "" {
		t.Fatalf("leaving the base zone must break the channel")
	}
}
