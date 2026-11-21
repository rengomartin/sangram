package room

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"arena/internal/game"
)

type Manager struct {
	mu    sync.Mutex
	cfg   game.Config
	rooms map[string]*Room
}

func NewManager(cfg game.Config) *Manager {
	m := &Manager{cfg: cfg, rooms: make(map[string]*Room)}
	go m.sweep()
	return m
}

func (m *Manager) Config() game.Config { return m.cfg }

func (m *Manager) Create(nickname string, peer Peer) (*Room, *Player, error) {
	nick, err := CleanNickname(nickname)
	if err != nil {
		return nil, nil, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	var code string
	for attempts := 0; attempts < 20; attempts++ {
		code = randomRoomCode()
		if _, exists := m.rooms[code]; !exists {
			break
		}
		code = ""
	}
	if code == "" {
		return nil, nil, roomErr("server_busy", "Could not reserve an arena. Try again.")
	}
	r := newRoom(m.cfg, code, time.Now)
	p, err := r.AddPlayer(nick, peer)
	if err != nil {
		return nil, nil, err
	}
	m.rooms[code] = r
	go r.run()
	return r, p, nil
}

func (m *Manager) Join(code, nickname string, peer Peer) (*Room, *Player, error) {
	normalized, err := NormalizeRoomCode(code)
	if err != nil {
		return nil, nil, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	r := m.rooms[normalized]
	if r == nil || r.Closed() {
		return nil, nil, roomErr("room_not_found", "No arena was found with that code.")
	}
	p, err := r.AddPlayer(nickname, peer)
	if err != nil {
		return nil, nil, err
	}
	return r, p, nil
}

func (m *Manager) Reconnect(code, token string, peer Peer) (*Room, *Player, error) {
	normalized, err := NormalizeRoomCode(code)
	if err != nil {
		return nil, nil, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	r := m.rooms[normalized]
	if r == nil || r.Closed() {
		return nil, nil, roomErr("room_not_found", "That arena is no longer available.")
	}
	if strings.TrimSpace(token) == "" {
		return nil, nil, roomErr("bad_resume", "A resume token is required.")
	}
	p, err := r.Reconnect(token, peer)
	if err != nil {
		return nil, nil, err
	}
	return r, p, nil
}

// Stats exposes aggregate counts for health checks without leaking room data.
func (m *Manager) Stats() (rooms int, players int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, r := range m.rooms {
		if r.Closed() {
			continue
		}
		rooms++
		view := r.Stats()
		players += view
	}
	return
}

func (m *Manager) sweep() {
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		m.mu.Lock()
		for code, r := range m.rooms {
			if r.Closed() {
				delete(m.rooms, code)
			}
		}
		if len(m.rooms) == 0 {
			// keep map allocated; cheap and avoids nil checks
		}
		m.mu.Unlock()
	}
}

// Stats returns the number of connected players.
func (r *Room) Stats() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	n := 0
	for _, p := range r.players {
		if p != nil && p.Connected {
			n++
		}
	}
	return n
}

const roomAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

func randomRoomCode() string {
	b := make([]byte, 6)
	if _, err := rand.Read(b); err != nil {
		panic(fmt.Sprintf("entropy failure: %v", err))
	}
	for i := range b {
		b[i] = roomAlphabet[int(b[i])%len(roomAlphabet)]
	}
	return string(b)
}

func newPlayerID() string {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		panic(fmt.Sprintf("entropy failure: %v", err))
	}
	return "p_" + hex.EncodeToString(b)
}

func newToken() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(fmt.Sprintf("entropy failure: %v", err))
	}
	return hex.EncodeToString(b)
}

func NormalizeRoomCode(code string) (string, error) {
	code = strings.ToUpper(strings.TrimSpace(code))
	if len(code) != 6 {
		return "", roomErr("invalid_code", "Room codes are six characters.")
	}
	for _, ch := range code {
		if !strings.ContainsRune(roomAlphabet, ch) {
			return "", roomErr("invalid_code", "That room code contains unsupported characters.")
		}
	}
	return code, nil
}

func CleanNickname(nickname string) (string, error) {
	nickname = strings.TrimSpace(nickname)
	if nickname == "" {
		return "", roomErr("nickname_required", "Enter a warrior name first.")
	}
	var b strings.Builder
	lastSpace := false
	count := 0
	for _, r := range nickname {
		if unicode.IsControl(r) {
			continue
		}
		if unicode.IsSpace(r) {
			if b.Len() > 0 && !lastSpace {
				b.WriteRune(' ')
				lastSpace = true
			}
			continue
		}
		if count >= 20 {
			break
		}
		b.WriteRune(r)
		lastSpace = false
		count++
	}
	out := strings.TrimSpace(b.String())
	if out == "" {
		return "", roomErr("nickname_required", "Enter a warrior name first.")
	}
	if utf8.RuneCountInString(out) == 0 {
		return "", roomErr("nickname_required", "Enter a warrior name first.")
	}
	return out, nil
}

func IsRoomError(err error) (*Error, bool) {
	var e *Error
	ok := errors.As(err, &e)
	return e, ok
}
