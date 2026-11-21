package main

// Тесты §15.40: диагностика ввода по нику (/api/diag → welcome.diag=1 и
// мгновенный {"t":"diag"} онлайн-носителю).

import (
	"testing"
	"time"
)

func TestDiagToggleWelcomeAndInstant(t *testing.T) {
	m := mustParseEmbeddedMap(t)
	r := newRoom(m)
	r.world.now = func() time.Time { return time.UnixMilli(1_700_000_000_000) }

	// держатель стенда отмечает имя ДО входа — носителя в игре ещё нет
	if !r.handleDiag(diagToggle{name: "григ", on: true}) {
		t.Fatal("toggle on must report on")
	}

	c := &client{id: 1, send: make(chan message, 8)}
	r.handleConnect(c)
	r.handleInput(taggedMessage{from: c, msg: message{"t": "join", "name": "григ", "cls": "sniper"}})
	wl := <-c.send
	if wl["t"] != "welcome" || wl["diag"] != 1 {
		t.Fatalf("marked join must get welcome.diag=1: %+v", wl)
	}

	// выключение — мгновенный diag=0 носителю, welcome больше не помечен
	if r.handleDiag(diagToggle{name: "григ", on: false}) {
		t.Fatal("toggle off must report off")
	}
	r.flush()
	mg := <-c.send
	if mg["t"] != "diag" || mg["on"] != 0 {
		t.Fatalf("online holder must get instant {t:diag,on:0}: %+v", mg)
	}
	c2 := &client{id: 2, send: make(chan message, 8)}
	r.handleConnect(c2)
	r.handleInput(taggedMessage{from: c2, msg: message{"t": "join", "name": "григ-2", "cls": "heavy"}})
	wl2 := <-c2.send
	if _, ok := wl2["diag"]; ok {
		t.Fatalf("unmarked join must not carry diag: %+v", wl2)
	}

	// регистронезависимая отметка: /api/diag?name=ГРИГ включает того же «григ»
	r.handleDiag(diagToggle{name: "ГРИГ", on: true})
	r.handleDiag(diagToggle{name: "григ", on: true}) // тот же канон, не дубль
	r.flush()
	mg2 := <-c.send
	if mg2["t"] != "diag" || mg2["on"] != 1 {
		t.Fatalf("case-insensitive re-mark must echo on=1 to holder: %+v", mg2)
	}
}

// Ручной вход через URL-параметр не зависит от серверного флага — проверка,
// что welcome НЕ содержит diag, когда никто не размечен (обратная сторона
// прошлого теста: omitempty соблюдён).
func TestDiagWelcomeOmitWhenUnmarked(t *testing.T) {
	m := mustParseEmbeddedMap(t)
	r := newRoom(m)
	c := &client{id: 1, send: make(chan message, 8)}
	r.handleConnect(c)
	r.handleInput(taggedMessage{from: c, msg: message{"t": "join", "name": "anon", "cls": "assault"}})
	wl := <-c.send
	if _, ok := wl["diag"]; ok {
		t.Fatalf("unmarked welcome must omit diag: %+v", wl)
	}
}

