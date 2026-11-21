package room

import (
	"time"

	"arena/internal/game"
)

const (
	PhaseLobby     = "lobby"
	PhaseCountdown = "countdown"
	PhasePlaying   = "playing"
	PhaseEnded     = "ended"
)

// Peer is the minimal connection surface a room needs. Implementations must be
// safe for concurrent use; SendJSON must never block on the socket.
type Peer interface {
	ID() string
	SendJSON(v any) bool
	Close()
}

type Player struct {
	ID       string
	Token    string
	Nickname string
	Slot     int

	Character string
	Confirmed bool
	Ready     bool
	Connected bool
	Rematch   bool

	Peer         Peer
	ConnID       string
	LastSeen     time.Time
	DisconnectAt time.Time
}

type PlayerView struct {
	Slot      int    `json:"slot"`
	Nickname  string `json:"nickname"`
	Character string `json:"character"`
	Confirmed bool   `json:"confirmed"`
	Ready     bool   `json:"ready"`
	Connected bool   `json:"connected"`
	Rematch   bool   `json:"rematch"`
}

// RoomView is the lobby-level state. It is personalised with YourSlot.
type RoomView struct {
	Code        string       `json:"code"`
	Phase       string       `json:"phase"`
	YourSlot    int          `json:"yourSlot"`
	Players     []PlayerView `json:"players"`
	CountdownMs int64        `json:"countdownMs"`
	ServerTime  int64        `json:"serverTime"`
	Winner      int          `json:"winner"`
	EndReason   string       `json:"endReason,omitempty"`
}

// StateView is sent at the snapshot rate during countdown, combat, and result.
type StateView struct {
	Phase       string         `json:"phase"`
	YourSlot    int            `json:"yourSlot"`
	ServerTime  int64          `json:"serverTime"`
	CountdownMs int64          `json:"countdownMs"`
	Paused      bool           `json:"paused"`
	GraceMs     int64          `json:"graceMs"`
	Winner      int            `json:"winner"`
	EndReason   string         `json:"endReason,omitempty"`
	Players     []PlayerView   `json:"players"`
	Match       *game.Snapshot `json:"match,omitempty"`
	Events      []game.Event   `json:"events,omitempty"`
}

// Error is a safe, client-facing protocol error.
type Error struct {
	Code    string
	Message string
}

func (e *Error) Error() string { return e.Message }

func roomErr(code, message string) error { return &Error{Code: code, Message: message} }

func (r *Room) playerViewsLocked() []PlayerView {
	out := make([]PlayerView, 0, 2)
	for _, p := range r.players {
		if p == nil {
			continue
		}
		out = append(out, PlayerView{
			Slot: p.Slot, Nickname: p.Nickname, Character: p.Character,
			Confirmed: p.Confirmed, Ready: p.Ready,
			Connected: p.Connected, Rematch: p.Rematch,
		})
	}
	return out
}

func (r *Room) countdownRemainingMs(now time.Time) int64 {
	if r.phase != PhaseCountdown || r.countdownEnd.IsZero() {
		return 0
	}
	ms := r.countdownEnd.Sub(now).Milliseconds()
	if ms < 0 {
		return 0
	}
	return ms
}

func (r *Room) graceRemainingMs(now time.Time) int64 {
	if r.phase != PhasePlaying || !r.paused {
		return 0
	}
	var earliest time.Time
	for _, p := range r.players {
		if p == nil || p.Connected || p.DisconnectAt.IsZero() {
			continue
		}
		deadline := p.DisconnectAt.Add(r.cfg.DisconnectGrace)
		if earliest.IsZero() || deadline.Before(earliest) {
			earliest = deadline
		}
	}
	if earliest.IsZero() {
		return 0
	}
	ms := earliest.Sub(now).Milliseconds()
	if ms < 0 {
		return 0
	}
	return ms
}

// RoomViewFor returns a personalised lobby snapshot.
func (r *Room) RoomViewFor(playerID string) *RoomView {
	r.mu.Lock()
	defer r.mu.Unlock()
	p := r.playerByIDLocked(playerID)
	if p == nil {
		return nil
	}
	return r.roomViewLocked(p)
}

func (r *Room) roomViewLocked(p *Player) *RoomView {
	now := r.now()
	return &RoomView{
		Code: r.code, Phase: r.phase, YourSlot: p.Slot,
		Players:     r.playerViewsLocked(),
		CountdownMs: r.countdownRemainingMs(now),
		ServerTime:  now.UnixMilli(),
		Winner:      r.winner, EndReason: r.endReason,
	}
}
