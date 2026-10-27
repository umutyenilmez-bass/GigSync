/**
 * GigSync — Cloudflare Worker Live Stage Sync Engine
 * Real-time setlist synchronization with Durable Objects & WebSocket Hibernation.
 * Zero-pause, ultra-low latency (<10ms), auto-reconnect, stage-grade resilience.
 */

import { DurableObject } from "cloudflare:workers";

// CORS Headers
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
};

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders,
      ...extraHeaders,
    },
  });
}

/**
 * SyncRoom — Durable Object representing a single live stage room.
 * Holds active song, setlist, presence, and broadcasts via WebSockets.
 */
export class SyncRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.room = null; // { code, name, band, leader, active_song, songs, createdAt, updatedAt }
    this.sessions = new Map(); // ws -> { id, name, role, isLeader, joinedAt }

    // Restore state from persistent storage when woken up from hibernation
    this.ctx.blockConcurrencyWhile(async () => {
      this.room = (await this.ctx.storage.get("room")) || null;
      // Re-hydrate active sockets that survived hibernation
      for (const ws of this.ctx.getWebSockets()) {
        const meta = ws.deserializeAttachment();
        if (meta) {
          this.sessions.set(ws, meta);
        }
      }
    });
  }

  // --- RPC Methods (callable directly from Worker entrypoint) ---

  async getRoom() {
    if (!this.room) return null;
    return {
      ...this.room,
      members: this.getMemberList(),
    };
  }

  async upsertRoom(data) {
    const code = (data.code || "").toUpperCase();
    const now = Date.now();
    const existing = this.room || {};

    this.room = {
      code,
      name: data.name || existing.name || "Setlist",
      band: data.band || existing.band || "",
      leader: data.leader || existing.leader || "Leader",
      active_song: data.active_song !== undefined ? data.active_song : (existing.active_song || null),
      songs: Array.isArray(data.songs) ? data.songs : (existing.songs || []),
      createdAt: existing.createdAt || now,
      updatedAt: now,
    };

    await this.ctx.storage.put("room", this.room);

    // Broadcast room update if there are connected clients
    this.broadcast({
      type: "ROOM_UPDATED",
      room: this.room,
      timestamp: now,
    });

    return {
      success: true,
      room: {
        ...this.room,
        members: this.getMemberList(),
      },
    };
  }

  async selectSong(songId) {
    if (!this.room) {
      this.room = {
        code: "",
        name: "Setlist",
        band: "",
        leader: "",
        active_song: songId,
        songs: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
    } else {
      this.room.active_song = songId;
      this.room.updatedAt = Date.now();
    }

    await this.ctx.storage.put("room", this.room);

    // Ultra-fast sub-10ms broadcast to all connected band members
    this.broadcast({
      type: "SONG_CHANGED",
      songId: songId,
      timestamp: Date.now(),
    });

    return { success: true, active_song: songId };
  }

  async updateSetlist(songs) {
    if (!this.room) {
      this.room = {
        code: "",
        name: "Setlist",
        band: "",
        leader: "",
        active_song: null,
        songs: Array.isArray(songs) ? songs : [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
    } else {
      this.room.songs = Array.isArray(songs) ? songs : [];
      this.room.updatedAt = Date.now();
    }

    await this.ctx.storage.put("room", this.room);

    this.broadcast({
      type: "SETLIST_UPDATED",
      songs: this.room.songs,
      timestamp: Date.now(),
    });

    return { success: true, count: this.room.songs.length };
  }

  async closeRoom() {
    this.broadcast({
      type: "ROOM_CLOSED",
      message: "Oda lider tarafından kapatıldı",
    });

    // Close all connected sockets
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(1000, "Room closed by leader");
      } catch (e) {}
    }
    this.sessions.clear();

    // Delete room from persistent storage
    await this.ctx.storage.deleteAll();
    this.room = null;

    return { success: true };
  }

  getMemberList() {
    const list = [];
    for (const [, meta] of this.sessions) {
      list.push(meta);
    }
    return list;
  }

  broadcast(messageObj, excludeWs = null) {
    const payload = typeof messageObj === "string" ? messageObj : JSON.stringify(messageObj);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === excludeWs) continue;
      try {
        ws.send(payload);
      } catch (err) {
        // Socket closed or stale
      }
    }
  }

  // --- WebSocket Upgrade & Request Handling inside DO ---

  async fetch(request) {
    const url = new URL(request.url);

    // WebSocket upgrade check
    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      const name = url.searchParams.get("name") || "Müzisyen";
      const role = url.searchParams.get("role") || "crew";
      const isLeader = role === "leader" || role === "host";
      const memberId = "m_" + Math.random().toString(36).slice(2, 9);

      const meta = {
        id: memberId,
        name,
        role,
        isLeader,
        joinedAt: Date.now(),
      };

      // Accept socket via Hibernation API
      this.ctx.acceptWebSocket(server, [role, isLeader ? "leader" : "member"]);
      server.serializeAttachment(meta);
      this.sessions.set(server, meta);

      // Immediately send current room state to newly connected client
      const initialPayload = {
        type: "INIT",
        room: this.room ? { ...this.room, members: this.getMemberList() } : null,
        self: meta,
      };
      server.send(JSON.stringify(initialPayload));

      // Broadcast updated member list to room
      this.broadcast({
        type: "MEMBERS_UPDATE",
        members: this.getMemberList(),
        count: this.sessions.size,
      });

      return new Response(null, {
        status: 101,
        webSocket: client,
        headers: corsHeaders,
      });
    }

    // Direct HTTP request to DO
    if (request.method === "GET") {
      const room = await this.getRoom();
      return jsonResponse(room || { error: "Room not found" }, room ? 200 : 404);
    }

    return new Response("Not found", { status: 404, headers: corsHeaders });
  }

  // --- WebSocket Hibernation Event Handlers ---

  async webSocketMessage(ws, message) {
    try {
      const data = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));

      switch (data.type) {
        case "SELECT_SONG": {
          if (data.songId !== undefined) {
            await this.selectSong(data.songId);
          }
          break;
        }

        case "UPDATE_SETLIST": {
          if (Array.isArray(data.songs)) {
            await this.updateSetlist(data.songs);
          }
          break;
        }

        case "CLOSE_ROOM": {
          await this.closeRoom();
          break;
        }

        case "PING": {
          ws.send(JSON.stringify({ type: "PONG", timestamp: Date.now() }));
          break;
        }

        default:
          break;
      }
    } catch (e) {
      console.error("[SyncRoom] webSocketMessage parse error:", e);
    }
  }

  async webSocketClose(ws, code, reason, wasClean) {
    const meta = ws.deserializeAttachment() || this.sessions.get(ws);
    this.sessions.delete(ws);

    // Notify room of updated member list
    this.broadcast({
      type: "MEMBERS_UPDATE",
      members: this.getMemberList(),
      count: this.sessions.size,
      left: meta ? meta.name : null,
    });
  }

  async webSocketError(ws, error) {
    this.sessions.delete(ws);
  }
}

