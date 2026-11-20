package main

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"math"
	"strconv"
)

//go:embed map/h2dm1.json
var h2dm1JSON []byte

// collider — AABB-бокс геометрии карты. kind: floor | wall | stair
// (stair — ступень высотой <=0.5, взбираемся autostep'ом).
type collider struct {
	Min  [3]float64 `json:"min"`
	Max  [3]float64 `json:"max"`
	Kind string     `json:"kind"`
}

type gameMap struct {
	// deviceBoxes — корпуса устройств как препятствия (строит buildCyber,
	// проверяет staticBlocked/doorBlocker): сеть и физика обязаны сойтись.
	deviceBoxes []aabb

	// dynamic — коллайдеры, двигающиеся каждый тик (платформы лифтов,
	// §16.12): applyPhysics приземляет игроков на них, как на пол.
	// Пишет liftTick до движения игроков.
	dynamic []collider
	Name        string                  `json:"name"`
	Bounds      [3]float64              `json:"bounds"`
	Colliders   []collider              `json:"colliders"`
	Spawns      map[string][][3]float64 `json:"spawns"` // "0"/"1" → точки спавна (у ног)
	Props       []any                   `json:"props"`  // сырые M2-пропсы (§12.3)

	// props — типизированные пропсы (заполняет parseProps до validate,
	// чтобы validate проверял связи door.to / cable.from-to).
	props []mapProp
}

// mapProp — один проп карты (§12.3). Поля используются по kind: кабель —
// ребро сети from→to с полилинией points (без точек — прямой сегмент между
// устройствами, удобно для мини-карт в тестах); дверь — size [w,h,depth] и
// axis (ось панели, для рендера клиента), to — switch «коротким кабелем».
type mapProp struct {
	Kind   string       `json:"kind"`
	ID     string       `json:"id"`
	Pos    [3]float64   `json:"pos"`
	Radius float64      `json:"radius"` // radio
	Size   [3]float64   `json:"size"`   // door, gas (§14.2), fire (§14.6.1)
	Axis   string       `json:"axis"`   // door
	To     string       `json:"to"`     // door|gas|valve → switch; fire → valve
	From   string       `json:"from"`   // cable
	Points [][3]float64 `json:"points"` // cable
	BW     float64      `json:"bw"`     // cable: пропускная способность, МБ/с (§16.3; 0 → дефолт по kind)
	// Backplane — switch: суммарная шина транзита, МБ/с (§16.3; 0 → дефолт).
	Backplane float64 `json:"backplane"`
	// Locked — door: код-замок (§16.7, d3). Только код с клавиатуры.
	Locked bool `json:"locked"`
}

// parseGameMap — парсинг + валидация: карта встроенная, ошибка означает
// сломанный билд, поэтому вызывается один раз на старте.
func parseGameMap(data []byte) (*gameMap, error) {
	var m gameMap
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, err
	}
	if err := m.parseProps(); err != nil {
		return nil, err
	}
	if err := m.validate(); err != nil {
		return nil, err
	}
	return &m, nil
}

// parseProps — типизация сырых пропсов: kind известен, id непуст и уникален.
func (m *gameMap) parseProps() error {
	ids := map[string]bool{}
	for i, raw := range m.Props {
		b, err := json.Marshal(raw)
		if err != nil {
			return fmt.Errorf("map: prop %d: %w", i, err)
		}
		var p mapProp
		if err := json.Unmarshal(b, &p); err != nil {
			return fmt.Errorf("map: prop %d: %w", i, err)
		}
		switch p.Kind {
		case "terminal", "radio", "switch", "door", "gas", "fire", "valve", "camera", "cable", "srv", "keypad", "safe", "physafe", "lift", "liftbtn":
		default:
			return fmt.Errorf("map: prop %d: unknown kind %q", i, p.Kind)
		}
		if p.ID == "" || ids[p.ID] {
			return fmt.Errorf("map: prop %d: empty or duplicate id %q", i, p.ID)
		}
		ids[p.ID] = true
		m.props = append(m.props, p)
	}
	return nil
}

