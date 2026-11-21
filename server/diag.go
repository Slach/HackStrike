package main

// §15.40: диагностика ввода по нику. Держатель стенда включает оверлей
// ?inputdiag конкретному тестеру без его перезаходов и без URL-магии:
//   GET /api/diag?name=Григорий&on=1|0
// Флаг живёт только в памяти комнаты (инвариант 2: мутирует её горутина),
// слетает на рестарте сервера — это и не нужно переживать перезапуск.
// Эффект двойной: онлайн-игроку с этим именем тут же летит {"t":"diag"}
// (оверлей всплывает/гаснет мгновенно), а каждый НОВЫЙ join под этим именем
// получает welcome.diag=1 — «перегрузись и побегай» работает без команды
// «включи ещё раз».

import (
	"encoding/json"
	"log"
	"net/http"
	"strings"
)

type diagToggle struct {
	name  string
	on    bool
	reply chan bool
}

// handleDiag — переключатель в горутине комнаты (инвариант 2). Возвращает
// итоговое состояние флага; носителю в игре — мгновенный {"t":"diag"}.
func (r *room) handleDiag(cmd diagToggle) bool {
	// канон — нижний регистр: «ГРИГ» и «григ» — один игрок (ник в WS может
	// прийти в другой раскладке, чем дёрнул /api/diag держатель)
	canon := strings.ToLower(sanitizeName(cmd.name))
	if cmd.on {
		r.world.diag[canon] = true
	} else {
		delete(r.world.diag, canon)
	}
	for id, pl := range r.world.players {
		if strings.EqualFold(pl.name, cmd.name) || strings.ToLower(pl.name) == canon {
			pl.diag = cmd.on
			r.world.sendTo(id, message{"t": "diag", "on": boolNum(cmd.on)})
		}
	}
	log.Printf("diag: name=%q on=%v marked=%d", canon, cmd.on, len(r.world.diag))
	return cmd.on
}

func boolNum(b bool) int {
	if b {
		return 1
	}
	return 0
}

// handleDiagGET — HTTP-вход /api/diag: только гет-параметры name и on,
// дальше через канал комнаты (инвариант 2).
func (r *room) handleDiagGET(w http.ResponseWriter, req *http.Request) {
	q := req.URL.Query()
	name := q.Get("name")
	onRaw := q.Get("on")
	if name == "" || (onRaw != "1" && onRaw != "0") {
		http.Error(w, `{"error":"name and on=0|1 required"}`, http.StatusBadRequest)
		return
	}
	reply := make(chan bool, 1)
	select {
	case r.diag <- diagToggle{name: name, on: onRaw == "1", reply: reply}:
	case <-req.Context().Done():
		return
	}
	var nowOn bool
	select {
	case nowOn = <-reply:
	case <-req.Context().Done():
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"name": name, "on": boolNum(nowOn)})
}