/**
 * Worker Main Entrypoint Router
 */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // Health check
    if (path === "/api/health") {
      return jsonResponse({
        status: "ok",
        service: "gigsync-cloudflare-worker",
        hasDurableObjects: !!env.ROOMS,
        time: Date.now(),
      });
    }

    // WebSocket Endpoint: /ws?room=CODE&name=NAME&role=ROLE
    if (path === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected Upgrade: websocket", { status: 426, headers: corsHeaders });
      }

      const roomCode = (url.searchParams.get("room") || "").trim().toUpperCase();
      if (!roomCode || roomCode.length < 3) {
        return new Response("Geçersiz veya eksik oda kodu", { status: 400, headers: corsHeaders });
      }

      if (env.ROOMS) {
        const id = env.ROOMS.idFromName(roomCode);
        const stub = env.ROOMS.get(id);
        return stub.fetch(request);
      } else {
        // Fallback if Durable Objects not bound
        return handleStatelessWebSocket(request, roomCode, url);
      }
    }

    // REST API Endpoints: /api/room...
    if (path.startsWith("/api/room")) {
      const parts = path.split("/").filter(Boolean); // ['api', 'room', ':code'?, ':action'?]
      const code = parts[2] ? parts[2].toUpperCase() : null;
      const action = parts[3] || null;

      // POST /api/room -> Create / Upsert room
      if (request.method === "POST" && !code) {
        try {
          const body = await request.json();
          const roomCode = (body.code || "").trim().toUpperCase();
          if (!roomCode || roomCode.length < 3) {
            return jsonResponse({ error: "Oda kodu en az 3 karakter olmalıdır" }, 400);
          }

          if (env.ROOMS) {
            const id = env.ROOMS.idFromName(roomCode);
            const stub = env.ROOMS.get(id);
            const res = await stub.upsertRoom(body);
            return jsonResponse(res);
          } else {
            return jsonResponse(fallbackUpsertRoom(body));
          }
        } catch (err) {
          return jsonResponse({ error: "İstek ayrıştırılamadı: " + err.message }, 400);
        }
      }

      // Room-specific endpoints: /api/room/:code/...
      if (code) {
        // GET /api/room/:code -> Fetch room state
        if (request.method === "GET" && !action) {
          if (env.ROOMS) {
            const id = env.ROOMS.idFromName(code);
            const stub = env.ROOMS.get(id);
            const room = await stub.getRoom();
            if (!room) {
              return jsonResponse({ error: "Oda bulunamadı veya aktif değil" }, 404);
            }
            return jsonResponse({ success: true, room });
          } else {
            const room = fallbackGetRoom(code);
            if (!room) return jsonResponse({ error: "Oda bulunamadı veya aktif değil" }, 404);
            return jsonResponse({ success: true, room });
          }
        }

        // POST /api/room/:code/song -> Select active song
        if (request.method === "POST" && action === "song") {
          const { songId } = await request.json();
          if (env.ROOMS) {
            const id = env.ROOMS.idFromName(code);
            const stub = env.ROOMS.get(id);
            const res = await stub.selectSong(songId);
            return jsonResponse(res);
          } else {
            return jsonResponse(fallbackSelectSong(code, songId));
          }
        }

        // POST /api/room/:code/setlist -> Update setlist songs
        if (request.method === "POST" && action === "setlist") {
          const { songs } = await request.json();
          if (env.ROOMS) {
            const id = env.ROOMS.idFromName(code);
            const stub = env.ROOMS.get(id);
            const res = await stub.updateSetlist(songs);
            return jsonResponse(res);
          } else {
            return jsonResponse(fallbackUpdateSetlist(code, songs));
          }
        }

        // DELETE /api/room/:code -> Close room
        if (request.method === "DELETE" && !action) {
          if (env.ROOMS) {
            const id = env.ROOMS.idFromName(code);
            const stub = env.ROOMS.get(id);
            const res = await stub.closeRoom();
            return jsonResponse(res);
          } else {
            return jsonResponse(fallbackCloseRoom(code));
          }
        }

        // GET /api/room/:code/members -> List members
        if (request.method === "GET" && action === "members") {
          if (env.ROOMS) {
            const id = env.ROOMS.idFromName(code);
            const stub = env.ROOMS.get(id);
            const room = await stub.getRoom();
            return jsonResponse({ members: room ? room.members : [] });
          } else {
            return jsonResponse({ members: [] });
          }
        }
      }
    }

    // Static Assets fallback (if deployed with Cloudflare Workers Assets)
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response(
      "GigSync Cloudflare Worker Live Sync API — Canlı sahne senkron motoru aktif. Ön yüz için GitHub Pages veya Cloudflare Pages kullanabilirsiniz.",
      { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8", ...corsHeaders } }
    );
  },
};