func (m *gameMap) validate() error {
	if m.Name == "" {
		return fmt.Errorf("map: empty name")
	}
	for i, b := range m.Bounds {
		if !(b > 0) || math.IsNaN(b) {
			return fmt.Errorf("map: bad bounds[%d]=%v", i, b)
		}
	}
	if len(m.Colliders) == 0 {
		return fmt.Errorf("map: no colliders")
	}
	for i, c := range m.Colliders {
		for ax := 0; ax < 3; ax++ {
			if !(c.Min[ax] < c.Max[ax]) || math.IsNaN(c.Min[ax]) || math.IsNaN(c.Max[ax]) {
				return fmt.Errorf("map: collider %d bad on axis %d: %v..%v", i, ax, c.Min[ax], c.Max[ax])
			}
		}
	}
	for _, team := range []string{"0", "1"} {
		if len(m.Spawns[team]) == 0 {
			return fmt.Errorf("map: no spawns for team %s", team)
		}
		for i, s := range m.Spawns[team] {
			for ax := 0; ax < 3; ax++ {
				if s[ax] < 0 || s[ax] > m.Bounds[ax] {
					return fmt.Errorf("map: spawn %s[%d] out of bounds", team, i)
				}
			}
		}
	}
	stairs := 0
	for _, c := range m.Colliders {
		if c.Kind == "stair" {
			stairs++
			if c.Max[1]-c.Min[1] > 0.5+1e-9 {
				return fmt.Errorf("map: stair %v higher than 0.5 (autostep is 0.55)", c)
			}
		}
	}
	if stairs == 0 {
		return fmt.Errorf("map: no stairs — second floor unreachable")
	}
	return m.validateProps()
}

// validateProps — связи M2-пропсов (§12.3): дверь ссылается на switch,
// кабель — на устройства (не на другие кабели), размеры двери осмысленны.
func (m *gameMap) validateProps() error {
	kinds := map[string]string{} // id → kind
	for _, p := range m.props {
		kinds[p.ID] = p.Kind
	}
	for _, p := range m.props {
		switch p.Kind {
		case "terminal", "radio", "switch", "camera": // §13.7: камера — точечное устройство в bounds
			for ax := 0; ax < 3; ax++ {
				if math.IsNaN(p.Pos[ax]) || p.Pos[ax] < 0 || p.Pos[ax] > m.Bounds[ax] {
					return fmt.Errorf("map: prop %s pos out of bounds: %v", p.ID, p.Pos)
				}
			}
		case "door":
			for ax := 0; ax < 3; ax++ {
				if !(p.Size[ax] > 0) || math.IsNaN(p.Size[ax]) {
					return fmt.Errorf("map: door %s bad size %v", p.ID, p.Size)
				}
			}
			if p.Axis != "x" && p.Axis != "z" {
				return fmt.Errorf("map: door %s axis must be \"x\"|\"z\", got %q", p.ID, p.Axis)
			}
			if kinds[p.To] != "switch" {
				return fmt.Errorf("map: door %s must reference a switch via \"to\", got %q", p.ID, p.To)
			}
		case "gas":
			// §14.2: газовая ловушка — объём-ловушка: size [w,h,d] обязателен,
			// to → switch (клапан — сетевое устройство, как дверь). Axis не
			// нужен: ориентация объёма не влияет ни на что на сервере.
			for ax := 0; ax < 3; ax++ {
				if !(p.Size[ax] > 0) || math.IsNaN(p.Size[ax]) {
					return fmt.Errorf("map: gas %s bad size %v", p.ID, p.Size)
				}
			}
			if kinds[p.To] != "switch" {
				return fmt.Errorf("map: gas %s must reference a switch via \"to\", got %q", p.ID, p.To)
			}
		case "valve":
			// §14.6.1: водяной клапан — сетевой контроллер огня, механика
			// газа: to → switch, кабель — отдельный проп (как у двери/газа).
			// Size не нужен — device-проп.
			if kinds[p.To] != "switch" {
				return fmt.Errorf("map: valve %s must reference a switch via \"to\", got %q", p.ID, p.To)
			}
		case "fire":
			// §14.6.1 (ревизия v1): огонь — стихия, не устройство: size
			// обязателен; `to` → существующий клапан (его water open тушит
			// пул); `from` и кабель к огню запрещены (не сетевой конец).
			for ax := 0; ax < 3; ax++ {
				if !(p.Size[ax] > 0) || math.IsNaN(p.Size[ax]) {
					return fmt.Errorf("map: fire %s bad size %v", p.ID, p.Size)
				}
			}
			if p.From != "" {
				return fmt.Errorf("map: fire %s is not a network device: from must be absent", p.ID)
			}
			if kinds[p.To] != "valve" {
				return fmt.Errorf("map: fire %s must reference a valve via \"to\", got %q", p.ID, p.To)
			}
		case "cable":
			// §14.6.1: огонь не устройство — ребро к/от него недопустимо
			// (иначе buildCyber схлопнется на nil при «прямом сегменте»).
			if p.From == p.To || kinds[p.From] == "" || kinds[p.To] == "" ||
				kinds[p.From] == "cable" || kinds[p.To] == "cable" ||
				kinds[p.From] == "fire" || kinds[p.To] == "fire" {
				return fmt.Errorf("map: cable %s bad endpoints %q..%q", p.ID, p.From, p.To)
			}
		}
	}
	return nil
}

// teamSpawns — точки спавна команды (0/1); пусто быть не может (validate).
func (m *gameMap) teamSpawns(team int) [][3]float64 {
	return m.Spawns[strconv.Itoa(team)]
}
