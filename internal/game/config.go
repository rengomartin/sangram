// Package game contains the deterministic, server-authoritative arena simulation.
// It has no knowledge of networking, rooms or browsers.
package game

import "time"

// Config holds every tunable combat and arena value. Keeping these together
// makes balancing possible without hunting through simulation code.
type Config struct {
	ArenaWidth   float64 `json:"arenaWidth"`
	ArenaHeight  float64 `json:"arenaHeight"`
	SpawnInset   float64 `json:"spawnInset"`
	PlayerRadius float64 `json:"playerRadius"`

	TickRate     int     `json:"tickRate"`
	SnapshotRate int     `json:"snapshotRate"`
	BaseSpeed    float64 `json:"baseSpeed"`

	InputTimeout       time.Duration `json:"-"`
	DisconnectGrace    time.Duration `json:"-"`
	HeartbeatTimeout   time.Duration `json:"-"`
	Countdown          time.Duration `json:"-"`
	SocketPingInterval time.Duration `json:"-"`

	AttackArcHalfDegrees  float64 `json:"attackArcHalfDegrees"`
	BlockArcHalfDegrees   float64 `json:"blockArcHalfDegrees"`
	AttackActiveStartFrac float64 `json:"attackActiveStartFrac"`
	AttackActiveEndFrac   float64 `json:"attackActiveEndFrac"`
	AttackMoveMultiplier  float64 `json:"attackMoveMultiplier"`
	BlockMoveMultiplier   float64 `json:"blockMoveMultiplier"`

	DodgeSpeed        float64       `json:"dodgeSpeed"`
	DodgeDuration     time.Duration `json:"-"`
	DodgeInvulnerable time.Duration `json:"-"`
	DodgeCooldown     time.Duration `json:"-"`

	KnockbackSpeed float64       `json:"knockbackSpeed"`
	KnockbackDecay float64       `json:"knockbackDecay"`
	HitStun        time.Duration `json:"hitStun"`

	Characters map[string]Character `json:"characters"`
}

// Character defines a warrior's authoritative combat values.
type Character struct {
	Key             string        `json:"key"`
	Name            string        `json:"name"`
	Health          float64       `json:"health"`
	SpeedMultiplier float64       `json:"speedMultiplier"`
	Damage          float64       `json:"damage"`
	Range           float64       `json:"range"`
	AttackCooldown  time.Duration `json:"-"`
	AttackDuration  time.Duration `json:"-"`
	ArcHalfDegrees  float64       `json:"-"`
	Weapon          string        `json:"weapon"`
	Blurb           string        `json:"blurb"`
}

func seconds(d time.Duration) float64 { return d.Seconds() }

// DefaultConfig is the provisional launch balance. All values are deliberately
// centralised and can be tuned without changing combat code.
func DefaultConfig() Config {
	return Config{
		ArenaWidth:   1800,
		ArenaHeight:  1100,
		SpawnInset:   300,
		PlayerRadius: 27,

		TickRate:     60,
		SnapshotRate: 30,
		BaseSpeed:    230,

		InputTimeout:       750 * time.Millisecond,
		DisconnectGrace:    12 * time.Second,
		HeartbeatTimeout:   8 * time.Second,
		Countdown:          3 * time.Second,
		SocketPingInterval: 20 * time.Second,

		AttackArcHalfDegrees:  58,
		BlockArcHalfDegrees:   82,
		AttackActiveStartFrac: 0.20,
		AttackActiveEndFrac:   0.64,
		AttackMoveMultiplier:  0.52,
		BlockMoveMultiplier:   0.32,

		DodgeSpeed:        760,
		DodgeDuration:     160 * time.Millisecond,
		DodgeInvulnerable: 175 * time.Millisecond,
		DodgeCooldown:     1150 * time.Millisecond,

		KnockbackSpeed: 300,
		KnockbackDecay: 8.5,
		HitStun:        130 * time.Millisecond,

		Characters: map[string]Character{
			"knight": {
				Key: "knight", Name: "Knight", Health: 100, SpeedMultiplier: 1.00,
				Damage: 15, Range: 88, AttackCooldown: 500 * time.Millisecond,
				AttackDuration: 340 * time.Millisecond, ArcHalfDegrees: 58,
				Weapon: "Sword & Shield", Blurb: "Steady steel. A balanced blade and a wall of oak.",
			},
			"berserker": {
				Key: "berserker", Name: "Berserker", Health: 100, SpeedMultiplier: 0.85,
				Damage: 25, Range: 74, AttackCooldown: 760 * time.Millisecond,
				AttackDuration: 440 * time.Millisecond, ArcHalfDegrees: 51,
				Weapon: "Heavy Axe", Blurb: "Slow feet, ruinous blows. One clean hit changes everything.",
			},
			"duelist": {
				Key: "duelist", Name: "Duelist", Health: 100, SpeedMultiplier: 1.20,
				Damage: 10, Range: 78, AttackCooldown: 300 * time.Millisecond,
				AttackDuration: 255 * time.Millisecond, ArcHalfDegrees: 53,
				Weapon: "Twin Swords", Blurb: "A blur of green and steel. Strike often, strike first.",
			},
			"guardian": {
				Key: "guardian", Name: "Guardian", Health: 100, SpeedMultiplier: 0.90,
				Damage: 15, Range: 124, AttackCooldown: 650 * time.Millisecond,
				AttackDuration: 395 * time.Millisecond, ArcHalfDegrees: 43,
				Weapon: "Longsword", Blurb: "A long reach and patient guard. Control the space.",
			},
		},
	}
}

// CharacterList returns characters in stable UI order.
func (c Config) CharacterList() []Character {
	keys := []string{"knight", "berserker", "duelist", "guardian"}
	out := make([]Character, 0, len(keys))
	for _, key := range keys {
		if ch, ok := c.Characters[key]; ok {
			out = append(out, ch)
		}
	}
	return out
}

// Character resolves a character key, defaulting to the Knight.
func (c Config) Character(key string) Character {
	if ch, ok := c.Characters[key]; ok {
		return ch
	}
	return c.Characters["knight"]
}

// CharacterValues exposes second-based values for protocol snapshots.
func (c Config) CharacterValues(key string) (cooldown, duration float64) {
	ch := c.Character(key)
	return seconds(ch.AttackCooldown), seconds(ch.AttackDuration)
}

func (c Config) tickDuration() float64 { return 1 / float64(c.TickRate) }
func (c Config) snapshotEvery() int {
	rate := c.SnapshotRate
	if rate < 1 {
		rate = 30
	}
	if rate > c.TickRate {
		rate = c.TickRate
	}
	return c.TickRate / rate
}
func (c Config) attackDuration(ch Character) float64 { return seconds(ch.AttackDuration) }
func (c Config) attackCooldown(ch Character) float64 { return seconds(ch.AttackCooldown) }
func (c Config) dodgeDuration() float64              { return seconds(c.DodgeDuration) }
func (c Config) dodgeCooldown() float64              { return seconds(c.DodgeCooldown) }
func (c Config) dodgeInvulnerable() float64          { return seconds(c.DodgeInvulnerable) }
func (c Config) hitStun() float64                    { return seconds(c.HitStun) }
