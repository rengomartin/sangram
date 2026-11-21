package server

import (
	"encoding/json"
	"io/fs"
	"log"
	"net/http"
	"strings"
	"time"

	"arena/internal/game"
	"arena/internal/room"
	"arena/internal/ws"
	webassets "arena/web"
)

type Server struct {
	cfg     game.Config
	manager *room.Manager
	ws      *ws.Handler
	static  http.Handler
	meta    ws.PublicConfig
	handler http.Handler
}

func New(cfg game.Config, allowedOrigins []string) *Server {
	manager := room.NewManager(cfg)
	wsHandler := ws.NewHandler(manager, cfg, allowedOrigins)
	sub, err := fs.Sub(webassets.FS, ".")
	if err != nil {
		panic(err)
	}
	s := &Server{
		cfg: cfg, manager: manager, ws: wsHandler,
		static: http.FileServer(http.FS(sub)),
		meta:   ws.PublicConfigFrom(cfg),
	}
	mux := http.NewServeMux()
	mux.Handle("/ws", wsHandler)
	mux.HandleFunc("/api/config", s.apiConfig)
	mux.HandleFunc("/api/health", s.apiHealth)
	mux.HandleFunc("/", s.serveStatic)
	s.handler = securityHeaders(mux)
	return s
}

func (s *Server) Handler() http.Handler { return s.handler }

func (s *Server) apiConfig(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	s.meta.ServerTime = time.Now().UnixMilli()
	_ = json.NewEncoder(w).Encode(s.meta)
}

func (s *Server) apiHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	rooms, players := s.manager.Stats()
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"status": "ok", "rooms": rooms, "players": players,
		"serverTime": time.Now().UnixMilli(),
	})
}

func (s *Server) serveStatic(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	path := strings.TrimPrefix(r.URL.Path, "/")
	if path == "" {
		path = "index.html"
	}
	if strings.Contains(path, "..") {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", contentType(path))
	if path == "index.html" {
		w.Header().Set("Cache-Control", "no-store")
	} else {
		w.Header().Set("Cache-Control", "public, max-age=3600")
	}
	s.static.ServeHTTP(w, r)
}

func contentType(path string) string {
	switch {
	case strings.HasSuffix(path, ".html"):
		return "text/html; charset=utf-8"
	case strings.HasSuffix(path, ".css"):
		return "text/css; charset=utf-8"
	case strings.HasSuffix(path, ".js"):
		return "text/javascript; charset=utf-8"
	case strings.HasSuffix(path, ".svg"):
		return "image/svg+xml"
	case strings.HasSuffix(path, ".woff2"):
		return "font/woff2"
	case strings.HasSuffix(path, ".png"):
		return "image/png"
	default:
		return "application/octet-stream"
	}
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
		w.Header().Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		next.ServeHTTP(w, r)
	})
}

func (s *Server) LogConfig() {
	log.Printf("arena %vx%v, %d Hz simulation, %d Hz snapshots, 2-player rooms",
		s.cfg.ArenaWidth, s.cfg.ArenaHeight, s.cfg.TickRate, s.cfg.SnapshotRate)
}
