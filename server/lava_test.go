package main

// M4 объект 2 «пол-лава» (§14.6): постоянный DoT по AABB лужи (LAVA_DPS=25),
// без телеграфа и сетевого цикла — лава не устройство, «ландшафт». Убийство
// — среда: envDamage(owner=0) → death by:0, envkill owner=0, счёт чистый.
// FF ON: бьёт всех живых в объёме. Шаг урона — float-долг на (пул, игрок),
// целые списания (тот же механизм, что у газа).

import (
	"testing"
	"time"
)

// lavaTestWorld — мини-карта: пол y0..1, терраса-плита y7..8 над всей
// ареной (для теста «этаж выше — не задевает»), одна лавовая лужа lv1
// с pos=[20,1,20] size=[4,0.3,4] → объём x18..22, y0.85..1.15, z18..22;
// стоит точно на полу. Спавны далеко от лужи.
func lavaTestWorld(t *testing.T) (*world, *time.Time) {
	t.Helper()
	const j = `{
	 "name":"lava","bounds":[40,16,40],
	 "colliders":[
	  {"min":[0,0,0],"max":[40,1,40],"kind":"floor"},
	  {"min":[0,7,0],"max":[40,8,40],"kind":"floor"},
	  {"min":[30,8,30],"max":[30.7,8.5,32],"kind":"stair"}
	 ],
	 "spawns":{"0":[[5,1,5]],"1":[[35,1,35]]},
	 "props":[
	  {"kind":"lava","id":"lv1","pos":[20,1,20],"size":[4,0.3,4]}
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

// (1) Стоящий в луже теряет ~25 HP/с (±1 на секунду; первый тик только сеет
// долг, телеграфа нет — в отличие от газа первый урон уже на 2-м тике).
func TestLavaDamageInside(t *testing.T) {
	w, clock := lavaTestWorld(t)
	p := w.addPlayer(1, "p", "assault", -1) // team 0, 125 HP
	w.takeOut()
	p.pos = vec3{20, 1, 20}

	advance(w, clock, 2) // без телеграфа: первый целый пункт уже на тике 2
	if p.hp != 124 {
		t.Fatalf("no telegraph expected: first point on tick 2, hp=%d", p.hp)
	}

	advance(w, clock, 29) // суммарно ~1 с в луже
	if diff := 125 - p.hp; diff < 24 || diff > 26 {
		t.Fatalf("1 s in lava: want ~25 damage (±1), got %d (hp=%d)", diff, p.hp)
	}
	advance(w, clock, 30) // ещё секунда
	if diff := 125 - p.hp; diff < 49 || diff > 51 {
		t.Fatalf("2 s in lava: want ~50 damage (±1), got %d (hp=%d)", diff, p.hp)
	}
}

// (2) Вне объёма — урона нет даже долго.
func TestLavaOutsideNoDamage(t *testing.T) {
	w, clock := lavaTestWorld(t)
	p := w.addPlayer(1, "p", "assault", -1)
	w.takeOut()
	p.pos = vec3{30, 1, 30} // далеко от lv1 (x18..22, z18..22)

	advance(w, clock, 150) // 5 с
	if p.hp != 125 {
		t.Fatalf("player outside the pool must not take lava damage, hp=%d", p.hp)
	}
}

// (3) Смерть в лаве: death by:0 приватно жертве, envkill owner=0 broadcast,
// scores не тронуты, respawnAt = now+5 c; респаун после задержки живёт.
func TestLavaDeathEnvKill(t *testing.T) {
	w, clock := lavaTestWorld(t)
	h := w.addPlayer(1, "h", "hacker", -1) // team 0, 100 HP
	w.takeOut()
	h.pos = vec3{20, 1, 20}
	h.hp = 3

	var out []outMsg
	for i := 0; i < 300 && h.alive; i++ {
		*clock = clock.Add(time.Second / tickRate)
		w.simulateTick()
		out = append(out, w.takeOut()...)
	}
	if h.alive {
		t.Fatalf("3 HP in lava must die")
	}
	if h.hp != 0 {
		t.Fatalf("hp clamp to 0, got %d", h.hp)
	}
	if want := clock.Add(respawnDelay); !h.respawnAt.Equal(want) {
		t.Fatalf("respawnAt = %v, want %v (+5 s)", h.respawnAt, want)
	}
	if w.scores != [2]int{} {
		t.Fatalf("lava kill must not score, scores=%v", w.scores)
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
			if om.to != 0 {
				t.Fatalf("envkill must broadcast, to=%d", om.to)
			}
			if om.msg["victim"] != h.id {
				t.Fatalf("envkill.victim = %v, want %d", om.msg["victim"], h.id)
			}
			if om.msg["owner"] != uint64(0) {
				t.Fatalf("lava envkill.owner = %v, want 0 (no network owner)", om.msg["owner"])
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

	// респаун по истечении respawnAt — жив и уже не в лаве (командный спавн)
	*clock = clock.Add(respawnDelay + time.Second)
	w.handleRespawn(h, "hacker")
	if !h.alive || h.hp != 100 {
		t.Fatalf("respawn after +5 s must revive at full hp, alive=%v hp=%d", h.alive, h.hp)
	}
}

// (4) FF ON: двое живых в объёме горят одинаково, независимо от команды.
func TestLavaFFBothBurn(t *testing.T) {
	w, clock := lavaTestWorld(t)
	p := w.addPlayer(1, "p", "assault", -1)  // team 0, 125 HP
	foe := w.addPlayer(2, "f", "sniper", -1) // team 1, 100 HP
	w.takeOut()
	p.pos = vec3{20, 1, 20}
	foe.pos = vec3{21, 1, 21} // тот же пул, другая команда

	advance(w, clock, 31) // ~1 с: первый тик сеет долг
	if diff := 125 - p.hp; diff < 24 || diff > 26 {
		t.Fatalf("assault in lava 1 s: want ~25, got %d (hp=%d)", diff, p.hp)
	}
	if diff := 100 - foe.hp; diff < 24 || diff > 26 {
		t.Fatalf("FF ON: enemy team must burn the same, got %d (hp=%d)", diff, foe.hp)
	}
	if w.scores != [2]int{} {
		t.Fatalf("lava must never score, scores=%v", w.scores)
	}
}

// (5) Игрок на террасе (y=8) прямо над столбом лужи не задевается: боксы
// разведены по Y — игрок «на плите», лава «под плитой».
func TestLavaTerraceSeparation(t *testing.T) {
	w, clock := lavaTestWorld(t)
	p := w.addPlayer(1, "p", "assault", -1)
	w.takeOut()
	p.pos = vec3{20, 8, 20} // точно над центром lv1, на террасе

	lv := w.cyber.lavas[0]
	if boxesOverlap(playerBoxAt(p.pos), lv.box) {
		t.Fatalf("terrace box must not reach pool: pool %v", lv.box)
	}

	advance(w, clock, 60) // 2 с
	if p.hp != 125 {
		t.Fatalf("standing on the terrace above must take no lava damage, hp=%d", p.hp)
	}
}
