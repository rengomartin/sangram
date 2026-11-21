package ws

import (
	"encoding/json"
	"math"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"arena/internal/game"
	"arena/internal/room"
)

type PublicCharacter struct {
	Key              string  `json:"key"`
	Name             string  `json:"name"`
	Health           float64 `json:"health"`
	SpeedPercent     int     `json:"speedPercent"`
	Damage           float64 `json:"damage"`
	Range            float64 `json:"range"`
	RangeLabel       string  `json:"rangeLabel"`
	Weapon           string  `json:"weapon"`
	Blurb            string  `json:"blurb"`
	AttackCooldownMs int64   `json:"attackCooldownMs"`
	AttackDurationMs int64   `json:"attackDurationMs"`
}

type PublicConfig struct {
	ServerTime           int64             `json:"serverTime"`
	TickRate             int               `json:"tickRate"`
	SnapshotRate         int               `json:"snapshotRate"`
	BaseSpeed            float64           `json:"baseSpeed"`
	PlayerRadius         float64           `json:"playerRadius"`
	AttackMoveMultiplier float64           `json:"attackMoveMultiplier"`
	BlockMoveMultiplier  float64           `json:"blockMoveMultiplier"`
	ArenaWidth           float64           `json:"arenaWidth"`
	ArenaHeight          float64           `json:"arenaHeight"`
	CountdownMs          int64             `json:"countdownMs"`
	DisconnectGraceMs    int64             `json:"disconnectGraceMs"`
	DodgeCooldownMs      int64             `json:"dodgeCooldownMs"`
	DodgeDurationMs      int64             `json:"dodgeDurationMs"`
	DodgeSpeed           float64           `json:"dodgeSpeed"`
	DodgeInvulnerableMs  int64             `json:"dodgeInvulnerableMs"`
	Characters           []PublicCharacter `json:"characters"`
	ProtocolVersion      int               `json:"protocolVersion"`
}

func PublicConfigFrom(cfg game.Config) PublicConfig {
	chars := make([]PublicCharacter, 0, 4)
	for _, ch := range cfg.CharacterList() {
		label := "Medium"
		switch {
		case ch.Range <= 80:
			label = "Short"
		case ch.Range <= 105:
			label = "Medium"
		default:
			label = "Long"
		}
		chars = append(chars, PublicCharacter{
			Key: ch.Key, Name: ch.Name, Health: ch.Health,
			SpeedPercent: int(math.Round(ch.SpeedMultiplier * 100)),
			Damage:       ch.Damage, Range: ch.Range, RangeLabel: label,
			Weapon: ch.Weapon, Blurb: ch.Blurb,
			AttackCooldownMs: ch.AttackCooldown.Milliseconds(),
			AttackDurationMs: ch.AttackDuration.Milliseconds(),
		})
	}
	return PublicConfig{
		ServerTime: time.Now().UnixMilli(), TickRate: cfg.TickRate,
		SnapshotRate: cfg.SnapshotRate, BaseSpeed: cfg.BaseSpeed,
		PlayerRadius:         cfg.PlayerRadius,
		AttackMoveMultiplier: cfg.AttackMoveMultiplier,
		BlockMoveMultiplier:  cfg.BlockMoveMultiplier,
		ArenaWidth:           cfg.ArenaWidth, ArenaHeight: cfg.ArenaHeight,
		CountdownMs:         cfg.Countdown.Milliseconds(),
		DisconnectGraceMs:   cfg.DisconnectGrace.Milliseconds(),
		DodgeCooldownMs:     cfg.DodgeCooldown.Milliseconds(),
		DodgeDurationMs:     cfg.DodgeDuration.Milliseconds(),
		DodgeSpeed:          cfg.DodgeSpeed,
		DodgeInvulnerableMs: cfg.DodgeInvulnerable.Milliseconds(),
		Characters:          chars, ProtocolVersion: 1,
	}
}

type Handler struct {
	manager   *room.Manager
	cfg       game.Config
	meta      PublicConfig
	upgrader  websocket.Upgrader
	allowed   map[string]struct{}
	pingEvery time.Duration
}

func NewHandler(manager *room.Manager, cfg game.Config, allowedOrigins []string) *Handler {
	allowed := make(map[string]struct{})
	for _, origin := range allowedOrigins {
		origin = strings.TrimRight(strings.TrimSpace(origin), "/")
		if origin != "" {
			allowed[strings.ToLower(origin)] = struct{}{}
		}
	}
	h := &Handler{
		manager: manager, cfg: cfg, meta: PublicConfigFrom(cfg), allowed: allowed,
		pingEvery: cfg.SocketPingInterval,
	}
	if h.pingEvery <= 0 {
		h.pingEvery = 20 * time.Second
	}
	h.upgrader = websocket.Upgrader{
		ReadBufferSize: 4096, WriteBufferSize: 32 * 1024,
		CheckOrigin: h.checkOrigin,
	}
	return h
}