// --------------------------------------------------------------------------
// Stateless / In-Memory Fallback (for environments without Durable Objects)
// --------------------------------------------------------------------------
const memoryRooms = new Map();
const memorySockets = new Map(); // roomCode -> Set<WebSocket>

function fallbackUpsertRoom(body) {
  const code = (body.code || "").toUpperCase();
  const room = {
    code,
    name: body.name || "Setlist",
    band: body.band || "",
    leader: body.leader || "Leader",
    active_song: body.active_song !== undefined ? body.active_song : null,
    songs: body.songs || [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    members: [],
  };
  memoryRooms.set(code, room);
  return { success: true, room };
}

function fallbackGetRoom(code) {
  return memoryRooms.get(code.toUpperCase()) || null;
}

function fallbackSelectSong(code, songId) {
  const room = memoryRooms.get(code.toUpperCase());
  if (room) {
    room.active_song = songId;
    room.updatedAt = Date.now();
    fallbackBroadcast(code, { type: "SONG_CHANGED", songId, timestamp: Date.now() });
  }
  return { success: true, active_song: songId };
}

function fallbackUpdateSetlist(code, songs) {
  const room = memoryRooms.get(code.toUpperCase());
  if (room) {
    room.songs = songs;
    room.updatedAt = Date.now();
    fallbackBroadcast(code, { type: "SETLIST_UPDATED", songs, timestamp: Date.now() });
  }
  return { success: true, count: songs ? songs.length : 0 };
}

function fallbackCloseRoom(code) {
  fallbackBroadcast(code, { type: "ROOM_CLOSED", message: "Oda kapatıldı" });
  memoryRooms.delete(code.toUpperCase());
  const sockets = memorySockets.get(code.toUpperCase());
  if (sockets) {
    for (const ws of sockets) {
      try { ws.close(); } catch (e) {}
    }
    memorySockets.delete(code.toUpperCase());
  }
  return { success: true };
}

function fallbackBroadcast(code, data) {
  const sockets = memorySockets.get(code.toUpperCase());
  if (!sockets) return;
  const payload = JSON.stringify(data);
  for (const ws of sockets) {
    try { ws.send(payload); } catch (e) {}
  }
}

function handleStatelessWebSocket(request, roomCode, url) {
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  server.accept();

  if (!memorySockets.has(roomCode)) {
    memorySockets.set(roomCode, new Set());
  }
  memorySockets.get(roomCode).add(server);

  const room = memoryRooms.get(roomCode);
  const name = url.searchParams.get("name") || "Müzisyen";
  const role = url.searchParams.get("role") || "crew";

  server.send(JSON.stringify({
    type: "INIT",
    room: room || null,
    self: { name, role },
  }));

  server.addEventListener("message", (evt) => {
    try {
      const data = JSON.parse(evt.data);
      if (data.type === "SELECT_SONG") {
        fallbackSelectSong(roomCode, data.songId);
      } else if (data.type === "UPDATE_SETLIST") {
        fallbackUpdateSetlist(roomCode, data.songs);
      } else if (data.type === "CLOSE_ROOM") {
        fallbackCloseRoom(roomCode);
      } else if (data.type === "PING") {
        server.send(JSON.stringify({ type: "PONG" }));
      }
    } catch (e) {}
  });

  server.addEventListener("close", () => {
    const set = memorySockets.get(roomCode);
    if (set) {
      set.delete(server);
      if (set.size === 0) memorySockets.delete(roomCode);
    }
  });

  return new Response(null, { status: 101, webSocket: client, headers: corsHeaders });
}
