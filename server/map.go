package main

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"math"
	"strconv"
)

//go:embed map/map1.json
var map1JSON []byte

// collider — AABB-бокс геометрии карты. kind: floor | wall | stair
// (stair — ступень высотой <=0.5, взбираемся autostep'ом).
type collider struct {
	Min  [3]float64 `json:"min"`
	Max  [3]float64 `json:"max"`
	Kind string     `json:"kind"`
}

type gameMap struct {
	Name      string                  `json:"name"`
	Bounds    [3]float64              `json:"bounds"`
	Colliders []collider              `json:"colliders"`
	Spawns    map[string][][3]float64 `json:"spawns"` // "0"/"1" → точки спавна (у ног)
	Props     []any                   `json:"props"`
}

// parseGameMap — парсинг + валидация: карта встроенная, ошибка означает
// сломанный билд, поэтому вызывается один раз на старте.
func parseGameMap(data []byte) (*gameMap, error) {
	var m gameMap
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, err
	}
	if err := m.validate(); err != nil {
		return nil, err
	}
	return &m, nil
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
	return nil
}

// teamSpawns — точки спавна команды (0/1); пусто быть не может (validate).
func (m *gameMap) teamSpawns(team int) [][3]float64 {
	return m.Spawns[strconv.Itoa(team)]
}