// §15.40: diagrec копится только от помеченных, анти-спам 2 Гц, запись
// несёт серверную правду секунды; выгрузка — копия из буфера по канону ника.
func TestDiagRecAccumulateAndDump(t *testing.T) {
	m := mustParseEmbeddedMap(t)
	r := newRoom(m)
	ticks := time.UnixMilli(1_700_000_000_000)
	r.world.now = func() time.Time { return ticks }
	r.world.tick = 4242

	r.handleDiag(diagToggle{name: "григ", on: true})
	c := &client{id: 1, send: make(chan message, 16)}
	r.handleConnect(c)
	r.handleInput(taggedMessage{from: c, msg: message{"t": "join", "name": "григ", "cls": "sniper"}})
	<-c.send // welcome

	rec := func(kd float64) message {
		return message{"t": "diagrec", "kd": kd, "ku": kd - 1, "kg": 7517.0, "mm": 64.0,
			"mp": 2127.0, "mg": 36990.0, "lk": 1.0, "lg": 2.0, "le": 0.0, "gh": 0.0,
			"fps": 60.0, "held": "KeyW", "ua": "Firefox-test"}
	}
	// непомеченный игрок — игнор
	c2 := &client{id: 2, send: make(chan message, 8)}
	r.handleConnect(c2)
	r.handleInput(taggedMessage{from: c2, msg: message{"t": "join", "name": "чистый", "cls": "assault"}})
	r.handleInput(taggedMessage{from: c2, msg: rec(1)})
	if len(r.world.diagBufs["чистый"]) != 0 {
		t.Fatal("unmarked player's diagrec must be dropped")
	}

	r.handleInput(taggedMessage{from: c, msg: rec(1)}) // первая — прошла
	ticks = ticks.Add(200 * time.Millisecond)
	r.handleInput(taggedMessage{from: c, msg: rec(2)}) // анти-спам <500мс
	if n := len(r.world.diagBufs["григ"]); n != 1 {
		t.Fatalf("anti-spam must drop sub-500ms recs, buffered=%d", n)
	}
	ticks = ticks.Add(600 * time.Millisecond)
	// серверные данные той секунды: движение + wish (wire — числа 0|1, §9.2)
	r.handleInput(taggedMessage{from: c, msg: message{"t": "input", "seq": 1.0,
		"keys": map[string]any{"w": 1.0, "a": 0.0, "s": 0.0, "d": 1.0, "interact": 0.0},
		"yaw": 0.5, "pitch": 0.0}})
	r.handleInput(taggedMessage{from: c, msg: rec(3)})

	// выгрузка
	ch := make(chan any, 1)
	r.handleDiagDump(diagDumpReq{name: "ГРИГ", reply: ch}) // регистронезависимо
	records := (<-ch).([]diagRec)
	if len(records) != 2 {
		t.Fatalf("want 2 buffered recs, got %d", len(records))
	}
	last := records[1]
	if last.T == 0 || last.Tick != 4242 || last.Held != "KeyW" || last.FPS != 60 {
		t.Fatalf("rec carries client counters: %+v", last)
	}
	if last.W != 1 || last.D != 1 || last.A != 0 || last.Yaw != 0.5 {
		t.Fatalf("rec carries server wish/pose of the same second: %+v", last)
	}

	// список имён без name
	ch2 := make(chan any, 1)
	r.handleDiagDump(diagDumpReq{name: "", reply: ch2})
	list := (<-ch2).(map[string]int)
	if list["григ"] != 2 {
		t.Fatalf("name list must report buffer size: %+v", list)
	}
	if _, ok := list["чистый"]; ok {
		t.Fatalf("unmarked name must not appear: %+v", list)
	}
}

// Кольцевость: больше diagMaxRecs не хранится, старое вытесняется.
func TestDiagRingBound(t *testing.T) {
	m := mustParseEmbeddedMap(t)
	r := newRoom(m)
	ticks := time.UnixMilli(1_700_000_000_000)
	r.world.now = func() time.Time { return ticks }
	r.handleDiag(diagToggle{name: "ринг", on: true})
	c := &client{id: 1, send: make(chan message, 8)}
	r.handleConnect(c)
	r.handleInput(taggedMessage{from: c, msg: message{"t": "join", "name": "ринг", "cls": "assault"}})
	for i := 0; i < diagMaxRecs+50; i++ {
		r.handleInput(taggedMessage{from: c, msg: message{"t": "diagrec", "kd": float64(i + 1)}})
		ticks = ticks.Add(1 * time.Second)
	}
	if n := len(r.world.diagBufs["ринг"]); n != diagMaxRecs {
		t.Fatalf("ring bound %d, got %d", diagMaxRecs, n)
	}
	if first := r.world.diagBufs["ринг"][0]; first.KD != 51 {
		t.Fatalf("oldest must be evicted first, first.kd=%v", first.KD)
	}
}
