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

// Bir bağlantı bu süre boyunca PING göndermezse (telefon kilitlendi, bağlantı koptu) listeden düşer
const STALE_MS = 75000;
const SWEEP_MS = 30000;

const VALID_THEMES = [
  "dark", "orange", "gold", "light", "stage", "grey", "amber", "red",
  "rose", "green", "cyan", "indigo", "violet", "ocean", "sunset", "mint", "midnight"
];

const ALLOWED_AI_ACTIONS = new Set([
  "UPDATE_REPERTOIRE",
  "ADD_TO_REPERTOIRE",
  "DELETE_FROM_REPERTOIRE",
  "RESTORE_MASTER_VAULT",
  "SEAL_MASTER_VAULT",
  "CREATE_SETLIST",
  "UPDATE_SETLIST",
  "DELETE_SETLIST",
  "STAGE_SELECT_SONG",
  "STAGE_OPEN",
  "STAGE_CLOSE",
  "STAGE_KICK_MEMBER",
  "UPDATE_SETTINGS"
]);

const AI_ACTION_ALIASES = {
  UPDATE_LIBRARY: "UPDATE_REPERTOIRE",
  ADD_TO_LIBRARY: "ADD_TO_REPERTOIRE"
};

function countLibrarySongs(libraries) {
  if (!libraries || typeof libraries !== "object") return 0;
  let total = 0;
  for (const lib of Object.values(libraries)) {
    if (lib && Array.isArray(lib.songs)) total += lib.songs.length;
  }
  return total;
}

/**
 * Silinen setlistlerin geri gelmemesi için yedekleri birleştirir.
 * Silme kayıtları (deletedSetlists: { id: silinmeZamanı }) hiçbir cihazın yedeğiyle kaybolmaz;
 * eski bir cihaz silinmiş setlisti içeren yedeğini gönderse bile o setlist yedeğe yazılmaz.
 * Bilerek geri yüklenen (restoredAt silinme zamanından yeni olan) setlistler korunur.
 */