func (h *Handler) checkOrigin(r *http.Request) bool {
	origin := strings.TrimSpace(r.Header.Get("Origin"))
	if origin == "" {
		return true
	}
	if _, ok := h.allowed[strings.ToLower(origin)]; ok {
		return true
	}
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	return strings.EqualFold(u.Host, r.Host)
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	conn, err := h.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	c := &Client{
		conn: conn, id: newConnID(), send: make(chan []byte, 256),
		done: make(chan struct{}), manager: h.manager, cfg: h.cfg,
		meta: h.meta, pingEvery: h.pingEvery,
		limiter: newLimiter(120, 90),
	}
	conn.SetReadLimit(16 * 1024)
	_ = conn.SetReadDeadline(time.Now().Add(75 * time.Second))
	conn.SetPongHandler(func(string) error {
		return conn.SetReadDeadline(time.Now().Add(75 * time.Second))
	})
	c.SendJSON(&helloMessage{
		Type: "hello", ServerTime: time.Now().UnixMilli(), Config: h.meta,
	})
	go c.writeLoop()
	go c.readLoop()
}

type Client struct {
	conn *websocket.Conn
	id   string

	send      chan []byte
	done      chan struct{}
	closeOnce sync.Once

	manager   *room.Manager
	cfg       game.Config
	meta      PublicConfig
	pingEvery time.Duration
	limiter   *limiter

	// Only the read loop mutates the room binding.
	room      *room.Room
	playerID  string
	playerTok string
}

func (c *Client) ID() string { return c.id }

func (c *Client) SendJSON(v any) bool {
	data, err := json.Marshal(v)
	if err != nil {
		return false
	}
	select {
	case <-c.done:
		return false
	default:
	}
	select {
	case c.send <- data:
		return true
	case <-c.done:
		return false
	default:
		// A stalled peer must not block the simulation. Closing lets the
		// reconnect/grace flow take over.
		go c.Close()
		return false
	}
}

func (c *Client) Close() {
	c.closeOnce.Do(func() {
		close(c.done)
		_ = c.conn.Close()
	})
}

