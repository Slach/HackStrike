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
