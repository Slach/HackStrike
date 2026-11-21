package main

// §15.40: диагностика ввода по нику — без скриншотов и без URL-магии на
// стороне тестера. Схема из трёх ходов:
//   1. держатель стенда:  GET /api/diag?name=Григорий&on=1
//      → онлайн-носителю мгновенно {"t":"diag"} (оверлей/отправка стартует),
//      и каждый новый join под этим ником получает welcome.diag=1;
//   2. клиент с флагом раз в секунду шлёт {"t":"diagrec",...счётчики...};
//      сервер (только эта горутина — инвариант 2) дописывает СВОИ данные той
//      же секунды (tick, pos, yaw, wish-клавиши, hp, jacked) и кладёт в
//      кольцевой буфер ника — переживает F5/ресезсию;
//   3. держатель:  GET /api/diagdump?name=Григорий — JSON массив старых→новых;
//      GET /api/diagdump — список имён. Буферы в памяти, слетают на рестарте.
// Всё together: тестеру говорят «побегай и покрути мышкой», данные сам
// вытягиваешь; по записям сразу видно, где рвётся цепочка клавиатура→экран.

import (
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"time"
)

const (
	diagMaxRecs = 900            // 15 мин при 1 Гц на ник
	diagMinGap  = 500 * time.Millisecond // анти-спам: чаще полгерца не копим
)

// diagRec — одна секунда наблюдения: клиентские первичные счётчики +
// серверная правда этой же секунды. Ключи JSON — короткие, дамп читается.
type diagRec struct {
	T     int64   `json:"t"`     // unix ms серверных часов
	Tick  uint64  `json:"tick"`
	Name  string  `json:"name"`
	KD    float64 `json:"kd"` // keydown кумулятивно у клиента
	KU    float64 `json:"ku"`
	KGap  float64 `json:"kg"` // макс. пауза между keydown, мс
	MM    float64 `json:"mm"` // mousemove под lock кумулятивно
	MP    float64 `json:"mp"` // суммарный |movementX|+|movementY|
	MMGap float64 `json:"mg"`
	LK    float64 `json:"lk"` // pointerlock lost
	LG    float64 `json:"lg"` // gained
	LE    float64 `json:"le"` // error
	GH    float64 `json:"gh"` // ghost: «отпустил не сам»
	FPS   float64 `json:"fps"`
	Held  string  `json:"held"` // что зажато у клиента (KeyW,KeyD…)
	UA    string  `json:"ua"`
	// серверная часть — чем и отличается «не дошло» от «сервер принял, но
	// отдача картинки дёргается»
	W  int `json:"w"` // последний wish-ввод сервера (0|1)
	A  int `json:"a"`
	S  int `json:"s"`
	D  int `json:"d"`
	X  float64 `json:"x"`
	Z  float64 `json:"z"`
	Y  float64 `json:"y"`
	Yaw float64 `json:"yaw"`
	HP  int     `json:"hp"`
	Jacked bool `json:"jacked,omitempty"`
}

type diagToggle struct {
	name  string
	on    bool
	reply chan bool
}

// handleDiag — переключатель в горутине комнаты. Возвращает итоговое
// состояние флага; носителю в игре — мгновенный {"t":"diag"}.
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

func b2i(b bool) int {
	if b {
		return 1
	}
	return 0
}

func boolNum(b bool) int {
	if b {
		return 1
	}
	return 0
}

// handleDiagRec — приём одной секунды от помеченного клиента (вызывается из
// world.handleMessage, то есть уже в горутине комнаты).
func (w *world) handleDiagRec(pl *player, msg message) {
	if !pl.diag {
		return // флаг мог только что сняться — не копим от «выключенных»
	}
	now := w.now()
	if !pl.diagLastAt.IsZero() && now.Sub(pl.diagLastAt) < diagMinGap {
		return // anti-spam: быстрее 2 Гц не копить
	}
	pl.diagLastAt = now
	rec := diagRec{
		T: now.UnixMilli(), Tick: w.tick, Name: pl.name,
		KD: num(msg, "kd"), KU: num(msg, "ku"), KGap: num(msg, "kg"),
		MM: num(msg, "mm"), MP: num(msg, "mp"), MMGap: num(msg, "mg"),
		LK: num(msg, "lk"), LG: num(msg, "lg"), LE: num(msg, "le"),
		GH: num(msg, "gh"), FPS: num(msg, "fps"),
		Held: str(msg, "held"), UA: str(msg, "ua"),
		W: b2i(pl.keys.w), A: b2i(pl.keys.a), S: b2i(pl.keys.s), D: b2i(pl.keys.d),
		X: pl.pos[0], Z: pl.pos[2], Y: pl.pos[1], Yaw: pl.yaw,
		HP: pl.hp, Jacked: pl.jacked,
	}
	if len(rec.UA) > 80 {
		rec.UA = rec.UA[:80] // лог-безопасность: UA чужая строка, режем
	}
	if len(rec.Held) > 64 {
		rec.Held = rec.Held[:64]
	}
	canon := strings.ToLower(pl.name) // как в mark: суффикс -2 — другой буфер
	buf := w.diagBufs[canon]
	buf = append(buf, rec)
	if len(buf) > diagMaxRecs {
		buf = buf[len(buf)-diagMaxRecs:] // кольцевой: oldest in, newest out
	}
	w.diagBufs[canon] = buf
}

// handleDiagGET — HTTP-вход /api/diag: query name и on, дальше через канал
// комнаты (инвариант 2).
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

// handleDiagDumpGET — HTTP-выгрузка /api/diagdump[?name=X]. Без имени —
// список имён и размерами буферов; с именем — массив записей старых→новых.
// Инвариант 2: данные читаются ТОЛЬКО в горутине комнаты — запрос идёт через
// канал diagDump, ответ сериализует уже HTTP-горутина из полученной копии.
func (r *room) handleDiagDumpGET(w http.ResponseWriter, req *http.Request) {
	name := req.URL.Query().Get("name")
	reply := make(chan any, 1)
	select {
	case r.diagDump <- diagDumpReq{name: name, reply: reply}:
	case <-req.Context().Done():
		return
	}
	var out any
	select {
	case out = <-reply:
	case <-req.Context().Done():
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(out)
}

type diagDumpReq struct {
	name  string // "" = список имён
	reply chan any
}

// handleDiagDump — в горутине комнаты: копия буфера/списка, без mutex.
func (r *room) handleDiagDump(q diagDumpReq) {
	if q.name == "" {
		list := map[string]int{}
		for name, buf := range r.world.diagBufs {
			list[name] = len(buf)
		}
		q.reply <- list
		return
	}
	canon := strings.ToLower(sanitizeName(q.name))
	buf := r.world.diagBufs[canon]
	cp := make([]diagRec, len(buf)) // копия: вызывающая горутина сериализует
	copy(cp, buf)
	q.reply <- cp
}