func (c *Client) writeLoop() {
	ticker := time.NewTicker(c.pingEvery)
	defer ticker.Stop()
	defer c.Close()
	for {
		select {
		case <-c.done:
			return
		case data := <-c.send:
			_ = c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := c.conn.WriteMessage(websocket.TextMessage, data); err != nil {
				return
			}
		case <-ticker.C:
			_ = c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

func (c *Client) readLoop() {
	defer func() {
		if c.room != nil {
			c.room.Disconnect(c.playerID, c.id)
		}
		c.Close()
	}()
	for {
		typ, data, err := c.conn.ReadMessage()
		if err != nil {
			return
		}
		if typ != websocket.TextMessage {
			c.sendError("bad_message", "Only JSON text messages are accepted.")
			continue
		}
		if !c.limiter.allow(time.Now()) {
			c.sendError("rate_limited", "Too many messages. Slow down.")
			c.Close()
			return
		}
		_ = c.conn.SetReadDeadline(time.Now().Add(75 * time.Second))
		if len(data) > 16*1024 {
			c.sendError("message_too_large", "Message too large.")
			return
		}
		c.handleMessage(data)
	}
}

type inboundMessage struct {
	Type      string  `json:"type"`
	Nickname  string  `json:"nickname"`
	RoomCode  string  `json:"roomCode"`
	Token     string  `json:"token"`
	Character string  `json:"character"`
	Confirmed *bool   `json:"confirmed"`
	Ready     *bool   `json:"ready"`
	Accept    *bool   `json:"accept"`
	Seq       uint64  `json:"seq"`
	MX        float64 `json:"mx"`
	MY        float64 `json:"my"`
	Block     bool    `json:"block"`
	AttackSeq uint64  `json:"attackSeq"`
	DodgeSeq  uint64  `json:"dodgeSeq"`
	T         int64   `json:"t"`
}

type errorMessage struct {
	Type    string `json:"type"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

type pongMessage struct {
	Type       string `json:"type"`
	T          int64  `json:"t"`
	ServerTime int64  `json:"serverTime"`
}

type helloMessage struct {
	Type       string       `json:"type"`
	ServerTime int64        `json:"serverTime"`
	Config     PublicConfig `json:"config"`
}

type welcomeMessage struct {
	Type     string         `json:"type"`
	PlayerID string         `json:"playerId"`
	Token    string         `json:"token"`
	Room     *room.RoomView `json:"room"`
	Config   PublicConfig   `json:"config"`
}

func (c *Client) handleMessage(data []byte) {
	var msg inboundMessage
	if err := json.Unmarshal(data, &msg); err != nil {
		c.sendError("bad_json", "Malformed message.")
		return
	}
	msg.Type = strings.ToLower(strings.TrimSpace(msg.Type))
	if msg.Type == "" {
		c.sendError("bad_message", "Message type is required.")
		return
	}

	switch msg.Type {
	case "ping":
		c.SendJSON(&pongMessage{Type: "pong", T: msg.T, ServerTime: time.Now().UnixMilli()})
		return
	case "heartbeat":
		if c.room != nil {
			c.room.Touch(c.playerID, c.id)
		}
		c.SendJSON(&pongMessage{Type: "pong", T: msg.T, ServerTime: time.Now().UnixMilli()})
		return
	}

	if c.room == nil {
		c.handleEntry(msg)
		return
	}

	switch msg.Type {
	case "input":
		if msg.MX < -1 || msg.MX > 1 || msg.MY < -1 || msg.MY > 1 {
			return
		}
		c.room.SubmitInput(c.playerID, c.id, game.Input{
			Seq: msg.Seq, MX: msg.MX, MY: msg.MY, Block: msg.Block,
			AttackSeq: msg.AttackSeq, DodgeSeq: msg.DodgeSeq,
		})
	case "select":
		if err := c.room.SelectCharacter(c.playerID, c.id, strings.ToLower(msg.Character)); err != nil {
			c.sendRoomError(err)
		}
	case "confirm":
		if msg.Confirmed == nil {
			c.sendError("bad_message", "Confirmed flag required.")
			return
		}
		if err := c.room.ConfirmCharacter(c.playerID, c.id, *msg.Confirmed); err != nil {
			c.sendRoomError(err)
		}
	case "ready":
		if msg.Ready == nil {
			c.sendError("bad_message", "Ready flag required.")
			return
		}
		if err := c.room.SetReady(c.playerID, c.id, *msg.Ready); err != nil {
			c.sendRoomError(err)
		}
	case "rematch":
		if msg.Accept == nil {
			c.sendError("bad_message", "Accept flag required.")
			return
		}
		if err := c.room.Rematch(c.playerID, c.id, *msg.Accept); err != nil {
			c.sendRoomError(err)
		}
	case "lobby":
		if err := c.room.ReturnToLobby(c.playerID, c.id); err != nil {
			c.sendRoomError(err)
		}
	case "leave":
		if err := c.room.Leave(c.playerID, c.id); err != nil {
			c.sendRoomError(err)
			return
		}
		c.room = nil
		c.playerID = ""
		c.playerTok = ""
		c.SendJSON(&leftMessage{Type: "left"})
	case "create", "join", "reconnect":
		c.sendError("already_in_room", "Leave your current arena first.")
	default:
		c.sendError("unknown_type", "Unknown message type.")
	}
}

func (c *Client) handleEntry(msg inboundMessage) {
	switch msg.Type {
	case "create":
		r, p, err := c.manager.Create(msg.Nickname, c)
		if err != nil {
			c.sendRoomError(err)
			return
		}
		c.bind(r, p)
		c.SendJSON(&welcomeMessage{
			Type: "welcome", PlayerID: p.ID, Token: p.Token,
			Room: r.RoomViewFor(p.ID), Config: c.meta,
		})
		r.BroadcastRoom()
	case "join":
		r, p, err := c.manager.Join(msg.RoomCode, msg.Nickname, c)
		if err != nil {
			c.sendRoomError(err)
			return
		}
		c.bind(r, p)
		c.SendJSON(&welcomeMessage{
			Type: "welcome", PlayerID: p.ID, Token: p.Token,
			Room: r.RoomViewFor(p.ID), Config: c.meta,
		})
		r.BroadcastRoom()
	case "reconnect":
		r, p, err := c.manager.Reconnect(msg.RoomCode, msg.Token, c)
		if err != nil {
			c.sendRoomError(err)
			return
		}
		c.bind(r, p)
		c.SendJSON(&welcomeMessage{
			Type: "welcome", PlayerID: p.ID, Token: p.Token,
			Room: r.RoomViewFor(p.ID), Config: c.meta,
		})
		r.BroadcastRoom()
		r.SendStateTo(p.ID)
	default:
		c.sendError("not_in_room", "Create or join an arena first.")
	}
}

func (c *Client) bind(r *room.Room, p *room.Player) {
	c.room = r
	c.playerID = p.ID
	c.playerTok = p.Token
}

func (c *Client) sendRoomError(err error) {
	if e, ok := room.IsRoomError(err); ok {
		c.sendError(e.Code, e.Message)
		return
	}
	c.sendError("server_error", "The arena could not complete that action.")
}

func (c *Client) sendError(code, message string) {
	c.SendJSON(&errorMessage{Type: "error", Code: code, Message: message})
}

type leftMessage struct {
	Type string `json:"type"`
}

type limiter struct {
	mu       sync.Mutex
	capacity float64
	rate     float64
	tokens   float64
	last     time.Time
	denied   int
}

func newLimiter(ratePerSecond, burst float64) *limiter {
	return &limiter{capacity: burst, rate: ratePerSecond, tokens: burst, last: time.Now()}
}

func (l *limiter) allow(now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if !l.last.IsZero() {
		l.tokens += now.Sub(l.last).Seconds() * l.rate
		if l.tokens > l.capacity {
			l.tokens = l.capacity
		}
	}
	l.last = now
	if l.tokens >= 1 {
		l.tokens--
		l.denied = 0
		return true
	}
	l.denied++
	return false
}
