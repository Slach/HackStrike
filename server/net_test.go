package main

// M5 итерация 1 «канал сети» (§16.3, ревизия 1): bw-модель линков —
// widest-path, backplane свитчей, честные очереди на линках (сканы делят
// канал: доля = bw/N, если доля < спроса — прогресс замедляется).

import (
	"strconv"
	"testing"
	"time"
)

// Сеть для net-тестов: t1—c1(40)—s1(bp по сценарию)—c2(4)—d1;
// s1—c3(40)—s2(bp 60)—c4(40)—d1 — два маршрута s1→d1 с разными бутылочками;
// t2—c5(40)—s1 — вторая точка входа за той же шиной s1.
func netTestWorld(t *testing.T, s1Backplane float64) *world {
	t.Helper()
	j := `{
	 "name":"net","bounds":[40,8,40],
	 "colliders":[{"min":[0,0,0],"max":[40,1,40],"kind":"floor"},
	  {"min":[0,1,37],"max":[0.7,1.5,39],"kind":"stair"}],
	 "spawns":{"0":[[5,1,5]],"1":[[35,1,35]]},
	 "props":[
	  {"kind":"terminal","id":"t1","pos":[5,1,8]},
	  {"kind":"terminal","id":"t2","pos":[35,1,32]},
	  {"kind":"switch","id":"s1","pos":[5,1,15],"backplane":` + strconv.FormatFloat(s1Backplane, 'f', -1, 64) + `},
	  {"kind":"switch","id":"s2","pos":[35,1,25]},
	  {"kind":"door","id":"d1","pos":[20,1,20],"size":[4,3,0.3],"axis":"x","to":"s1"},
	  {"kind":"cable","id":"c1","from":"t1","to":"s1","bw":40},
	  {"kind":"cable","id":"c2","from":"s1","to":"d1","bw":4},
	  {"kind":"cable","id":"c3","from":"s1","to":"s2","bw":40},
	  {"kind":"cable","id":"c4","from":"s2","to":"d1","bw":40},
	  {"kind":"cable","id":"c5","from":"t2","to":"s1","bw":40}
	 ]}`
	m, err := parseGameMap([]byte(j))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	w := newWorld(m)
	clock := time.UnixMilli(1_700_000_000_000)
	w.now = func() time.Time { return clock }
	return w
}

// jackIn — джек-ин у dev и два portscan (открыть s1 и d1).
func jackIn(t *testing.T, w *world, pl *player, dev string) {
	t.Helper()
	jackAt(w, pl, dev)
	w.takeOut()
	for i := 0; i < 2; i++ {
		w.handleMessage(pl, message{"t": "run", "prog": "portscan"})
		for j := 0; j < 400 && len(pl.progs) > 0; j++ {
			w.simulateTick()
		}
		w.takeOut()
	}
}

// tickFor — прокрутить dur сим-времени.
func tickFor(w *world, clock *time.Time, dur time.Duration) {
	steps := int(dur.Seconds() * 30)
	for j := 0; j < steps; j++ {
		*clock = clock.Add(time.Second / 30)
		w.simulateTick()
	}
}

// TestWidestPathPicksWide — widest-path (§16.2): из двух маршрутов к d1
// выбран маршрут с большей бутылочкой (c3+c4 по 40 против прямого c2=4).
func TestWidestPathPicksWide(t *testing.T) {
	w := netTestWorld(t, 60)
	path := w.cyber.widestPath("s1", "d1", func(string) bool { return false })
	if len(path) != 3 || path[1] != "s2" {
		t.Fatalf("path = %v, want via s2 (wide route)", path)
	}
	// Firewall врага на s2 — транзит закрыт, fallback на узкий прямой.
	w.cyber.devices["s2"].firewalled = 99
	w.players[99] = &player{id: 99, team: 1}
	enemy := &player{id: 7, team: 0}
	path = w.cyber.widestPath("s1", "d1", func(id string) bool {
		return w.firewallBlocksThrough(w.cyber.devices[id], enemy)
	})
	if len(path) != 2 || path[1] != "d1" {
		t.Fatalf("path behind enemy firewall = %v, want direct s1→d1", path)
	}
}

// TestVulnscanSlowedByBackplane — vulnscan через тонкий backplane (2 МБ/с)
// замедляется вдвое даже в одиночку (доля 2 < спроса 4, §16.3); широкий
// backplane полная скорость. За 1 с сим-времени прогресс = фактор.
func TestVulnscanSlowedByBackplane(t *testing.T) {
	for _, tc := range []struct {
		bp     float64
		factor float64
	}{
		{bp: 2, factor: 0.5},
		{bp: 60, factor: 1.0},
	} {
		w := netTestWorld(t, tc.bp)
		pl := w.addPlayer(1, "h1", "hacker", -1)
		w.takeOut()
		jackIn(t, w, pl, "t1")
		w.handleMessage(pl, message{"t": "run", "prog": "vulnscan", "dev": "d1"})
		if len(pl.progs) != 1 {
			t.Fatalf("vulnscan not started")
		}
		clock := time.UnixMilli(1_700_000_000_100)
		w.now = func() time.Time { return clock }
		tickFor(w, &clock, time.Second)
		got := pl.progs[0].progress
		if diff := got - tc.factor; diff > 0.05 || diff < -0.05 {
			t.Fatalf("bp=%v: progress = %.3f, want ~%.3f", tc.bp, got, tc.factor)
		}
	}
}

// TestScansShareBackplane — два vulnscan'а за одной шиной делят её
// по-честному (§16.3): доля = bp/2 = 1 МБ/с < спроса 4 → фактор 0.25 у
// обоих (против 0.5 у одиночки — конкуренция видна).
func TestScansShareBackplane(t *testing.T) {
	w := netTestWorld(t, 2)
	a := w.addPlayer(1, "h1", "hacker", -1)
	b := w.addPlayer(2, "h2", "hacker", -1)
	w.takeOut()
	jackIn(t, w, a, "t1")
	jackIn(t, w, b, "t2")
	w.handleMessage(a, message{"t": "run", "prog": "vulnscan", "dev": "d1"})
	w.handleMessage(b, message{"t": "run", "prog": "vulnscan", "dev": "d1"})
	if len(a.progs) != 1 || len(b.progs) != 1 {
		t.Fatalf("vulnscans not started")
	}
	clock := time.UnixMilli(1_700_000_000_100)
	w.now = func() time.Time { return clock }
	tickFor(w, &clock, time.Second)
	for _, pl := range []*player{a, b} {
		got := pl.progs[0].progress
		if diff := got - 0.25; diff > 0.05 || diff < -0.05 {
			t.Fatalf("shared backplane: player %d progress = %.3f, want ~0.25", pl.id, got)
		}
	}
}

// TestSingleLinkFullSpeed — один потребитель: доля = весь bw ≥ спроса,
// тайминги M2–M4 не меняются (обратная совместимость плейтестов).
func TestSingleLinkFullSpeed(t *testing.T) {
	w := netTestWorld(t, 60)
	pl := w.addPlayer(1, "h1", "hacker", -1)
	w.takeOut()
	jackIn(t, w, pl, "t1")
	w.handleMessage(pl, message{"t": "run", "prog": "vulnscan", "dev": "d1"})
	w.netF = w.computeNetFactors()
	if f := w.netF[pl.progs[0]]; f != 1 {
		t.Fatalf("single vulnscan factor = %v, want 1", f)
	}
}