function mergeSetlistDeletions(existing, incoming) {
  const tombs = {};
  for (const src of [existing && existing.deletedSetlists, incoming && incoming.deletedSetlists]) {
    if (!src || typeof src !== "object") continue;
    for (const [id, t] of Object.entries(src)) {
      const ts = Number(t) || 0;
      if (ts > (tombs[id] || 0)) tombs[id] = ts;
    }
  }

  if (!incoming || incoming.setlists == null) {
    return { ...(incoming || {}), deletedSetlists: tombs };
  }

  let incomingSetlists = incoming.setlists;
  if (Array.isArray(incomingSetlists)) {
    incomingSetlists = Object.fromEntries(incomingSetlists.filter((s) => s && s.id).map((s) => [s.id, s]));
  }

  const setlists = {};
  for (const [id, sl] of Object.entries(incomingSetlists || {})) {
    const tomb = tombs[id];
    if (tomb) {
      const restoredAt = Number(sl && sl.restoredAt) || 0;
      if (restoredAt <= tomb) continue; // silinmiş: geri getirme
      delete tombs[id]; // bilerek geri yüklenmiş
    }
    setlists[id] = sl;
  }

  return { ...incoming, setlists, deletedSetlists: tombs };
}

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
      message: "Oda yönetici tarafından kapatıldı",
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

  async saveBackup(data) {
    const existing = await this.ctx.storage.get("user_backup");
    const existingCount = countLibrarySongs(existing && existing.libraries);
    const incomingCount = countLibrarySongs(data && data.libraries);
    if (!(data && data.force) && existingCount >= 50 && incomingCount < existingCount - 20) {
      return {
        success: false,
        blocked: true,
        status: 409,
        error: "Senkron düşüş kalkanı: Repertuar tek seferde 20'den fazla şarkı azaldığı için otomatik kayıt engellendi.",
        existingCount,
        incomingCount,
      };
    }

    const cleanData = data ? { ...data } : {};
    delete cleanData.force;
    const merged = mergeSetlistDeletions(existing, cleanData);
    await this.ctx.storage.put("user_backup", merged);
    return {
      success: true,
      timestamp: Date.now(),
      count: incomingCount,
      deletedSetlists: merged.deletedSetlists,
    };
  }

  async getBackup() {
    const data = await this.ctx.storage.get("user_backup");
    return data || null;
  }

  async getVaultMeta() {
    const v = await this.ctx.storage.get("master_vault");
    if (!v || (!v.current && !v.origin)) {
      return { exists: false, origin: null, current: null, history: [] };
    }
    const metaOf = (s) => (s ? { count: s.count || 0, sealedAt: s.sealedAt || 0, label: s.label || "" } : null);
    return {
      exists: true,
      origin: metaOf(v.origin),
      current: metaOf(v.current || v.origin),
      history: Array.isArray(v.history) ? v.history.map((h, i) => ({ index: i, ...metaOf(h) })) : [],
    };
  }

  async sealVault({ confirm, libraries, label, seedOrigin } = {}) {
    if (confirm !== true) {
      return { success: false, status: 400, error: "Ana Kasa mühürlemek için açık onay (confirm: true) gereklidir." };
    }
    let libs = libraries;
    if (!libs || countLibrarySongs(libs) === 0) {
      const existing = await this.ctx.storage.get("user_backup");
      libs = existing && existing.libraries;
    }
    const count = countLibrarySongs(libs);
    if (!libs || count === 0) {
      return { success: false, status: 400, error: "Ana Kasa'ya mühürlenecek şarkı bulunamadı." };
    }

    const vault = (await this.ctx.storage.get("master_vault")) || { origin: null, current: null, history: [] };
    const snap = {
      libraries: JSON.parse(JSON.stringify(libs)),
      count,
      sealedAt: Date.now(),
      label: String(label || `Mühürlü Ana Kasa (${count})`).trim(),
    };
    if (!vault.origin || seedOrigin === true) {
      vault.origin = JSON.parse(JSON.stringify(snap));
    }
    if (vault.current && countLibrarySongs(vault.current.libraries) > 0) {
      const prev = Array.isArray(vault.history) ? vault.history : [];
      vault.history = [vault.current, ...prev].slice(0, 5);
    }
    vault.current = snap;
    await this.ctx.storage.put("master_vault", vault);
    return { success: true, vault: await this.getVaultMeta() };
  }

  async restoreVault({ target = "current" } = {}) {
    const vault = await this.ctx.storage.get("master_vault");
    if (!vault || (!vault.current && !vault.origin)) {
      return { success: false, status: 404, error: "Ana Kasa kaydı bulunamadı." };
    }
    let snap = null;
    if (target === "origin") {
      snap = vault.origin || vault.current;
    } else if (typeof target === "number" && Number.isInteger(target) && Array.isArray(vault.history) && vault.history[target]) {
      snap = vault.history[target];
    } else {
      snap = vault.current || vault.origin;
    }
    if (!snap || !snap.libraries) {
      return { success: false, status: 404, error: "Seçilen Ana Kasa sürümü bulunamadı." };
    }

    const restoredLibs = JSON.parse(JSON.stringify(snap.libraries));
    const existing = (await this.ctx.storage.get("user_backup")) || {};
    const now = Date.now();
    const updatedBackup = {
      ...existing,
      libraries: restoredLibs,
      updatedAt: now,
    };
    await this.ctx.storage.put("user_backup", updatedBackup);
    return {
      success: true,
      libraries: restoredLibs,
      count: countLibrarySongs(restoredLibs),
      updatedAt: now,
      label: snap.label || "Ana Kasa",
    };
  }

  getMemberList() {
    const byKey = new Map();
    for (const ws of this.ctx.getWebSockets()) {
      if (typeof ws.readyState === "number" && ws.readyState >= 2) continue;
      const meta = ws.deserializeAttachment() || this.sessions.get(ws);
      if (!meta || !meta.id) continue;
      const key = meta.nameKey || (meta.name || "müzisyen").trim().toLocaleLowerCase("tr-TR");
      const prev = byKey.get(key);
      const metaTime = meta.joinedAt || 0;
      const prevTime = prev ? (prev.joinedAt || 0) : -1;
      if (!prev || metaTime > prevTime || (metaTime === prevTime && meta.isLeader && !prev.isLeader)) {
        byKey.set(key, meta);
      }
    }
    return [...byKey.values()].sort((a, b) => {
      if (a.isLeader !== b.isLeader) return a.isLeader ? -1 : 1;
      return (a.joinedAt || 0) - (b.joinedAt || 0);
    });
  }

  async kickMember(targetId) {
    for (const ws of this.ctx.getWebSockets()) {
      const meta = ws.deserializeAttachment() || this.sessions.get(ws);
      if (meta && meta.id === targetId) {
        try {
          ws.send(JSON.stringify({ type: "KICKED", message: "Yönetici tarafından çıkarıldın" }));
        } catch (e) {}
        try {
          ws.serializeAttachment(null);
        } catch (e) {}
        this.sessions.delete(ws);
        try {
          ws.close(4002, "Removed by leader");
        } catch (e) {}
      }
    }

    const members = this.getMemberList();
    this.broadcast({
      type: "MEMBERS_UPDATE",
      members,
      count: members.length,
    });
    return { success: true, members };
  }

  // Yanıt vermeyen bağlantıları kapat. Bir şey kapatıldıysa true döner.
  pruneStale() {
    const now = Date.now();
    let changed = false;
    for (const ws of this.ctx.getWebSockets()) {
      const meta = this.sessions.get(ws) || ws.deserializeAttachment();
      if (!meta) continue;
      if (now - (meta.lastSeen || meta.joinedAt || 0) > STALE_MS) {
        try { ws.close(1001, "Stale connection"); } catch (e) {}
        this.sessions.delete(ws);
        changed = true;
      }
    }
    return changed;
  }

  // Bağlantının son görülme zamanını güncelle (PING geldiğinde)
  touch(ws) {
    const meta = this.sessions.get(ws) || ws.deserializeAttachment();
    if (!meta) return;
    meta.lastSeen = Date.now();
    this.sessions.set(ws, meta);
    try { ws.serializeAttachment(meta); } catch (e) {}
  }

  async scheduleSweep() {
    if (this.ctx.getWebSockets().length === 0) return;
    const existing = await this.ctx.storage.getAlarm();
    if (!existing) await this.ctx.storage.setAlarm(Date.now() + SWEEP_MS);
  }

  async alarm() {
    if (this.pruneStale()) {
      const members = this.getMemberList();
      this.broadcast({ type: "MEMBERS_UPDATE", members, count: members.length });
    }
    if (this.ctx.getWebSockets().length > 0) {
      await this.ctx.storage.setAlarm(Date.now() + SWEEP_MS);
    }
  }

  broadcast(messageObj, excludeWs = null) {
    const payload = typeof messageObj === "string" ? messageObj : JSON.stringify(messageObj);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === excludeWs) continue;
      if (typeof ws.readyState === "number" && ws.readyState >= 2) continue;
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

      const rawName = (url.searchParams.get("name") || "").trim();
      const cleanName = rawName || "Müzisyen";
      const nameKey = cleanName.toLocaleLowerCase("tr-TR");
      const clientId = (url.searchParams.get("clientId") || "").trim();
      const role = url.searchParams.get("role") || "crew";
      const isLeader = role === "leader" || role === "host";
      const memberId = "m_" + Math.random().toString(36).slice(2, 9);

      // Enforce 1 active socket per device (clientId) and per person (nameKey)
      for (const oldWs of this.ctx.getWebSockets()) {
        const oldMeta = oldWs.deserializeAttachment() || this.sessions.get(oldWs);
        if (!oldMeta) continue;
        const sameClient = Boolean(clientId && oldMeta.clientId && oldMeta.clientId === clientId);
        const samePerson = oldMeta.nameKey
          ? oldMeta.nameKey === nameKey
          : (oldMeta.name || "").trim().toLocaleLowerCase("tr-TR") === nameKey;
        if (sameClient || samePerson) {
          try {
            oldWs.send(JSON.stringify({ type: "REPLACED", message: "Başka bir oturumdan bağlanıldı" }));
          } catch (e) {}
          try {
            oldWs.serializeAttachment(null);
          } catch (e) {}
          this.sessions.delete(oldWs);
          try {
            oldWs.close(4001, "Replaced by newer connection");
          } catch (e) {}
        }
      }

      const meta = {
        id: memberId,
        clientId,
        name: cleanName,
        nameKey,
        role,
        isLeader,
        joinedAt: Date.now(),
        lastSeen: Date.now(),
      };

      // Accept socket via Hibernation API
      this.ctx.acceptWebSocket(server, [role, isLeader ? "leader" : "member"]);
      server.serializeAttachment(meta);
      this.sessions.set(server, meta);

      const members = this.getMemberList();

      // Immediately send current room state to newly connected client
      const initialPayload = {
        type: "INIT",
        room: this.room ? { ...this.room, members } : null,
        self: meta,
      };
      server.send(JSON.stringify(initialPayload));

      // Broadcast updated member list to room
      this.broadcast({
        type: "MEMBERS_UPDATE",
        members,
        count: members.length,
      });
      await this.scheduleSweep();

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

        case "KICK_MEMBER": {
          if (data.memberId) {
            await this.kickMember(data.memberId);
          }
          break;
        }

        case "PING": {
          this.touch(ws);
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
    try {
      ws.serializeAttachment(null);
    } catch (e) {}
    this.sessions.delete(ws);
    try {
      const safeCode = (typeof code === "number" && (code === 1000 || (code >= 3000 && code <= 4999))) ? code : 1000;
      ws.close(safeCode, typeof reason === "string" ? reason : "Closed");
    } catch (e) {}
    if (!meta) return;

    const members = this.getMemberList();
    // Notify room of updated member list
    this.broadcast({
      type: "MEMBERS_UPDATE",
      members,
      count: members.length,
      left: meta.name || null,
    });
  }

  async webSocketError(ws, error) {
    const meta = ws.deserializeAttachment() || this.sessions.get(ws);
    try {
      ws.serializeAttachment(null);
    } catch (e) {}
    this.sessions.delete(ws);
    if (!meta) return;

    const members = this.getMemberList();
    this.broadcast({
      type: "MEMBERS_UPDATE",
      members,
      count: members.length,
      left: meta.name || null,
    });
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

    // Backup / Restore Endpoints: /api/backup?user=...
    if (path === "/api/backup") {
      const userKey = (url.searchParams.get("user") || "default").trim().toLowerCase();
      if (request.method === "POST") {
        try {
          const body = await request.json();
          if (env.ROOMS) {
            const id = env.ROOMS.idFromName("BACKUP_" + userKey);
            const stub = env.ROOMS.get(id);
            const res = await stub.saveBackup(body);
            if (res && res.blocked) {
              return jsonResponse(res, 409);
            }
            return jsonResponse(res);
          } else {
            const existing = memoryRooms.get("BACKUP_" + userKey);
            const existingCount = countLibrarySongs(existing && existing.libraries);
            const incomingCount = countLibrarySongs(body && body.libraries);
            if (!(body && body.force) && existingCount >= 50 && incomingCount < existingCount - 20) {
              return jsonResponse({
                success: false,
                blocked: true,
                status: 409,
                error: "Senkron düşüş kalkanı: Repertuar tek seferde 20'den fazla şarkı azaldığı için otomatik kayıt engellendi.",
                existingCount,
                incomingCount,
              }, 409);
            }
            const cleanBody = body ? { ...body } : {};
            delete cleanBody.force;
            const merged = mergeSetlistDeletions(existing, cleanBody);
            memoryRooms.set("BACKUP_" + userKey, merged);
            return jsonResponse({ success: true, timestamp: Date.now(), count: incomingCount, deletedSetlists: merged.deletedSetlists });
          }
        } catch (err) {
          return jsonResponse({ error: "Yedek kaydedilemedi: " + err.message }, 400);
        }
      }
      if (request.method === "GET") {
        if (env.ROOMS) {
          const id = env.ROOMS.idFromName("BACKUP_" + userKey);
          const stub = env.ROOMS.get(id);
          const data = await stub.getBackup();
          return jsonResponse({ success: true, data: data || null });
        } else {
          const data = memoryRooms.get("BACKUP_" + userKey) || null;
          return jsonResponse({ success: true, data: data });
        }
      }
    }

    // Ana Kasa (Master Vault) Endpoints: /api/vault, /api/vault/seal, /api/vault/restore
    if (path === "/api/vault" || path === "/api/vault/seal" || path === "/api/vault/restore") {
      const userKey = (url.searchParams.get("user") || "master").trim().toLowerCase();
      if (!env.ROOMS) {
        return jsonResponse({ success: false, error: "Durable Objects kullanılamıyor." }, 503);
      }
      const id = env.ROOMS.idFromName("BACKUP_" + userKey);
      const stub = env.ROOMS.get(id);

      if (path === "/api/vault" && request.method === "GET") {
        const vault = await stub.getVaultMeta();
        return jsonResponse({ success: true, vault });
      }
      if (path === "/api/vault/seal" && request.method === "POST") {
        try {
          const body = await request.json();
          const res = await stub.sealVault(body);
          return jsonResponse(res, res.status || (res.success ? 200 : 400));
        } catch (err) {
          return jsonResponse({ success: false, error: "Ana Kasa mühürlenemedi: " + err.message }, 400);
        }
      }
      if (path === "/api/vault/restore" && request.method === "POST") {
        try {
          const body = await request.json().catch(() => ({}));
          const res = await stub.restoreVault(body);
          return jsonResponse(res, res.status || (res.success ? 200 : 400));
        } catch (err) {
          return jsonResponse({ success: false, error: "Ana Kasa geri yüklenemedi: " + err.message }, 400);
        }
      }
      return jsonResponse({ error: "Desteklenmeyen Ana Kasa isteği" }, 405);
    }

    // AI Sahne Direktörü & Asistanı Endpoint: /api/ai/chat
    if (path === "/api/ai/chat" && request.method === "POST") {
      try {
        const body = await request.json();
        const userMessage = (body.message || "").trim();
        const history = Array.isArray(body.history) ? body.history : [];
        const context = body.context || {};
        const apiKey = (body.apiKey && body.apiKey.trim()) || env.GEMINI_API_KEY;

        if (!userMessage) {
          return jsonResponse({ error: "Lütfen bir mesaj yazın veya konuşun." }, 400);
        }

        if (!apiKey) {
          return jsonResponse({
            error: "Gemini API anahtarı bulunamadı. Lütfen sağ üstteki Ayarlar (⚙️) menüsünden Google Gemini API anahtarınızı girin."
          }, 400);
        }

        const rawSongs = context.allSongs || context.librarySongs || [];
        const rawSetlists = context.setlists || [];
        const stageInfo = context.stage || {};
        const vaultInfo = context.vault || {};

        // Eksiksiz ve kompakt Repertuar listesi
        const formattedRepertoire = rawSongs.map((s, i) => {
          const title = s.t || s.title || "İsimsiz";
          const artist = s.a || s.artist ? ` - ${s.a || s.artist}` : "";
          const key = s.k || s.key ? ` (${s.k || s.key})` : "";
          const bpm = s.b || s.bpm ? ` [${s.b || s.bpm} BPM]` : "";
          const noteText = (s.n || s.notes || "").replace(/\s+/g, " ").trim();
          const notes = noteText ? ` {Not: ${noteText.slice(0, 60)}}` : "";
          const hasLink = (s.u || s.link) ? " [Link]" : "";
          return `${i + 1}. ${title}${artist}${key}${bpm}${notes}${hasLink}`;
        }).join("\n");

        // Eksiksiz Setlistler
        const formattedSetlists = rawSetlists.map(sl => {
          const songList = Array.isArray(sl.songs) ? sl.songs.join(", ") : "";
          const idTag = sl.id ? `[id: ${sl.id}] ` : "";
          return `- ${idTag}"${sl.name}" (${(sl.songs || []).length} şarkı)${sl.band ? ' [' + sl.band + ']' : ''}: ${songList || 'Boş'}`;
        }).join("\n");

        // Canlı Sahne durumu
        const stageMembers = Array.isArray(stageInfo.members) ? stageInfo.members : [];
        const membersText = stageMembers.length
          ? stageMembers.map(m => `[id: ${m.id}] ${m.name}${m.isLeader ? " (Yönetici)" : " (Üye)"}`).join(", ")
          : "Bağlı üye yok";
        const formattedStage = `Durum: ${stageInfo.isLive ? "CANLI" : "KAPALI"} | Mod: ${stageInfo.mode || "-"} | Aktif Şarkı: ${stageInfo.activeSongTitle || "Yok"} | Bağlı Üyeler: ${membersText}`;

        // Ana Kasa durumu
        const originMeta = vaultInfo.origin;
        const currentMeta = vaultInfo.current;
        const historyList = Array.isArray(vaultInfo.history) ? vaultInfo.history : [];
        const formattedVault = vaultInfo.exists
          ? `Orijinal: ${originMeta ? originMeta.count + " şarkı" : "Yok"} | Güncel Mühürlü: ${currentMeta ? currentMeta.count + " şarkı" : "Yok"} | Geçmiş: ${historyList.length} sürüm`
          : "Ana Kasa bilgisi henüz okunmadı";

        // Ayarlar durumu
        const formattedSettings = `Yönetici Adı: ${context.username || "Müzisyen"} | Tema: ${context.theme || "dark"} | Grup Anahtarı: ${context.groupKey || "-"} | Geçerli Temalar: ${VALID_THEMES.join(", ")}`;

        const systemInstruction = `Sen GigSync canlı sahne yönetim asistanısın.
Yönetici: ${context.username || "Müzisyen"}.

CANLI REPERTUAR (Toplam ${rawSongs.length} Şarkı):
${formattedRepertoire || "Repertuarda henüz hiç şarkı yok."}

SETLİSTLER (Toplam ${rawSetlists.length} Setlist):
${formattedSetlists || "Henüz hiç setlist yok."}

CANLI SAHNE DURUMU:
${formattedStage}

ANA KASA DURUMU:
${formattedVault}

AYARLAR:
${formattedSettings}

KATI KURALLAR (ASLA İHLAL ETME):
1. KAPALI ALAN KİLİDİ:
- Sen YALNIZCA GigSync (Repertuar, Setlistler, Canlı Sahne, Ana Kasa, Ayarlar) konusunda çalışırsın.
- GigSync dışındaki HERHANGİ BİR İSTEKTE ("araba yap", "yemek tarifi", "kod yaz", "hava durumu", genel bilgi, matematik, sohbet vb.) hiçbir \`gigsync_action\` bloğu ÜRETME ve YALNIZCA şunu yaz:
"Ben sadece GigSync sahne, repertuar ve setlist asistanıyım; bu konuda yardımcı olamam."
2. SIFIR UYDURMA VE DOĞRULAMA:
- Sistemde olmayan bir özelliği, şarkıyı, setlisti veya üyeyi ASLA uydurma; yukarıdaki gerçek listelerde yoksa "bulunamadı" de.
- Kullanıcının "orijinal tonunu yaz / BPM ekle / YouTube linki bul" açık talebi olmadıkça yeni key, bpm, link, notes UYDURMA; boş ("") bırak.
- Repertuar, setlist, Ana Kasa veya ayar değiştiren işlemlerde uygula butonunu kullanıcı onaylar; sadece sahnede şarkı seçme ve sahneyi açma komutları anında uygulanır. Yanıtlarında "butona dokun" gibi gereksiz açıklamalar yazma, kısa ve net ol.
3. YALNIZCA BU 13 RESMİ AKSİYONU KULLAN (yanıtının EN SONUNA tek bir \`\`\`gigsync_action ... \`\`\` bloğu ekle):

(A) REPERTUAR:
1) UPDATE_REPERTOIRE (mevcut şarkının title/artist/key/bpm/notes/link alanlarını düzelt; sıra no listeden aynen alınır; tek yanıtta en fazla 120 kayıt):
\`\`\`gigsync_action
{ "action": "UPDATE_REPERTOIRE", "changes": [{ "no": 12, "key": "Dm", "bpm": "120", "notes": "...", "link": "..." }] }
\`\`\`
2) ADD_TO_REPERTOIRE (yeni şarkı ekle):
\`\`\`gigsync_action
{ "action": "ADD_TO_REPERTOIRE", "songs": [{ "title": "Şarkı Adı", "artist": "Sanatçı", "key": "", "bpm": "", "notes": "", "link": "" }] }
\`\`\`
3) DELETE_FROM_REPERTOIRE (YALNIZCA kullanıcı açıkça şarkı silmek isterse):
\`\`\`gigsync_action
{ "action": "DELETE_FROM_REPERTOIRE", "remove": [57] }
\`\`\`
4) RESTORE_MASTER_VAULT (Ana Kasa'yı Repertuar'a geri yükle; target: "current" | "origin" | 0..4):
\`\`\`gigsync_action
{ "action": "RESTORE_MASTER_VAULT", "target": "origin" }
\`\`\`
5) SEAL_MASTER_VAULT (mevcut Repertuar'ı yeni Ana Kasa sürümü olarak kilitle):
\`\`\`gigsync_action
{ "action": "SEAL_MASTER_VAULT", "label": "Güncel Ana Kasa" }
\`\`\`

(B) SETLİSTLER:
6) CREATE_SETLIST:
\`\`\`gigsync_action
{ "action": "CREATE_SETLIST", "name": "Setlist Adı", "band": "", "songs": [{ "no": 12, "title": "Şarkı Adı", "artist": "Sanatçı", "key": "", "bpm": "", "notes": "", "link": "" }] }
\`\`\`
7) UPDATE_SETLIST (setlistId veya setlistName ile eşle; newName, band, addNos, removeTitles, reorderTitles isteğe bağlı):
\`\`\`gigsync_action
{ "action": "UPDATE_SETLIST", "setlistId": "...", "setlistName": "...", "newName": "...", "band": "...", "addNos": [1, 2], "removeTitles": ["..."], "reorderTitles": ["..."] }
\`\`\`
8) DELETE_SETLIST:
\`\`\`gigsync_action
{ "action": "DELETE_SETLIST", "setlistId": "...", "setlistName": "..." }
\`\`\`

(C) CANLI SAHNE:
9) STAGE_SELECT_SONG (repertuardaki "no" ve/veya "title" ile sahnede şarkıyı hemen aç):
\`\`\`gigsync_action
{ "action": "STAGE_SELECT_SONG", "no": 12, "title": "Şarkı Adı" }
\`\`\`
10) STAGE_OPEN ("quick" veya "setlist" modunda canlı sahneyi aç):
\`\`\`gigsync_action
{ "action": "STAGE_OPEN", "mode": "quick", "setlistId": "...", "setlistName": "..." }
\`\`\`
11) STAGE_CLOSE (canlı sahneyi kapat):
\`\`\`gigsync_action
{ "action": "STAGE_CLOSE" }
\`\`\`
12) STAGE_KICK_MEMBER (bağlı üyeyi çıkar):
\`\`\`gigsync_action
{ "action": "STAGE_KICK_MEMBER", "memberId": "...", "memberName": "..." }
\`\`\`

(D) AYARLAR:
13) UPDATE_SETTINGS (username, geçerli listeden theme, groupKey):
\`\`\`gigsync_action
{ "action": "UPDATE_SETTINGS", "username": "...", "theme": "dark", "groupKey": "..." }
\`\`\``;

        const contents = [];
        // Geçmiş konuşmalar
        for (const item of history.slice(-6)) {
          contents.push({
            role: item.role === "assistant" ? "model" : "user",
            parts: [{ text: item.content }]
          });
        }
        // Güncel kullanıcı mesajı
        contents.push({
          role: "user",
          parts: [{ text: userMessage }]
        });

        // Gemini Modelleri (çalışma önceliğine ve hızına göre sıralı)
        const candidateModels = [
          "gemini-3.1-flash-lite",
          "gemini-3.5-flash",
          "gemini-flash-latest",
          "gemini-pro-latest"
        ];

        let geminiRes = null;
        let lastErrMsg = "";

        for (const model of candidateModels) {
          try {
            const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
            const res = await fetch(geminiUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                systemInstruction: { parts: [{ text: systemInstruction }] },
                contents,
                generationConfig: {
                  temperature: 0.7,
                  maxOutputTokens: 8192,
                  thinkingConfig: { thinkingBudget: 0 }
                }
              })
            });

            if (res.ok) {
              geminiRes = res;
              break;
            } else {
              const errBody = await res.json().catch(() => ({}));
              lastErrMsg = errBody.error?.message || `HTTP ${res.status}`;
              // thinkingConfig hatası ise thinkingConfig olmadan dene
              if (res.status === 400 && lastErrMsg.toLowerCase().includes("thinking")) {
                const retryRes = await fetch(geminiUrl, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    systemInstruction: { parts: [{ text: systemInstruction }] },
                    contents,
                    generationConfig: {
                      temperature: 0.7,
                      maxOutputTokens: 8192
                    }
                  })
                });
                if (retryRes.ok) {
                  geminiRes = retryRes;
                  break;
                }
              }
            }
          } catch (e) {
            lastErrMsg = e.message;
          }
        }

        if (!geminiRes) {
          return jsonResponse({ error: `Gemini API Hatası: ${lastErrMsg || "Yanıt alınamadı."}` }, 400);
        }

        const geminiData = await geminiRes.json();
        const rawText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || "Bir yanıt oluşturulamadı.";

        // gigsync_action bloğunu ayıkla ve beyaz liste ile doğrula
        let action = null;
        let cleanReply = rawText;
        const actionMatch = rawText.match(/```gigsync_action\s*([\s\S]*?)\s*```/);
        if (actionMatch) {
          try {
            const parsed = JSON.parse(actionMatch[1]);
            cleanReply = rawText.replace(/```gigsync_action[\s\S]*?```/, "").trim();
            if (parsed && typeof parsed.action === "string") {
              const rawName = parsed.action.trim();
              const normalizedName = AI_ACTION_ALIASES[rawName] || rawName;
              if (ALLOWED_AI_ACTIONS.has(normalizedName)) {
                parsed.action = normalizedName;
                action = parsed;
              }
            }
          } catch (e) {
            console.warn("Aksiyon bloğu ayrıştırılamadı:", e);
          }
        }

        return jsonResponse({
          success: true,
          reply: cleanReply,
          action: action
        });
      } catch (err) {
        return jsonResponse({ error: "İşlem sırasında sunucu hatası: " + err.message }, 500);
      }
    }

    // REST API Endpoints: /api/room...
    if (path.startsWith("/api/room")) {
      const parts = path.split("/").filter(Boolean); // ['api', 'room', ':code'?, ':action'?, ':subId'?]
      const code = parts[2] ? parts[2].toUpperCase() : null;
      const action = parts[3] || null;
      const subId = parts[4] || null;

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

        // DELETE /api/room/:code/member/:memberId -> Kick member
        if (request.method === "DELETE" && action === "member" && subId) {
          if (env.ROOMS) {
            const id = env.ROOMS.idFromName(code);
            const stub = env.ROOMS.get(id);
            const res = await stub.kickMember(decodeURIComponent(subId));
            return jsonResponse(res);
          } else {
            return jsonResponse({ success: true, members: [] });
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
