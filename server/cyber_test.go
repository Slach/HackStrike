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

	if len(cs.order) != 10 || len(cs.cables) != 9 || len(cs.doors) != 2 {
		t.Fatalf("m1 M2+M3 props: want 10 devices / 7 cables + 2 radio uplinks / 2 doors, got %d/%d/%d",
			len(cs.order), len(cs.cables), len(cs.doors))
	}
	// Аплинки: r1→ближайший s1, r2→ближайший s2 — обе точки входа ведут в сеть.
	reach := cs.reachable("t1")
	for _, id := range []string{"t1", "t2", "s1", "s2", "d1", "d2", "r1", "r2", "cam1", "cam2"} {
		if !reach[id] {
			t.Fatalf("%s must be reachable from t1 on m1 (радио — через аплинк)", id)
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

// findAlert — ищет alert для игрока по устройству; nil = не было.
func findAlert(out []outMsg, to uint64, dev string) message {
	for _, om := range out {
		if om.msg["t"] == "alert" && om.to == to && om.msg["dev"] == dev {
			return om.msg
		}
	}
	return nil
}

// Watcher (M3 §13): установка (too_far без скана), триггер на чужой jack-in
// (владельцу, даже не в деке), свой вход не триггерит, смерть гасит
// триггеры, респаун переподключает без переустановки.
func TestWatcher(t *testing.T) {
	w, clock := cyberTestWorld(t)
	h := w.addPlayer(1, "h", "hacker", -1)
	foe := w.addPlayer(2, "f", "hacker", -1)
	killer := w.addPlayer(3, "k", "sniper", -1)
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

	// Чужой джек-ин в t2 — alert хозяину (джекнутому).
	out := jackAt(w, foe, "t2")
	alert := findAlert(out, h.id, "t2")
	if alert == nil {
		t.Fatalf("owner must get an alert on enemy jack-in")
	}
	if alert["who"] != foe.id {
		t.Fatalf("alert.who = %v, want %d", alert["who"], foe.id)
	}

	// Повторный вход триггерится снова; хозяину НЕ в деке — тоже доходит.
	w.handleMessage(foe, message{"t": "jackout"})
	w.handleMessage(h, message{"t": "jackout"})
	out = jackAt(w, foe, "t2")
	if findAlert(out, h.id, "t2") == nil {
		t.Fatalf("offline (not jacked) owner must still receive the alert")
	}

	// Свой вход в наблюдаемое устройство не триггерит.
	runAndWaitM2(w, h, message{"t": "run", "prog": "watcher", "dev": "t1"})
	out = jackAt(w, h, "t1")
	if findAlert(out, h.id, "t1") != nil {
		t.Fatalf("own jack-in must not fire the watcher")
	}

	// Смерть хозяина: триггеры гаснут (§5.5) — уведомления нет.
	w.damage(killer, h, 150)
	if h.alive {
		t.Fatalf("setup: hacker must die")
	}
	w.handleMessage(foe, message{"t": "jackout"})
	out = jackAt(w, foe, "t2")
	if findAlert(out, h.id, "t2") != nil {
		t.Fatalf("dead owner must not receive alerts")
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
	if findAlert(out, h.id, "t2") == nil {
		t.Fatalf("respawned owner must receive alerts again without reinstalling")
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
	runCollect(h, message{"t": "run", "prog": "firewall", "dev": "d1"})
	if w.cyber.devices["d1"].firewalled != h.id {
		t.Fatalf("firewall must be installable on a door")
	}
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
	runCollect(h, message{"t": "run", "prog": "antivirus", "dev": "t2"})
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
	runCollect(h, message{"t": "run", "prog": "antivirus", "dev": "t2"})
	if t2.antivirused != h.id {
		t.Fatalf("setup: antivirus must be reinstalled")
	}
	out = runCollect(foe, message{"t": "run", "prog": "trojan", "dev": "t2"})
	assertDeniedOut(t, out, foe, "antivirus")

	// Контр-плей без тупика: без переустановки повторный trojan проходит —
	// владение перешло, чужой firewall выкурен, вход открыт.
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
