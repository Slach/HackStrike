package main

// M4 объект 1 «газовая камера» (§14.2): DoT по живым внутри AABB с открытым
// вентилем, телеграф перед первым уроном, долг-накопление целыми очками,
// death by=0 без очков, ctrl-владение как у двери.

import (
	"testing"
	"time"
)

// gasTestWorld — мини-карта cyberTestWorld + газовая ловушка g1 (объём
// x27..33, y0..3, z27..33, `to` s2) и кабель c5 g1—s2 (соседство в графе —
// тот же механизм, что у двери d1 через c4: portscan/vulnscan/trojan работают
// без единой строки сетевого кода).
func gasTestWorld(t *testing.T) (*world, *time.Time) {
	t.Helper()
	const j = `{
	 "name":"gas","bounds":[40,8,40],
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
	  {"kind":"gas","id":"g1","pos":[30,1.5,30],"size":[6,3,6],"to":"s2"},
	  {"kind":"cable","id":"c1","from":"t1","to":"s1"},
	  {"kind":"cable","id":"c2","from":"t2","to":"s2"},
	  {"kind":"cable","id":"c3","from":"s1","to":"s2"},
	  {"kind":"cable","id":"c4","from":"s1","to":"d1"},
	  {"kind":"cable","id":"c5","from":"g1","to":"s2"}
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

// advance — n тиков симуляции с переводом инъекчённых часов на dt (gasTick
// завязан на w.now, и тесты обязаны двигать время вместе с тиками).
func advance(w *world, clock *time.Time, n int) []outMsg {
	for i := 0; i < n; i++ {
		*clock = clock.Add(time.Second / tickRate)
		w.simulateTick()
	}
	return w.takeOut()
}

// armGas — взвести клапан в обход ctrl (состоянием владеет только горутина
// комнаты; тесты — белый ящик).
func armGas(w *world, g *device, at time.Time) {
	g.open = true
	g.gasArmAt = at
	g.gasArmCount++
}

// (1) Armed & inside → hp падает ~8 HP/s (float-долг, целые очки).
func TestGasDamageInside(t *testing.T) {
	w, clock := gasTestWorld(t)
	p := w.addPlayer(1, "p", "assault", -1)  // team 0, 125 HP
	foe := w.addPlayer(2, "f", "sniper", -1) // team 1 — FF ON: бьёт всех живых
	w.takeOut()
	p.pos = vec3{30, 1, 30}
	foe.pos = vec3{31, 1, 31}
	g := w.cyber.devices["g1"]
	armGas(w, g, *clock)

	advance(w, clock, 50) // 1.667 с: телеграф + накопленный первый целый пункт
	hpAfterTelegraph := p.hp
	if hpAfterTelegraph >= 125 {
		t.Fatalf("first damage must land right after telegraph, hp=%d", p.hp)
	}

	advance(w, clock, 60) // ещё 2 с → ещё ~16 HP, FF по чужой команде тоже
	wantP := 125 - 1 - 16 // первый тик после телеграфа инициализирует долг
	if p.hp > wantP+1 || p.hp < wantP-1 {
		t.Fatalf("assault in gas 2 c after telegraph: hp=%d, want ~%d (8 HP/s)", p.hp, wantP)
	}
	wantF := 100 - 1 - 16
	if foe.hp > wantF+1 || foe.hp < wantF-1 {
		t.Fatalf("FF ON: enemy team must take the same DoT, hp=%d want ~%d", foe.hp, wantF)
	}
	if w.scores != [2]int{} {
		t.Fatalf("gas must never score, scores=%v", w.scores)
	}
}

// (2) Телеграф-окно: первые 1.5 с после взвода урона нет; после — есть.
func TestGasTelegraphNoDamage(t *testing.T) {
	w, clock := gasTestWorld(t)
	p := w.addPlayer(1, "p", "assault", -1)
	w.takeOut()
	p.pos = vec3{30, 1, 30}
	g := w.cyber.devices["g1"]
	armGas(w, g, *clock)

	advance(w, clock, 42) // 1.4 с — ещё телеграф
	if p.hp != 125 {
		t.Fatalf("no damage during telegraph, hp=%d", p.hp)
	}
	advance(w, clock, 10) // перешагнули порог 1.5 с
	if p.hp == 125 {
		t.Fatalf("damage must start after telegraph window")
	}
}

// (3) Вне объёма — урона нет даже после телеграфа.
func TestGasOutsideNoDamage(t *testing.T) {
	w, clock := gasTestWorld(t)
	p := w.addPlayer(1, "p", "assault", -1)
	w.takeOut()
	p.pos = vec3{20, 1, 20} // далеко от g1 (x27..33, z27..33)
	g := w.cyber.devices["g1"]
	armGas(w, g, *clock)

	advance(w, clock, 150) // 5 с
	if p.hp != 125 {
		t.Fatalf("player outside the box must not take gas damage, hp=%d", p.hp)
	}
}

// Снятие гасит мгновенно: закрытие клапана мгновенно останавливает урон,
// повторное взведение рестартаит телеграф и долг (§14.2).
func TestGasDisarmStopsAndRearmRestarts(t *testing.T) {
	w, clock := gasTestWorld(t)
	p := w.addPlayer(1, "p", "assault", -1)
	w.takeOut()
	p.pos = vec3{30, 1, 30}
	g := w.cyber.devices["g1"]
	armGas(w, g, *clock)

	advance(w, clock, 76) // телеграф + ~1 с → уже текли очки
	if p.hp >= 125 {
		t.Fatalf("expected damage before disarm")
	}
	hpAfterDisarmPrep := p.hp

	g.open = false
	g.gasArmAt = time.Time{}
	advance(w, clock, 30) // 1 с закрытого клапана
	dropClosed := hpAfterDisarmPrep - p.hp
	// Объёмный DoT остановлен мгновенно; течёт только яд ~2.5 HP/s
	// (rev 2026-11-21 «газ отравленный») — в разы меньше объёмных 8 HP/s.
	if dropClosed < 1 || dropClosed > 4 {
		t.Fatalf("closed valve: only poison (~2.5 HP/s) may tick, got %d HP in 1s", dropClosed)
	}

	armGas(w, g, *clock)  // close→open: телеграф рестарт, долг обнулён
	advance(w, clock, 45) // 1.5 с — телеграф: объёмного урона нет, яд течёт
	dropTelegraph := hpAfterDisarmPrep - p.hp - dropClosed
	if dropTelegraph < 2 || dropTelegraph > 6 {
		t.Fatalf("re-armed valve must not inherit old debt (fresh telegraph): only poison may tick, got %d HP in 1.5s", dropTelegraph)
	}
}

// (4) Смерть в НЕЙТРАЛЬНОЙ (без владельца) газовой ловушке: respawnAt=now+5s,
// авто-джек-аут, scores не тронуты, death by=0 жертве + broadcast
// envkill(victim, owner=0), ни одного shot.
func TestGasDeathEnvKill(t *testing.T) {
	w, clock := gasTestWorld(t)
	h := w.addPlayer(1, "h", "hacker", -1) // team 0, 100 HP
	w.takeOut()
	jackAt(w, h, "t1") // хакер в деке: смерть в газе = авто-джек-аут
	h.pos = vec3{30, 1, 30}
	h.hp = 4
	g := w.cyber.devices["g1"]
	armGas(w, g, *clock)

	var out []outMsg
	for i := 0; i < 300 && h.alive; i++ {
		*clock = clock.Add(time.Second / tickRate)
		w.simulateTick()
		out = append(out, w.takeOut()...)
	}
	if h.alive {
		t.Fatalf("4 HP in gas after telegraph must die")
	}
	if h.hp != 0 {
		t.Fatalf("hp clamp to 0, got %d", h.hp)
	}
	if want := clock.Add(respawnDelay); !h.respawnAt.Equal(want) {
		t.Fatalf("respawnAt = %v, want %v (+5 s)", h.respawnAt, want)
	}
	if h.jacked {
		t.Fatalf("gas death must auto-jackout the hacker")
	}
	if w.scores != [2]int{} {
		t.Fatalf("trap kill must not score, scores=%v", w.scores)
	}
	foundDeath, foundKill, foundShot := false, false, false
	for _, om := range out {
		switch om.msg["t"] {
		case "death":
			if om.to != h.id {
				t.Fatalf("death must go to the victim, to=%d", om.to)
			}
			if om.msg["by"] != uint64(0) {
				t.Fatalf("death.by = %v, want 0 (environment)", om.msg["by"])
			}
			foundDeath = true
		case "envkill":
			// §14.3: broadcast (to=0), имя берём из victim — киллфид всем.
			if om.to != 0 {
				t.Fatalf("envkill must broadcast, to=%d", om.to)
			}
			if om.msg["victim"] != h.id {
				t.Fatalf("envkill.victim = %v, want %d", om.msg["victim"], h.id)
			}
			if om.msg["owner"] != uint64(0) {
				t.Fatalf("neutral trap envkill.owner = %v, want 0", om.msg["owner"])
			}
			foundKill = true
		case "shot":
			foundShot = true
		}
	}
	if !foundDeath {
		t.Fatalf("want env death message to victim")
	}
	if !foundKill {
		t.Fatalf("want envkill broadcast to all")
	}
	if foundShot {
		t.Fatalf("environment kill must not produce shot messages")
	}
}

// (4b) Смерть при trojan-владельце: +1 команде владельца (§14.1, решение
// владельца 2026-11-15), envkill несёт owner. Хакер-владелец стоит ВНЕ
// объёма — «сам в свой газ» проверяется отдельным тестом.
func TestGasKillScoresOwnerTeam(t *testing.T) {
	w, clock := gasTestWorld(t)
	h := w.addPlayer(1, "h", "hacker", -1)  // team 0, вне газы
	v := w.addPlayer(2, "v", "assault", -1) // team 1, 125 HP — жертва
	w.takeOut()
	jackAt(w, h, "t1")
	ownGas(t, w, h)
	w.handleMessage(h, message{"t": "ctrl", "dev": "g1", "action": "toggle"})
	w.takeOut()

	v.pos = vec3{30, 1, 30}
	v.hp = 4
	var out []outMsg
	for i := 0; i < 300 && v.alive; i++ {
		*clock = clock.Add(time.Second / tickRate)
		w.simulateTick()
		out = append(out, w.takeOut()...)
	}
	if v.alive {
		t.Fatalf("4 HP in gas must die")
	}
	if w.scores != [2]int{1, 0} {
		t.Fatalf("owner team must get the kill, scores=%v", w.scores)
	}
	for _, om := range out {
		if om.msg["t"] == "envkill" {
			if om.msg["owner"] != h.id || om.msg["victim"] != v.id {
				t.Fatalf("envkill = %v, want owner=%d victim=%d", om.msg, h.id, v.id)
			}
			return
		}
	}
	t.Fatalf("want envkill broadcast")
}

// (4c) Владелец сгорел в собственном газу: очков нет (фарм «сам в свой газ»
// отрезан), death/envkill как обычно, оверлей жертве не врёт.
func TestGasKillOwnerInOwnGasNoScore(t *testing.T) {
	w, clock := gasTestWorld(t)
	h := w.addPlayer(1, "h", "hacker", -1) // team 0
	w.takeOut()
	jackAt(w, h, "t1")
	ownGas(t, w, h)
	w.handleMessage(h, message{"t": "ctrl", "dev": "g1", "action": "toggle"})
	w.takeOut()

	h.pos = vec3{30, 1, 30} // сам зашёл в свой газ
	h.hp = 4
	for i := 0; i < 300 && h.alive; i++ {
		*clock = clock.Add(time.Second / tickRate)
		w.simulateTick()
		w.takeOut()
	}
	if h.alive {
		t.Fatalf("4 HP in gas must die")
	}
	if w.scores != [2]int{} {
		t.Fatalf("owner==victim must never score, scores=%v", w.scores)
	}
}

// --- владение и ctrl (§14.2: газ — контроллер, как дверь) -----------------

// ownGas — portscan до g1 → vulnscan → trojan: g1 принадлежит h.
func ownGas(t *testing.T, w *world, h *player) {
	t.Helper()
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
	// Хопы от t1: 1) s1+r1 2) s2+d1 3) g1+t2 (g1 — сосед s2 по c5).
	runAndWait(message{"t": "run", "prog": "portscan"})
	runAndWait(message{"t": "run", "prog": "portscan"})
	runAndWait(message{"t": "run", "prog": "portscan"})
	runAndWait(message{"t": "run", "prog": "vulnscan", "dev": "g1"})
	runAndWait(message{"t": "run", "prog": "trojan", "dev": "g1"})
}

// (5) ctrl toggle владельцем trojan: открывает вентиль с arm-таймером, snap
// несёт open; повторный toggle закрывает и гасит arm.
func TestGasCtrlByOwner(t *testing.T) {
	w, clock := gasTestWorld(t)
	h := w.addPlayer(1, "h", "hacker", -1)
	w.takeOut()
	jackAt(w, h, "t1")
	ownGas(t, w, h)

	g := w.cyber.devices["g1"]
	if g.owner != h.id {
		t.Fatalf("trojan must own the gas valve, owner=%d", g.owner)
	}

	w.handleMessage(h, message{"t": "ctrl", "dev": "g1", "action": "toggle"})
	w.takeOut()
	if !g.open {
		t.Fatalf("owner toggle must open the valve")
	}
	if !g.gasArmAt.Equal(*clock) {
		t.Fatalf("arm timestamp must be set to now, got %v", g.gasArmAt)
	}

	// snap.props: газ несёт open, как дверь (§14.3).
	out := advance(w, clock, 1)
	var snapProps []any
	for _, om := range out {
		if om.msg["t"] == "snap" {
			snapProps, _ = om.msg["props"].([]any)
		}
	}
	gasSnap, found := false, false
	for _, pm := range snapProps {
		m := pm.(message) // snapProps строит message, не map[string]any
		if m["id"] == "g1" {
			found = true
			gasSnap, _ = m["open"].(bool)
		}
	}
	if !found || !gasSnap {
		t.Fatalf("snap props must carry gas open=true, found=%v open=%v", found, gasSnap)
	}

	w.handleMessage(h, message{"t": "ctrl", "dev": "g1", "action": "toggle"})
	w.takeOut()
	if g.open {
		t.Fatalf("second toggle must close the valve")
	}
	if !g.gasArmAt.IsZero() {
		t.Fatalf("close must clear the arm timestamp")
	}
}

// (6) Чужой и не-джекнутый: not_owner / not_jacked — как у двери (§12.5).
func TestGasCtrlDeniedNonOwner(t *testing.T) {
	w, _ := gasTestWorld(t)
	h := w.addPlayer(1, "h", "hacker", -1)
	foe := w.addPlayer(2, "f", "hacker", -1)
	w.takeOut()
	jackAt(w, h, "t1")
	ownGas(t, w, h)

	jackAt(w, foe, "t2")
	w.handleMessage(foe, message{"t": "ctrl", "dev": "g1", "action": "toggle"})
	assertDenied(t, w, foe, "not_owner")
	if w.cyber.devices["g1"].open {
		t.Fatalf("valve state must be untouched by the stranger")
	}

	// Владелец вышел из деки — контроллер недоступен.
	w.handleMessage(h, message{"t": "jackout"})
	w.handleMessage(h, message{"t": "ctrl", "dev": "g1", "action": "toggle"})
	assertDenied(t, w, h, "not_jacked")
}

// g1 — обычное сетевое устройство: портируется discovery без исключений.
func TestGasNetworkDiscovery(t *testing.T) {
	w, clock := gasTestWorld(t)
	h := w.addPlayer(1, "h", "hacker", -1)
	w.takeOut()
	jackAt(w, h, "t1")
	scanStep(w, h, clock, 3)
	if !h.scanned["g1"] {
		t.Fatalf("portscan must discover the gas valve like any device")
	}
	if !w.cyber.reachable("t1")["g1"] {
		t.Fatalf("g1 must be a graph neighbor of s2 via cable c5")
	}
}

// (11) Яд (rev 2026-11-21): после выхода из объёма отравление продолжает
// жечь ~2.5 HP/s ещё 10 с, потом останавливается. Внутри объёма яд не
// дублирует объёмный DoT.
func TestGasPoisonAfterLeave(t *testing.T) {
	w, clock := gasTestWorld(t)
	p := w.addPlayer(1, "p", "heavy", -1) // 200 HP — запас на объём+яд
	w.takeOut()
	p.pos = vec3{30, 1, 30}
	g := w.cyber.devices["g1"]
	armGas(w, g, *clock)

	advance(w, clock, 90) // 3 с: 1.5 телеграф + 1.5 объёмного DoT → отравлен
	insideHP := p.hp
	if insideHP >= 200 {
		t.Fatalf("volume DoT must land while inside, hp=%d", p.hp)
	}
	if !p.gasPoisonUntil.After(*clock) {
		t.Fatalf("damage ticks inside must arm the poison debuff")
	}

	p.pos = vec3{20, 1, 20} // вышел из объёма (далеко от g1)
	advance(w, clock, 60)   // 2 с яда → ~5 HP
	want := insideHP - 5
	if p.hp > want+1 || p.hp < want-1 {
		t.Fatalf("poison outside: hp=%d, want ~%d (2.5 HP/s)", p.hp, want)
	}

	advance(w, clock, 300) // ещё 10 с: яд истекает на ~13-й секунде → всего ~25 HP
	want = insideHP - 25
	if p.hp > want+2 || p.hp < want-2 {
		t.Fatalf("poison must expire after %v: hp=%d, want ~%d", gasPoisonDur, p.hp, want)
	}
	hp := p.hp
	advance(w, clock, 120) // 4 с после истечения — HP не меняется
	if p.hp != hp {
		t.Fatalf("poison must stop after expiry: hp %d -> %d", hp, p.hp)
	}
}

// (12) Отравление не переживает смерть: респавн с полным HP без яда.
func TestGasPoisonDiesWithPlayer(t *testing.T) {
	w, clock := gasTestWorld(t)
	p := w.addPlayer(1, "p", "assault", -1)
	w.takeOut()
	p.pos = vec3{30, 1, 30}
	g := w.cyber.devices["g1"]
	armGas(w, g, *clock)
	advance(w, clock, 550) // ~18.3 с: объёмный DoT 8 HP/s добирает 125 HP (яд внутри не дублируется)
	if p.alive {
		t.Fatalf("standing inside the gas must kill an assault eventually")
	}
	if !p.gasPoisonUntil.IsZero() {
		t.Fatalf("death must clear the poison debuff")
	}
}

// §16.6 rev 2026-11-21: ловушка с владельцем убила НОСИТЕЛЯ — команде
// владельца фраг + бонус +5 (тот же путь, что у стрелка).
func TestCarrierKillBonusEnv(t *testing.T) {
	w, clock := gasTestWorld(t)
	foe := w.addPlayer(2, "f", "sniper", -1) // владелец газа
	w.takeOut()
	carrier := w.addPlayer(3, "c", "heavy", -1)
	w.takeOut()
	foe.team, carrier.team = 1, 0 // авто-баланс назначил бы наоборот
	carrier.pos = vec3{30, 1, 30}
	carrier.carry = true
	g := w.cyber.devices["g1"]
	armGas(w, g, *clock)
	g.owner = foe.id // trojan-владелец газа — враг
	advance(w, clock, 950) // ~31.7 с: телеграф + 8 HP/s добирают 200 HP heavy
	if carrier.alive {
		t.Fatalf("carrier must die in the gas")
	}
	if w.scores[1] != 1+carrierKillBonus || w.scores[0] != 0 {
		t.Fatalf("trap-carrier kill must award frag+bonus to owner team, scores=%v", w.scores)
	}
}
