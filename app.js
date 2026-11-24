/* GHOST — Private Live Location Sharing (file:// & HTTPS compatible) */
const SUPABASE_CFG = {
  url: "https://pgdwsngrcnvjupvuaxjr.supabase.co",
  anonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBnZHdzbmdyY252anVwdnVheGpyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE2MTgwODUsImV4cCI6MjEwNzE5NDA4NX0.99BFfWCW_R3pjp2MWDBp0j4ZjX7t_jO4IA_0G2rUA1o"
};

const APP_CFG = {
  appName: "GHOST",
  mapTilesUrl: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  mapTilesFallbackUrl: "https://a.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png",
  mapAttribution: "&copy; OpenStreetMap contributors",
  reverseGeocodeUrl: "https://nominatim.openstreetmap.org/reverse",
  routingBaseUrl: "https://router.project-osrm.org/route/v1",
  locationThrottleMs: 4000,
  minMoveMetersForSync: 8,
  heartbeatSyncMs: 12000,
  geocodeMinMoveMeters: 40,
  geocodeThrottleMs: 45000,
  routeRecalcMeters: 35,
  routeThrottleMs: 15000,
  staleThresholdMs: 35000,
  viewerPollIntervalMs: 5000,
  poorAccuracyMeters: 60,
  moderateAccuracyMeters: 20,
  minBootDurationMs: 650
};

const LS_KEYS = { users: "ghost_users_v1", session: "ghost_auth_session_v1", sessions: "ghost_live_sessions_v1", locations: "ghost_live_locations_v1", pwaDismissed: "ghost_pwa_dismissed", supaProfiles: "ghost_supa_profiles_v1" };

const state = {
  supabase: null, configured: false, user: null, profile: null,
  supabaseProfileBlocked: false, supabaseDbBlocked: false, _manualAuthInFlight: false, _authSyncLock: null,
  activeView: "auth", dashboardSubview: "home", authPanel: "login",
  notificationsEnabled: true, isOnline: typeof navigator !== "undefined" ? navigator.onLine : true,
  deferredInstallPrompt: null, confirmAction: null, localBc: null, tickerId: null,
  owner: {
    session: null, sharingPhase: "offline", watchId: null, permissionStatus: "unknown", permissionWatcher: null,
    lastPosition: null, lastSentPosition: null, lastSentAt: 0, lastGeocodeAt: 0, lastGeocodePos: null,
    geoInfo: null, isSyncing: false, pendingPosition: null, channel: null, expirationTimer: null,
    selectedPreset: "until_stopped", map: null
  },
  viewer: {
    token: null, status: "idle", personName: "", targetPos: null, expiresAt: null,
    channel: null, pollTimer: null, watchId: null, selfPos: null, routeMode: "driving",
    lastRouteAt: 0, lastRouteTarget: null, lastRouteSelf: null, routeActive: false, routeMeta: null,
    map: null, _pendingRouteRequest: false
  },
  admin: { stats: null, users: [] }
};

// ============================================================================
// 1. DOM & PURE HELPERS
// ============================================================================
const $ = (id) => document.getElementById(id);
const txt = (id, v) => { const el = $(id); if (el) el.textContent = v; };
const hide = (id, cond) => { const el = $(id); if (el) el.classList.toggle("hidden", Boolean(cond)); };
const on = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };

function isSupabaseConfigured() {
  const url = String(SUPABASE_CFG.url || "").trim();
  const key = String(SUPABASE_CFG.anonKey || "").trim();
  return Boolean(url && key && !url.includes("PASTE_YOUR_") && !key.includes("PASTE_YOUR_") && /^https:\/\/.+/.test(url) && key.length > 20);
}

function safePushUrl(urlString) { try { window.history.pushState({}, "", urlString); } catch {} }
function readStorage(key, fallback) { try { const r = window.localStorage.getItem(key); return r ? JSON.parse(r) : fallback; } catch { return fallback; } }
function writeStorage(key, val) { try { window.localStorage.setItem(key, JSON.stringify(val)); } catch {} }
function syntheticEmail(u) { return u.includes("@") ? u.toLowerCase() : `u_${u.toLowerCase()}@ghost-auth.app`; }
function getDisplayUsername(p) { return (p && (p.username || p.display_name)) || "User"; }

function isDbPermissionOrSchemaError(err) {
  if (!err) return false;
  const code = String(err.code || "");
  const msg = String(err.message || err.details || "").toLowerCase();
  return code === "42501" || code === "42P01" || code === "42883" || code === "PGRST205" || code === "PGRST202" ||
    msg.includes("permission denied") || msg.includes("does not exist") || msg.includes("could not find the table") || msg.includes("could not find the function");
}

function deriveUsernameFromAuthUser(user) {
  const meta = user?.user_metadata?.username || user?.user_metadata?.display_name;
  if (meta && String(meta).trim()) return String(meta).trim();
  const email = String(user?.email || "");
  const m = email.match(/^u_([a-z0-9_]+)@ghost-auth\.app$/i);
  if (m) return m[1];
  if (email.includes("@")) return email.split("@")[0].replace(/[^A-Za-z0-9_]/g, "_") || "User";
  return "User";
}

function readSupabaseProfileCache(userId) {
  const map = readStorage(LS_KEYS.supaProfiles, {});
  return (userId && map[userId]) || null;
}

function writeSupabaseProfileCache(userId, patch) {
  if (!userId || !patch) return;
  const map = readStorage(LS_KEYS.supaProfiles, {});
  map[userId] = { ...(map[userId] || {}), ...patch };
  writeStorage(LS_KEYS.supaProfiles, map);
}

function buildFallbackProfile(user) {
  if (!user?.id) return null;
  const uname = deriveUsernameFromAuthUser(user);
  const cached = readSupabaseProfileCache(user.id) || {};
  const lower = String(cached.username || uname).toLowerCase();
  return {
    id: user.id,
    username: cached.username || uname,
    display_name: cached.display_name || cached.username || uname,
    role: cached.role || user?.app_metadata?.role || user?.user_metadata?.role || (lower === "admin" || lower === "ghostadmin" ? "admin" : "user"),
    account_status: cached.account_status || "active",
    default_expiration: cached.default_expiration || "until_stopped",
    notifications_enabled: cached.notifications_enabled !== false,
    location_permission_status: cached.location_permission_status || "unknown",
    permission_updated_at: cached.permission_updated_at || user.created_at || new Date().toISOString(),
    created_at: user.created_at || new Date().toISOString(),
    last_seen_at: new Date().toISOString()
  };
}

function validateUsername(raw) {
  const c = String(raw || "").trim();
  if (!c) return { ok: false, value: "", error: "Please enter your username." };
  if (c.length < 4) return { ok: false, value: c, error: "Your username must contain at least 4 characters." };
  if (c.length > 24 || !/^[A-Za-z0-9_]+$/.test(c)) return { ok: false, value: c, error: "Username must be 4–24 characters using only letters, numbers, or underscores." };
  return { ok: true, value: c, error: null };
}

function validateRegistrationFields(uRaw, pwd, confirmPwd) {
  const u = validateUsername(uRaw);
  if (!u.ok) return { ok: false, error: u.error };
  if (!pwd) return { ok: false, error: "Please enter your password." };
  if (pwd.length < 6) return { ok: false, error: "Your password must contain at least 6 characters." };
  if (pwd !== confirmPwd) return { ok: false, error: "Your passwords do not match." };
  return { ok: true, username: u.value, password: pwd };
}

function generateSecureToken(len = 24) {
  const bytes = new Uint8Array(len);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < len; i++) bytes[i] = Math.floor(Math.random() * 256);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function hashPassword(password, salt) {
  const input = `${salt}:${password}`;
  if (globalThis.crypto?.subtle && globalThis.TextEncoder) {
    try {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
      return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
    } catch {}
  }
  let h1 = 0x811c9dc5, h2 = 0xdeadbeef;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 0x01000193);
    h2 = Math.imul(h2 ^ ch, 0x85ebca6b);
  }
  return `${(h1 >>> 0).toString(16).padStart(8, "0")}${(h2 >>> 0).toString(16).padStart(8, "0")}`;
}

function extractLiveTokenFromInput(raw) {
  const t = String(raw || "").trim();
  if (!t) return null;
  try {
    if (/^(https?|file):\/\//i.test(t)) {
      const p = new URL(t);
      const q = p.searchParams.get("live");
      if (q && q.trim().length >= 24) return q.trim();
      const m = p.pathname.match(/\/live\/([A-Za-z0-9_-]{24,})/);
      if (m) return m[1];
    }
  } catch {}
  const qm = t.match(/[?&]live=([A-Za-z0-9_-]{24,})/);
  if (qm) return qm[1];
  return /^[A-Za-z0-9_-]{24,}$/.test(t) ? t : null;
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const r = (d) => (d * Math.PI) / 180;
  const a = Math.sin(r(lat2 - lat1) / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lon2 - lon1) / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function formatDistance(m) { return !Number.isFinite(m) || m < 0 ? "Distance unavailable" : m < 1000 ? `${Math.round(m)} m away` : `${(m / 1000).toFixed(1)} km away`; }
function formatRouteDistance(m) { return !Number.isFinite(m) || m < 0 ? "" : m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`; }

function formatDuration(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "";
  const mins = Math.max(1, Math.round(sec / 60));
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60), rem = mins % 60;
  return rem > 0 ? `${h} hr ${rem} min` : `${h} hr`;
}

function formatSharingDuration(startedIso) {
  const ms = startedIso ? Date.parse(startedIso) : NaN;
  if (!Number.isFinite(ms)) return "00:00";
  const sec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const p = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}h ${p(m)}m` : `${p(m)}:${p(s)}`;
}

function formatAccuracy(m) {
  if (!Number.isFinite(m) || m < 0) return "Unavailable";
  const r = Math.round(m);
  return r <= APP_CFG.moderateAccuracyMeters ? `±${r} m (Excellent)` : r <= APP_CFG.poorAccuracyMeters ? `±${r} m (Moderate)` : `±${r} m (Low)`;
}

function formatRelativeTime(isoOrMs) {
  if (!isoOrMs) return "Never";
  const ts = typeof isoOrMs === "number" ? isoOrMs : Date.parse(isoOrMs);
  if (!Number.isFinite(ts)) return "Unknown";
  const ds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (ds < 3) return "Just now";
  if (ds < 60) return `${ds}s ago`;
  const dm = Math.floor(ds / 60);
  if (dm < 60) return dm === 1 ? "1 min ago" : `${dm} min ago`;
  const dh = Math.floor(dm / 60);
  if (dh < 24) return dh === 1 ? "1 hr ago" : `${dh} hr ago`;
  const days = Math.floor(dh / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

function formatMemberDate(iso) {
  const ts = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ts) ? new Date(ts).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "—";
}

function formatExpirationText(expiresIso) {
  if (!expiresIso) return "Until stopped";
  const expMs = Date.parse(expiresIso);
  if (!Number.isFinite(expMs)) return "Until stopped";
  const diff = expMs - Date.now();
  if (diff <= 0) return "Expired";
  const mins = Math.ceil(diff / 60000);
  if (mins < 60) return `In ${mins} min`;
  const h = Math.floor(mins / 60), rem = mins % 60;
  return rem > 0 ? `In ${h}h ${rem}m` : `In ${h}h`;
}

function computeExpirationIso(preset) {
  const now = Date.now();
  const map = { "1h": 3600000, "6h": 21600000, "24h": 86400000 };
  return map[preset] ? new Date(now + map[preset]).toISOString() : null;
}

function buildShareUrl(token) {
  try {
    const u = new URL(window.location.href);
    u.search = ""; u.hash = ""; u.searchParams.set("live", token);
    return u.toString();
  } catch { return `?live=${encodeURIComponent(token)}`; }
}

function formatGeocodeDisplay(geo) {
  if (!geo) return { primary: "Approximate area unavailable", secondary: "" };
  const primary = geo.location_label || geo.area_name || geo.city || geo.state || geo.country || "Approximate area unavailable";
  const parts = [];
  if (geo.area_name && geo.area_name !== primary) parts.push(geo.area_name);
  if (geo.city && geo.city !== primary) parts.push(geo.city);
  if (geo.state && geo.state !== primary && geo.state !== geo.city) parts.push(geo.state);
  if (geo.country && parts.length < 2) parts.push(geo.country);
  return { primary, secondary: parts.join(", ") };
}

function escapeHtml(v) { const d = document.createElement("div"); d.textContent = v == null ? "" : String(v); return d.innerHTML; }

// ============================================================================
// 2. NOTIFICATIONS & MODALS
// ============================================================================
const TOAST_ICONS = {
  success: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m9 12 2 2 4-4"/></svg>`,
  error: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`,
  warning: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
  info: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`
};
const TOAST_TITLES = { success: "Success", error: "Attention", warning: "Notice", info: "GHOST" };

function showNotification(message, variant = "info", title = null, force = false) {
  if (!force && !state.notificationsEnabled && variant === "info") return;
  const region = $("toast-region");
  if (!region) return;
  while (region.children.length >= 3) region.firstElementChild.remove();

  const item = document.createElement("div");
  item.className = `toast-item is-${variant}`;
  item.setAttribute("role", variant === "error" ? "alert" : "status");
  item.innerHTML = `<div class="toast-icon-wrap" aria-hidden="true">${TOAST_ICONS[variant] || TOAST_ICONS.info}</div><div class="toast-body"><div class="toast-heading"></div><div class="toast-message"></div></div><button type="button" class="toast-close-btn" aria-label="Dismiss notification"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>`;
  item.querySelector(".toast-heading").textContent = title || TOAST_TITLES[variant] || "GHOST";
  item.querySelector(".toast-message").textContent = message;

  const dismiss = () => {
    if (!item.parentNode || item.classList.contains("is-leaving")) return;
    item.classList.add("is-leaving");
    window.setTimeout(() => item.remove(), 200);
  };
  item.querySelector(".toast-close-btn").addEventListener("click", dismiss);
  region.appendChild(item);
  window.setTimeout(dismiss, 4500);
}

function openModal(id) {
  const m = $(id);
  if (!m) return;
  m.classList.remove("hidden");
  m.querySelector("input, select, button:not([data-close-modal])")?.focus();
}

function closeModal(id) {
  hide(id, true);
  if (id === "modal-confirm") state.confirmAction = null;
}

function openConfirmModal({ title, message, confirmLabel = "Confirm", onConfirm }) {
  txt("confirm-modal-title", title);
  txt("confirm-modal-message", message);
  txt("confirm-modal-ok-btn", confirmLabel);
  state.confirmAction = onConfirm;
  openModal("modal-confirm");
}

// ============================================================================
// 3. LOCAL & SUPABASE DATA ADAPTER
// ============================================================================
function emitLocalBroadcast(event, payload) {
  if (state.localBc) try { state.localBc.postMessage({ event, payload }); } catch {}
}

const LocalStore = {
  users: () => readStorage(LS_KEYS.users, []),
  saveUsers: (v) => writeStorage(LS_KEYS.users, v),
  sessions: () => readStorage(LS_KEYS.sessions, []),
  saveSessions: (v) => writeStorage(LS_KEYS.sessions, v),
  locations: () => readStorage(LS_KEYS.locations, {}),
  saveLocations: (v) => writeStorage(LS_KEYS.locations, v),

  async getSession() {
    const s = readStorage(LS_KEYS.session, null);
    if (!s?.userId) return null;
    const u = this.users().find((x) => x.id === s.userId);
    return u ? { user: { id: u.id } } : null;
  },

  async register(username, password) {
    const users = this.users();
    const lower = username.toLowerCase();
    if (users.some((u) => u.username.toLowerCase() === lower)) throw new Error("This username is already taken.");
    const salt = generateSecureToken(12), passwordHash = await hashPassword(password, salt), now = new Date().toISOString();
    const user = {
      id: `local_${generateSecureToken(12)}`, username, display_name: username,
      role: users.length === 0 || lower === "admin" || lower === "ghostadmin" ? "admin" : "user",
      account_status: "active", default_expiration: "until_stopped", notifications_enabled: true,
      location_permission_status: "unknown", permission_updated_at: now, created_at: now, last_seen_at: now, salt, passwordHash
    };
    users.push(user); this.saveUsers(users); writeStorage(LS_KEYS.session, { userId: user.id });
    return { user: { id: user.id } };
  },

  async login(username, password) {
    const users = this.users();
    const u = users.find((x) => x.username.toLowerCase() === username.toLowerCase());
    if (!u || (await hashPassword(password, u.salt)) !== u.passwordHash) throw new Error("Incorrect username or password.");
    if (u.account_status === "disabled") throw new Error("This account has been disabled by an administrator.");
    u.last_seen_at = new Date().toISOString(); this.saveUsers(users); writeStorage(LS_KEYS.session, { userId: u.id });
    return { user: { id: u.id } };
  },

  signOut() { try { window.localStorage.removeItem(LS_KEYS.session); } catch {} },

  getProfile(userId) {
    const u = this.users().find((x) => x.id === userId);
    if (!u) throw new Error("Account profile not found.");
    const { passwordHash: _p, salt: _s, ...pub } = u;
    return pub;
  },

  updateProfile(userId, patch) {
    const users = this.users(), idx = users.findIndex((u) => u.id === userId);
    if (idx === -1) throw new Error("Profile not found.");
    if (patch.username && users.some((u, i) => i !== idx && u.username.toLowerCase() === patch.username.toLowerCase())) {
      throw new Error("This username is already taken.");
    }
    users[idx] = { ...users[idx], ...patch }; this.saveUsers(users);
    const { passwordHash: _p, salt: _s, ...pub } = users[idx];
    return pub;
  },

  getActiveOwnerSession(userId) {
    return this.sessions().filter((s) => s.user_id === userId && s.is_active).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0] || null;
  },

  createLiveSession(userId, preset) {
    const now = new Date().toISOString();
    const list = this.sessions().map((s) => (s.user_id === userId && s.is_active ? { ...s, is_active: false, status: "stopped", ended_at: now } : s));
    const created = {
      id: `sess_${generateSecureToken(12)}`, user_id: userId, share_token: generateSecureToken(24),
      is_active: true, status: "active", duration_preset: preset, started_at: now, created_at: now,
      expires_at: computeExpirationIso(preset), last_heartbeat_at: now, device_platform: "web"
    };
    list.push(created); this.saveSessions(list);
    return created;
  },

  stopOwnerSession(userId, sessionId = null) {
    const now = new Date().toISOString();
    let token = null;
    const list = this.sessions().map((s) => {
      if (s.user_id === userId && s.is_active && (!sessionId || s.id === sessionId)) {
        token = s.share_token;
        return { ...s, is_active: false, status: "stopped", ended_at: now };
      }
      return s;
    });
    this.saveSessions(list);
    if (token) emitLocalBroadcast("session_ended", { token, status: "stopped" });
  },

  upsertLocation(session, payload) {
    const locs = this.locations();
    locs[session.id] = payload;
    this.saveLocations(locs);
    this.saveSessions(this.sessions().map((s) => (s.id === session.id ? { ...s, last_heartbeat_at: payload.recorded_at } : s)));
    emitLocalBroadcast("location_update", { token: session.share_token, status: "active", display_name: getDisplayUsername(state.profile), ...payload, expires_at: session.expires_at });
  },

  getSharedLocation(token) {
    const sess = this.sessions().find((s) => s.share_token === token);
    if (!sess) return { status: "invalid" };
    if (sess.expires_at && Date.parse(sess.expires_at) <= Date.now()) return { status: "expired" };
    if (!sess.is_active || sess.status !== "active") return { status: sess.status === "expired" ? "expired" : "stopped" };
    const owner = this.users().find((u) => u.id === sess.user_id) || readSupabaseProfileCache(sess.user_id);
    if (owner?.account_status === "disabled") return { status: "stopped" };
    const loc = this.locations()[sess.id];
    const display_name = getDisplayUsername(owner);
    return loc ? { status: "active", display_name, expires_at: sess.expires_at, ...loc } : { status: "waiting", display_name, expires_at: sess.expires_at };
  },

  adminOverview() {
    const users = this.users(), now = Date.now();
    const active = this.sessions().filter((s) => s.is_active && (!s.expires_at || Date.parse(s.expires_at) > now));
    const sharers = new Set(active.map((s) => s.user_id));
    return {
      stats: { total_accounts: users.length, active_links: active.length, active_sharers: sharers.size, not_sharing_count: Math.max(0, users.length - sharers.size) },
      users: users.map((u) => ({ id: u.id, username: u.username, display_name: u.display_name, role: u.role, account_status: u.account_status, created_at: u.created_at, last_seen_at: u.last_seen_at, is_sharing: sharers.has(u.id) }))
    };
  },

  adminSetStatus(targetId, newStatus) {
    this.saveUsers(this.users().map((u) => (u.id === targetId ? { ...u, account_status: newStatus } : u)));
    if (newStatus === "disabled") this.stopOwnerSession(targetId, null);
  }
};

// ============================================================================
// 4. NAVIGATION & SHELL UI
// ============================================================================
function setActiveView(viewName, subview = null) {
  state.activeView = viewName;
  if (subview) state.dashboardSubview = subview;
  for (const v of ["auth", "dashboard", "settings", "viewer", "admin"]) hide(`view-${v}`, v !== viewName);
  if (viewName === "dashboard") $("view-dashboard")?.setAttribute("data-subview", state.dashboardSubview);
  updateNavigationUI();
  if (viewName === "dashboard" && state.owner.map) window.setTimeout(() => state.owner.map.invalidateSize(), 140);
  if (viewName === "viewer" && state.viewer.map) window.setTimeout(() => state.viewer.map.invalidateSize(), 140);
}

function updateNavigationUI() {
  const loggedIn = Boolean(state.user && state.profile);
  const isAdmin = Boolean(state.profile?.role === "admin");
  const showNav = loggedIn && state.activeView !== "auth" && state.activeView !== "viewer";

  hide("top-nav", !showNav);
  hide("top-user-chip", !loggedIn);
  hide("nav-admin-btn", !isAdmin);
  hide("mobile-bottom-nav", !showNav);
  hide("bottom-nav-admin-btn", !isAdmin);
  document.body.classList.toggle("has-bottom-nav", showNav);

  const cur = state.activeView === "dashboard" ? state.dashboardSubview : state.activeView;
  document.querySelectorAll("[data-nav]").forEach((b) => b.classList.toggle("is-active", b.getAttribute("data-nav") === cur));

  if (state.profile) {
    const u = getDisplayUsername(state.profile);
    txt("top-user-name", u); txt("top-user-avatar", u.charAt(0).toUpperCase());
    txt("owner-greeting", u); txt("owner-avatar-badge", u.charAt(0).toUpperCase());
  }

  const pill = $("top-status-pill");
  if (pill) {
    pill.classList.remove("is-off", "is-acquiring", "is-live", "is-stale");
    if (state.owner.sharingPhase === "live") {
      const stale = !state.isOnline || (state.owner.lastSentAt > 0 && Date.now() - state.owner.lastSentAt > APP_CFG.staleThresholdMs);
      pill.classList.add(stale ? "is-stale" : "is-live");
      txt("top-status-text", stale ? "Reconnecting" : "Sharing");
    } else if (state.owner.sharingPhase === "acquiring") {
      pill.classList.add("is-acquiring"); txt("top-status-text", "Locating");
    } else {
      pill.classList.add("is-off"); txt("top-status-text", "Off");
    }
  }
}

function updateNetworkBanner() {
  hide("network-banner", state.isOnline);
  if (!state.isOnline) {
    const t = state.activeView === "viewer" && state.viewer.targetPos
      ? `Last update ${formatRelativeTime(state.viewer.targetPos.recordedAt)}`
      : state.owner.lastSentAt ? `Last synced ${formatRelativeTime(state.owner.lastSentAt)}` : "";
    txt("network-banner-detail", t);
  }
}

// ============================================================================
// 5. LEAFLET MAP CONTROLLER
// ============================================================================
class GhostMapController {
  constructor(containerId) {
    this.containerId = containerId;
    this.map = this.targetMarker = this.targetCircle = this.selfMarker = this.selfCircle = this.routeLine = null;
    this.currentTargetLatLng = this.animFrameId = null;
    this.hasCenteredOnce = false;
  }

  ensureInit(lat = 0, lng = 0, zoom = 15) {
    if (this.map) return true;
    if (typeof globalThis.L === "undefined") return false;
    const container = $(this.containerId);
    if (!container) return false;
    this.map = globalThis.L.map(container, { zoomControl: true, attributionControl: true }).setView([lat, lng], zoom);
    const primary = globalThis.L.tileLayer(APP_CFG.mapTilesUrl, { maxZoom: 19, attribution: APP_CFG.mapAttribution });
    let switched = false;
    primary.on("tileerror", () => {
      if (switched || !this.map) return;
      switched = true;
      globalThis.L.tileLayer(APP_CFG.mapTilesFallbackUrl, { maxZoom: 19, attribution: APP_CFG.mapAttribution }).addTo(this.map);
    });
    primary.addTo(this.map);
    return true;
  }

  invalidateSize() { this.map?.invalidateSize(); }

  setTargetLocation(lat, lng, accuracy, label = "Live Position") {
    if (!this.ensureInit(lat, lng, 16)) return;
    const ll = [lat, lng];
    const icon = globalThis.L.divIcon({ className: "ghost-marker-wrap", html: `<div class="ghost-live-pin"><div class="ghost-live-pin-core"></div></div>`, iconSize: [24, 24], iconAnchor: [12, 12] });
    if (!this.targetMarker) {
      this.targetMarker = globalThis.L.marker(ll, { icon }).addTo(this.map);
      this.targetMarker.bindTooltip(label, { direction: "top", offset: [0, -12] });
      this.targetCircle = globalThis.L.circle(ll, { radius: Math.max(5, Number(accuracy) || 15), color: "#16A34A", fillColor: "#16A34A", fillOpacity: 0.14, weight: 1.5 }).addTo(this.map);
      this.currentTargetLatLng = { lat, lng };
      if (!this.hasCenteredOnce) { this.map.setView(ll, 16, { animate: false }); this.hasCenteredOnce = true; }
      return;
    }
    const start = { ...this.currentTargetLatLng }, end = { lat, lng }, t0 = performance.now();
    if (this.animFrameId) cancelAnimationFrame(this.animFrameId);
    const step = (now) => {
      const p = Math.min(1, (now - t0) / 600), e = 1 - (1 - p) ** 3;
      const cur = [start.lat + (end.lat - start.lat) * e, start.lng + (end.lng - start.lng) * e];
      this.currentTargetLatLng = { lat: cur[0], lng: cur[1] };
      this.targetMarker?.setLatLng(cur);
      if (this.targetCircle) { this.targetCircle.setLatLng(cur); this.targetCircle.setRadius(Math.max(5, Number(accuracy) || 15)); }
      this.animFrameId = p < 1 ? requestAnimationFrame(step) : null;
    };
    this.animFrameId = requestAnimationFrame(step);
  }

  setSelfLocation(lat, lng, accuracy) {
    if (!this.ensureInit(lat, lng, 15)) return;
    const icon = globalThis.L.divIcon({ className: "ghost-marker-wrap", html: `<div class="ghost-viewer-pin-core"></div>`, iconSize: [15, 15], iconAnchor: [7.5, 7.5] });
    if (!this.selfMarker) {
      this.selfMarker = globalThis.L.marker([lat, lng], { icon }).addTo(this.map);
      this.selfMarker.bindTooltip("Your location", { direction: "top", offset: [0, -10] });
      this.selfCircle = globalThis.L.circle([lat, lng], { radius: Math.max(5, Number(accuracy) || 15), color: "#15803D", fillColor: "#15803D", fillOpacity: 0.1, weight: 1.5 }).addTo(this.map);
    } else {
      this.selfMarker.setLatLng([lat, lng]);
      if (this.selfCircle) { this.selfCircle.setLatLng([lat, lng]); this.selfCircle.setRadius(Math.max(5, Number(accuracy) || 15)); }
    }
  }

  setRouteCoordinates(coords) {
    if (!this.map || !Array.isArray(coords) || coords.length < 2) return;
    this.clearRoute();
    this.routeLine = globalThis.L.polyline(coords, { color: "#15803D", weight: 5, opacity: 0.88, lineJoin: "round" }).addTo(this.map);
    this.map.fitBounds(this.routeLine.getBounds(), { padding: [44, 44] });
  }

  clearRoute() { if (this.routeLine && this.map) { this.map.removeLayer(this.routeLine); this.routeLine = null; } }
  recenterOnTarget() { if (this.map && this.targetMarker) this.map.flyTo(this.targetMarker.getLatLng(), Math.max(this.map.getZoom(), 16), { duration: 0.5 }); }
  fitBoth() { if (this.map && this.targetMarker && this.selfMarker) this.map.fitBounds(globalThis.L.featureGroup([this.targetMarker, this.selfMarker]).getBounds(), { padding: [48, 48] }); }

  clearAllLayers() {
    if (this.animFrameId) { cancelAnimationFrame(this.animFrameId); this.animFrameId = null; }
    if (!this.map) return;
    [this.targetMarker, this.targetCircle, this.selfMarker, this.selfCircle, this.routeLine].forEach((l) => l && this.map.removeLayer(l));
    this.targetMarker = this.targetCircle = this.selfMarker = this.selfCircle = this.routeLine = this.currentTargetLatLng = null;
    this.hasCenteredOnce = false;
  }
}

// ============================================================================
// 6. GEOCODING & ROUTING
// ============================================================================
async function reverseGeocode(lat, lon) {
  const c = typeof AbortController !== "undefined" ? new AbortController() : null;
  const t = c ? window.setTimeout(() => c.abort(), 7000) : null;
  try {
    const res = await fetch(`${APP_CFG.reverseGeocodeUrl}?format=jsonv2&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&zoom=18&addressdetails=1`, { signal: c?.signal, headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    const d = await res.json(), a = d?.address || {};
    const place = d?.name || a.building || a.amenity || a.shop || a.office || a.leisure || a.tourism || null;
    const street = a.road || a.pedestrian || a.footway || null;
    const area = a.neighbourhood || a.suburb || a.residential || a.quarter || a.city_district || null;
    const city = a.city || a.town || a.village || a.county || null;
    const reg = a.state || a.region || null;
    return { location_label: place || street || area || city || reg || null, area_name: area || street || null, city, state: reg, country: a.country || null };
  } catch { return null; } finally { if (t) window.clearTimeout(t); }
}

async function fetchRoadRoute(fromLat, fromLon, toLat, toLon, mode = "driving") {
  const c = typeof AbortController !== "undefined" ? new AbortController() : null;
  const t = c ? window.setTimeout(() => c.abort(), 9000) : null;
  try {
    const res = await fetch(`${APP_CFG.routingBaseUrl}/${mode === "walking" ? "foot" : "driving"}/${fromLon},${fromLat};${toLon},${toLat}?overview=full&geometries=geojson`, { signal: c?.signal, headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`Routing status ${res.status}`);
    const payload = await res.json();
    if (!payload || payload.code !== "Ok" || !payload.routes?.length) throw new Error("No route found.");
    const best = payload.routes[0];
    return { coordinates: best.geometry.coordinates.map(([lng, lat]) => [lat, lng]), distanceMeters: best.distance, durationSeconds: best.duration };
  } finally { if (t) window.clearTimeout(t); }
}

// ============================================================================
// 7. AUTHENTICATION & PERMISSIONS
// ============================================================================
function switchAuthPanel(panel) {
  state.authPanel = panel;
  hide("auth-panel-login", panel !== "login");
  hide("auth-panel-register", panel !== "register");
  ["login-password", "reg-password", "reg-confirm-password"].forEach((id) => {
    const inp = $(id); if (inp) inp.type = "password";
    const btn = document.querySelector(`[data-toggle-password="${id}"]`);
    if (btn) {
      btn.setAttribute("aria-pressed", "false"); btn.setAttribute("aria-label", "Show password");
      btn.querySelector(".icon-eye")?.classList.remove("hidden"); btn.querySelector(".icon-eye-off")?.classList.add("hidden");
    }
  });
}

async function loadUserProfile() {
  const authUser = state.user;
  if (!authUser) return null;
  let data = null;
  if (state.supabase) {
    if (!state.supabaseProfileBlocked) {
      const res = await state.supabase.from("profiles").select("*").eq("id", authUser.id).maybeSingle();
      if (!res.error && res.data) {
        data = res.data;
        state.supabase.from("profiles").update({ last_seen_at: new Date().toISOString() }).eq("id", authUser.id).then(() => undefined, () => undefined);
      } else if (!res.error && !res.data) {
        const uname = deriveUsernameFromAuthUser(authUser);
        const seed = { id: authUser.id, username: uname, display_name: uname, role: "user", account_status: "active", default_expiration: "until_stopped", notifications_enabled: true };
        const up = await state.supabase.from("profiles").upsert(seed, { onConflict: "id" }).select("*").maybeSingle();
        if (!up.error && up.data) data = up.data;
        else {
          if (isDbPermissionOrSchemaError(up.error)) state.supabaseProfileBlocked = true;
          data = buildFallbackProfile(authUser);
        }
      } else {
        if (isDbPermissionOrSchemaError(res.error)) state.supabaseProfileBlocked = true;
        data = buildFallbackProfile(authUser);
      }
    } else {
      data = buildFallbackProfile(authUser);
    }
    writeSupabaseProfileCache(authUser.id, { ...data, last_seen_at: new Date().toISOString() });
  } else {
    data = LocalStore.getProfile(authUser.id);
    LocalStore.updateProfile(authUser.id, { last_seen_at: new Date().toISOString() });
  }
  state.profile = data;
  state.notificationsEnabled = data.notifications_enabled !== false;
  if (data.account_status === "disabled") {
    await stopOwnerSharing(false);
    if (state.supabase) await state.supabase.auth.signOut().catch(() => undefined);
    else LocalStore.signOut();
    state.user = state.profile = null;
    setActiveView("auth");
    showNotification("This account has been disabled by an administrator.", "error", "Account Disabled", true);
    return null;
  }
  return data;
}

async function handleAuthenticatedSession(session, { navigate = true, rethrow = false } = {}) {
  const hasLive = Boolean(new URLSearchParams(window.location.search).get("live"));
  if (!session?.user) {
    state.user = state.profile = null;
    state.supabaseProfileBlocked = false;
    state.supabaseDbBlocked = false;
    if (state.activeView !== "viewer" && !hasLive) setActiveView("auth");
    return false;
  }
  const isSameUserReady = Boolean(state.user?.id === session.user.id && state.profile);
  state.user = session.user;
  try {
    const profile = await loadUserProfile();
    if (!profile) return false;
    const expSel = $("share-expiration-select");
    if (expSel) expSel.value = profile.default_expiration || "until_stopped";
    if (navigate && state.activeView !== "viewer" && !hasLive && (!isSameUserReady || state.activeView === "auth")) {
      setActiveView("dashboard", "home");
    } else {
      updateNavigationUI();
    }
    if (!isSameUserReady) {
      await restoreOwnerActiveSession();
      await syncBrowserPermissionState();
      populateSettingsView();
    }
    return true;
  } catch (err) {
    if (rethrow) throw err;
    showNotification(err.message || "Unable to load your GHOST profile.", "error", "Profile Error", true);
    setActiveView("auth");
    return false;
  }
}

function formatPermissionLabel(p) {
  return ({ granted: "Allowed", denied: "Blocked", prompt: "Ask on use", unavailable: "Unavailable" })[p] || "Unknown";
}

async function syncBrowserPermissionState(explicit = null) {
  let perm = explicit;
  if (!perm) {
    if (!("geolocation" in navigator)) perm = "unavailable";
    else if (navigator.permissions?.query) {
      try {
        const res = await navigator.permissions.query({ name: "geolocation" });
        perm = res.state;
        if (!state.owner.permissionWatcher) {
          state.owner.permissionWatcher = res;
          res.onchange = () => {
            syncBrowserPermissionState(res.state);
            if (res.state === "denied" && state.owner.sharingPhase !== "offline") handleGeolocationRevoked();
          };
        }
      } catch { perm = "unknown"; }
    } else perm = "unknown";
  }
  state.owner.permissionStatus = perm;
  txt("settings-perm-text", formatPermissionLabel(perm));
  if (state.user && ["unknown", "granted", "denied", "prompt", "unavailable"].includes(perm)) {
    const patch = { location_permission_status: perm, permission_updated_at: new Date().toISOString() };
    if (state.supabase) {
      writeSupabaseProfileCache(state.user.id, patch);
      if (!state.supabaseProfileBlocked) state.supabase.from("profiles").update(patch).eq("id", state.user.id).then(() => undefined).catch(() => undefined);
    } else try { LocalStore.updateProfile(state.user.id, patch); } catch {}
  }
}

// ============================================================================
// 8. OWNER LIVE LOCATION SHARING
// ============================================================================
function renderOwnerDashboardState() {
  const phase = state.owner.sharingPhase;
  const pill = $("owner-status-pill"), hero = $("owner-hero-icon"), mapBtn = $("owner-map-toggle-share-btn");
  pill.classList.remove("is-off", "is-acquiring", "is-live", "is-stale");
  hero.classList.remove("is-off", "is-acquiring", "is-live");

  if (phase === "offline") {
    pill.classList.add("is-off"); hero.classList.add("is-off");
    txt("owner-status-text", "Location sharing is off");
    txt("owner-status-heading", "Location sharing is off");
    txt("owner-status-desc", "Your location stays private until you start sharing.");
    hide("btn-start-sharing", false); $("btn-start-sharing").disabled = false;
    hide("btn-open-shared-link", false); hide("btn-stop-sharing", true);
    hide("owner-telemetry-section", true); hide("owner-link-card", true);
    hide("owner-recenter-btn", true); hide("owner-map-empty", false);
    txt("owner-map-coords", "No active stream");
    if (mapBtn) { mapBtn.className = "btn btn-primary btn-sm"; mapBtn.textContent = "Start Sharing"; }
  } else if (phase === "acquiring") {
    pill.classList.add("is-acquiring"); hero.classList.add("is-acquiring");
    txt("owner-status-text", "Acquiring GPS");
    txt("owner-status-heading", "Waiting for GPS fix...");
    txt("owner-status-desc", "Your live link will activate as soon as a valid position is received.");
    hide("btn-start-sharing", true); hide("btn-open-shared-link", true); hide("btn-stop-sharing", false);
    hide("owner-telemetry-section", true); hide("owner-link-card", true);
    hide("owner-recenter-btn", true); hide("owner-map-empty", false);
    txt("owner-map-coords", "Acquiring GPS fix...");
    if (mapBtn) { mapBtn.className = "btn btn-danger btn-sm"; mapBtn.textContent = "Cancel"; }
  } else {
    const stale = !state.isOnline || (state.owner.lastSentAt > 0 && Date.now() - state.owner.lastSentAt > APP_CFG.staleThresholdMs);
    pill.classList.add(stale ? "is-stale" : "is-live"); hero.classList.add("is-live");
    txt("owner-status-text", stale ? "Reconnecting" : "Live");
    txt("owner-status-heading", stale ? "Reconnecting..." : "Your location is being shared");
    txt("owner-status-desc", stale ? "Connection interrupted. Syncing your latest position automatically." : "Only people with your private link can see your live position.");
    hide("btn-start-sharing", true); hide("btn-open-shared-link", true); hide("btn-stop-sharing", false);
    hide("owner-telemetry-section", false); hide("owner-recenter-btn", false); hide("owner-map-empty", true);
    if (mapBtn) { mapBtn.className = "btn btn-danger btn-sm"; mapBtn.textContent = "Stop"; }

    if (state.owner.session) {
      txt("owner-share-url", buildShareUrl(state.owner.session.share_token));
      hide("owner-link-card", false);
      txt("owner-duration-text", formatSharingDuration(state.owner.session.started_at));
      txt("owner-expires-text", formatExpirationText(state.owner.session.expires_at));
    }
    if (state.owner.lastPosition) {
      const pos = state.owner.lastPosition, geo = formatGeocodeDisplay(state.owner.geoInfo);
      txt("owner-area-text", geo.secondary ? `${geo.primary} · ${geo.secondary}` : geo.primary);
      txt("owner-accuracy-text", formatAccuracy(pos.accuracy));
      txt("owner-updated-text", formatRelativeTime(state.owner.lastSentAt || pos.timestamp));
      hide("owner-accuracy-warning", !(pos.accuracy > APP_CFG.poorAccuracyMeters));
      txt("owner-map-coords", `${pos.latitude.toFixed(5)}, ${pos.longitude.toFixed(5)}`);
    }
  }
  updateNavigationUI();
  txt("settings-sharing-status", phase === "live" ? "Sharing live" : phase === "acquiring" ? "Starting..." : "Off");
}

function setOwnerError(msg) { txt("owner-error-box", msg || ""); hide("owner-error-box", !msg); }

function handleGeolocationRevoked() {
  const msg = "Location permission was revoked in your browser settings. Sharing has ended.";
  setOwnerError(msg); showNotification(msg, "warning", "Permission Revoked", true); stopOwnerSharing(false);
}

function handleOwnerGeoError(err) {
  let msg = "Unable to access your device location.";
  if (err?.code === 1) {
    syncBrowserPermissionState("denied");
    msg = window.location.protocol === "file:"
      ? "Browser blocked GPS on a local file:// URL. Allow location access or host over HTTPS."
      : "Location permission is required to start sharing.";
    if (state.owner.sharingPhase === "live") stopOwnerSharing(false);
  } else if (err?.code === 2) {
    syncBrowserPermissionState("unavailable");
    msg = "Device GPS is currently unavailable. Turn on Location services and try again.";
  } else if (err?.code === 3) {
    msg = "GPS request timed out. Move near a window or outdoors and try again.";
  }
  if (state.owner.sharingPhase === "acquiring") {
    clearOwnerWatcher(); state.owner.sharingPhase = "offline"; renderOwnerDashboardState();
  }
  setOwnerError(msg); showNotification(msg, "error", "Location Error", true);
}

function clearOwnerWatcher() {
  if (state.owner.watchId !== null && "geolocation" in navigator) { navigator.geolocation.clearWatch(state.owner.watchId); state.owner.watchId = null; }
  if (state.owner.expirationTimer) { window.clearTimeout(state.owner.expirationTimer); state.owner.expirationTimer = null; }
}

function scheduleSessionExpirationCheck(expiresIso) {
  if (state.owner.expirationTimer) { window.clearTimeout(state.owner.expirationTimer); state.owner.expirationTimer = null; }
  if (!expiresIso) return;
  const rem = Date.parse(expiresIso) - Date.now();
  if (rem <= 0) return stopOwnerSharing(true, "This live location link has expired.");
  state.owner.expirationTimer = window.setTimeout(() => stopOwnerSharing(true, "This live location link has expired."), Math.min(rem, 2147483000));
}

function joinOwnerBroadcastChannel(token) {
  if (!state.supabase || !token) return;
  if (state.owner.channel) state.supabase.removeChannel(state.owner.channel);
  state.owner.channel = state.supabase.channel(`ghost-live:${token}`, { config: { broadcast: { self: false } } });
  state.owner.channel.subscribe();
}

async function createOrReuseOwnerSession(preset) {
  if (state.owner.session?.is_active) return state.owner.session;
  let data = null;
  if (state.supabase && !state.supabaseDbBlocked) {
    const stopRes = await state.supabase.from("live_sessions").update({ is_active: false, status: "stopped", ended_at: new Date().toISOString() }).eq("user_id", state.user.id).eq("is_active", true);
    if (stopRes.error && isDbPermissionOrSchemaError(stopRes.error)) {
      state.supabaseDbBlocked = true;
    } else {
      const res = await state.supabase.from("live_sessions").insert({ user_id: state.user.id, share_token: generateSecureToken(24), is_active: true, status: "active", duration_preset: preset, expires_at: computeExpirationIso(preset), device_platform: "web" }).select("*").single();
      if (!res.error && res.data) {
        data = res.data;
        joinOwnerBroadcastChannel(data.share_token);
      } else if (isDbPermissionOrSchemaError(res.error)) {
        state.supabaseDbBlocked = true;
      } else if (res.error) throw res.error;
    }
  }
  if (!data) {
    data = LocalStore.createLiveSession(state.user.id, preset);
    if (state.supabase) joinOwnerBroadcastChannel(data.share_token);
  }
  state.owner.session = data;
  scheduleSessionExpirationCheck(data.expires_at);
  return data;
}

async function handleOwnerPositionFix(geoPos) {
  const { latitude, longitude, accuracy, speed, heading } = geoPos.coords;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;
  setOwnerError(""); syncBrowserPermissionState("granted");

  const pos = { latitude, longitude, accuracy: Number.isFinite(accuracy) ? accuracy : 25, speed: Number.isFinite(speed) ? speed : null, heading: Number.isFinite(heading) ? heading : null, timestamp: geoPos.timestamp || Date.now() };
  state.owner.lastPosition = pos;
  if (!state.owner.map) state.owner.map = new GhostMapController("owner-map-canvas");
  state.owner.map.setTargetLocation(pos.latitude, pos.longitude, pos.accuracy, "Your Live Position");

  if (state.owner.sharingPhase !== "live") {
    try {
      await createOrReuseOwnerSession(state.owner.selectedPreset);
      state.owner.sharingPhase = "live";
      await syncOwnerLocationToBackend(pos, true);
      renderOwnerDashboardState();
      showNotification("Live location sharing is now active.", "success", "Sharing Live", true);
    } catch (err) {
      setOwnerError(err.message || "Failed to start live session.");
      showNotification(err.message || "Failed to start live session.", "error", "Session Error", true);
      clearOwnerWatcher(); state.owner.sharingPhase = "offline"; renderOwnerDashboardState();
    }
    return;
  }

  renderOwnerDashboardState();
  const elapsed = Date.now() - state.owner.lastSentAt;
  const moved = state.owner.lastSentPosition ? haversineMeters(state.owner.lastSentPosition.latitude, state.owner.lastSentPosition.longitude, pos.latitude, pos.longitude) : Infinity;
  const improved = state.owner.lastSentPosition && pos.accuracy < state.owner.lastSentPosition.accuracy * 0.6;
  if ((moved >= APP_CFG.minMoveMetersForSync && elapsed >= APP_CFG.locationThrottleMs) || elapsed >= APP_CFG.heartbeatSyncMs || (improved && elapsed >= APP_CFG.locationThrottleMs)) {
    syncOwnerLocationToBackend(pos, false);
  }
}

async function syncOwnerLocationToBackend(pos, forceGeocode = false) {
  if (!state.user || !state.owner.session) return;
  if (!state.isOnline && state.supabase) return renderOwnerDashboardState();
  if (state.owner.isSyncing) { state.owner.pendingPosition = pos; return; }
  state.owner.isSyncing = true;
  try {
    const movedGeo = state.owner.lastGeocodePos ? haversineMeters(state.owner.lastGeocodePos.latitude, state.owner.lastGeocodePos.longitude, pos.latitude, pos.longitude) : Infinity;
    if (state.isOnline && (forceGeocode || !state.owner.geoInfo || (movedGeo >= APP_CFG.geocodeMinMoveMeters && Date.now() - state.owner.lastGeocodeAt >= APP_CFG.geocodeThrottleMs))) {
      const geo = await reverseGeocode(pos.latitude, pos.longitude);
      if (geo) { state.owner.geoInfo = geo; state.owner.lastGeocodeAt = Date.now(); state.owner.lastGeocodePos = { latitude: pos.latitude, longitude: pos.longitude }; }
    }
    const recorded_at = new Date().toISOString();
    const payload = {
      session_id: state.owner.session.id, user_id: state.user.id, latitude: pos.latitude, longitude: pos.longitude, accuracy: pos.accuracy,
      speed: pos.speed, heading: pos.heading, location_label: state.owner.geoInfo?.location_label || null, area_name: state.owner.geoInfo?.area_name || null,
      city: state.owner.geoInfo?.city || null, state: state.owner.geoInfo?.state || null, country: state.owner.geoInfo?.country || null, recorded_at
    };
    if (state.supabase && !state.supabaseDbBlocked && !String(state.owner.session.id).startsWith("sess_")) {
      const { error } = await state.supabase.from("live_locations").upsert(payload, { onConflict: "session_id" });
      if (error) {
        if (isDbPermissionOrSchemaError(error)) {
          state.supabaseDbBlocked = true;
          LocalStore.upsertLocation(state.owner.session, payload);
        } else if (String(error.message).toLowerCase().includes("row-level security")) {
          return await stopOwnerSharing(false, "Your live session was revoked or expired.");
        } else throw error;
      } else {
        await state.supabase.from("live_sessions").update({ last_heartbeat_at: recorded_at }).eq("id", state.owner.session.id).then(() => undefined, () => undefined);
      }
      state.owner.channel?.send({ type: "broadcast", event: "location_update", payload: { status: "active", display_name: getDisplayUsername(state.profile), ...payload, expires_at: state.owner.session.expires_at } });
    } else {
      LocalStore.upsertLocation(state.owner.session, payload);
      state.owner.channel?.send({ type: "broadcast", event: "location_update", payload: { status: "active", display_name: getDisplayUsername(state.profile), ...payload, expires_at: state.owner.session.expires_at } });
    }
    state.owner.lastSentPosition = pos; state.owner.lastSentAt = Date.now(); renderOwnerDashboardState();
  } catch (err) {
    setOwnerError(err.message || "Failed to sync live location.");
  } finally {
    state.owner.isSyncing = false;
    if (state.owner.pendingPosition) { const next = state.owner.pendingPosition; state.owner.pendingPosition = null; syncOwnerLocationToBackend(next, false); }
  }
}

function beginLocationWatch(preset) {
  if (!("geolocation" in navigator)) { syncBrowserPermissionState("unavailable"); return showNotification("Your browser does not support device geolocation.", "error", "Unavailable", true); }
  setOwnerError(""); clearOwnerWatcher();
  state.owner.selectedPreset = preset || "until_stopped";
  state.owner.sharingPhase = "acquiring";
  renderOwnerDashboardState();
  try {
    state.owner.watchId = navigator.geolocation.watchPosition(handleOwnerPositionFix, handleOwnerGeoError, { enableHighAccuracy: true, timeout: 15000, maximumAge: 3000 });
  } catch (err) { handleOwnerGeoError({ code: 1, message: err.message }); }
}

async function restoreOwnerActiveSession() {
  if (!state.user) return;
  let active = null;
  if (state.supabase && !state.supabaseDbBlocked) {
    const { data, error } = await state.supabase.from("live_sessions").select("*").eq("user_id", state.user.id).eq("is_active", true).order("created_at", { ascending: false }).limit(1);
    if (error && isDbPermissionOrSchemaError(error)) {
      state.supabaseDbBlocked = true;
      active = LocalStore.getActiveOwnerSession(state.user.id);
    } else {
      active = data?.[0] || LocalStore.getActiveOwnerSession(state.user.id);
    }
  } else {
    active = LocalStore.getActiveOwnerSession(state.user.id);
  }
  if (!active) { state.owner.session = null; state.owner.sharingPhase = "offline"; return renderOwnerDashboardState(); }
  if (active.expires_at && Date.parse(active.expires_at) <= Date.now()) {
    if (state.supabase && !state.supabaseDbBlocked) await state.supabase.rpc("stop_my_live_session", { p_session_id: active.id }).then(() => undefined, () => undefined);
    LocalStore.stopOwnerSession(state.user.id, active.id);
    state.owner.session = null; state.owner.sharingPhase = "offline"; return renderOwnerDashboardState();
  }
  state.owner.session = active; state.owner.selectedPreset = active.duration_preset || "until_stopped";
  if (state.supabase) joinOwnerBroadcastChannel(active.share_token);
  scheduleSessionExpirationCheck(active.expires_at);
  if (navigator.permissions?.query) {
    try {
      const perm = await navigator.permissions.query({ name: "geolocation" });
      if (perm.state === "granted") return beginLocationWatch(state.owner.selectedPreset);
    } catch {}
  }
  state.owner.sharingPhase = "offline"; renderOwnerDashboardState();
  setOwnerError("Previous active session found. Tap START SHARING to resume GPS or end it.");
  hide("btn-stop-sharing", false);
}

async function stopOwnerSharing(notifyToast = true, customMessage = null) {
  clearOwnerWatcher();
  const sess = state.owner.session, ch = state.owner.channel;
  if (ch) {
    try { await ch.send({ type: "broadcast", event: "session_ended", payload: { status: customMessage ? "expired" : "stopped" } }); } catch {}
    state.supabase?.removeChannel(ch); state.owner.channel = null;
  }
  if (state.user) {
    if (state.supabase && !state.supabaseDbBlocked && sess && !String(sess.id).startsWith("sess_")) {
      try {
        const rpcRes = await state.supabase.rpc("stop_my_live_session", { p_session_id: sess?.id || null });
        if (rpcRes.error && sess) await state.supabase.from("live_sessions").update({ is_active: false, status: "stopped", ended_at: new Date().toISOString() }).eq("id", sess.id).then(() => undefined, () => undefined);
      } catch {
        if (sess) await state.supabase.from("live_sessions").update({ is_active: false, status: "stopped", ended_at: new Date().toISOString() }).eq("id", sess.id).then(() => undefined, () => undefined);
      }
    }
    LocalStore.stopOwnerSession(state.user.id, sess?.id || null);
  }
  state.owner.session = state.owner.lastPosition = state.owner.lastSentPosition = state.owner.geoInfo = state.owner.pendingPosition = null;
  state.owner.sharingPhase = "offline"; state.owner.lastSentAt = 0;
  state.owner.map?.clearAllLayers();
  renderOwnerDashboardState();
  if (customMessage) { setOwnerError(customMessage); showNotification(customMessage, "warning", "Session Ended", true); }
  else if (notifyToast) showNotification("Your location sharing has ended.", "success", "Sharing Stopped", true);
}

// ============================================================================
// 9. LIVE VIEWER ENGINE
// ============================================================================
function teardownViewerSession() {
  if (state.viewer.pollTimer) { window.clearInterval(state.viewer.pollTimer); state.viewer.pollTimer = null; }
  if (state.viewer.channel && state.supabase) { state.supabase.removeChannel(state.viewer.channel); state.viewer.channel = null; }
  if (state.viewer.watchId !== null && "geolocation" in navigator) { navigator.geolocation.clearWatch(state.viewer.watchId); state.viewer.watchId = null; }
  state.viewer.map?.clearAllLayers();
  Object.assign(state.viewer, { token: null, status: "idle", targetPos: null, selfPos: null, routeActive: false, routeMeta: null, lastRouteAt: 0, lastRouteTarget: null, lastRouteSelf: null });
}

function renderViewerState() {
  const s = state.viewer.status;
  hide("viewer-skeleton", s !== "loading");
  hide("viewer-terminal-card", !["stopped", "expired", "invalid"].includes(s));
  hide("viewer-active-card", !["waiting", "active"].includes(s));
  hide("viewer-recenter-btn", s !== "active");

  if (["stopped", "expired", "invalid"].includes(s)) {
    const titles = { stopped: "Sharing Ended", expired: "Link Expired", invalid: "Invalid Link" };
    const msgs = { stopped: "Location sharing has ended.", expired: "This live location link has expired.", invalid: "This live location link is invalid or no longer active." };
    txt("viewer-terminal-badge", titles[s]); txt("viewer-terminal-title", titles[s]); txt("viewer-terminal-message", msgs[s]);
    hide("viewer-map-empty", false); txt("viewer-map-empty-text", msgs[s]); txt("viewer-map-status", titles[s]); hide("viewer-fit-both-btn", true);
    return;
  }

  if (s === "waiting") {
    txt("viewer-person-name", state.viewer.personName || "Shared User");
    txt("viewer-place-primary", "Waiting for initial GPS fix..."); txt("viewer-place-secondary", "");
    txt("viewer-accuracy-text", "Pending"); txt("viewer-updated-text", "Pending");
    txt("viewer-expires-text", formatExpirationText(state.viewer.expiresAt));
    txt("viewer-live-badge-text", "CONNECTING"); $("viewer-live-indicator").className = "status-tag is-acquiring";
    hide("viewer-map-empty", false); txt("viewer-map-empty-text", "Waiting for sender's first valid GPS location.");
    return;
  }

  if (s === "active" && state.viewer.targetPos) {
    const t = state.viewer.targetPos, stale = !state.isOnline || Date.now() - Date.parse(t.recordedAt) > APP_CFG.staleThresholdMs;
    $("viewer-live-indicator").className = `status-tag ${stale ? "is-stale" : "is-live"}`;
    txt("viewer-live-badge-text", stale ? `Updated ${formatRelativeTime(t.recordedAt)}` : "LIVE");
    txt("viewer-person-name", state.viewer.personName || "Shared User");
    const geo = formatGeocodeDisplay(t.geo);
    txt("viewer-place-primary", geo.primary); txt("viewer-place-secondary", geo.secondary);
    txt("viewer-accuracy-text", formatAccuracy(t.accuracy)); txt("viewer-updated-text", formatRelativeTime(t.recordedAt));
    txt("viewer-expires-text", formatExpirationText(state.viewer.expiresAt));
    hide("viewer-accuracy-warn", !(t.accuracy > APP_CFG.poorAccuracyMeters));
    hide("viewer-map-empty", true);
    txt("viewer-map-status", stale ? `Last update ${formatRelativeTime(t.recordedAt)}` : `Accuracy ±${Math.round(t.accuracy)} m · ${formatRelativeTime(t.recordedAt)}`);

    const ext = $("btn-open-external-maps");
    ext.href = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(`${t.latitude},${t.longitude}`)}`;
    ext.classList.remove("hidden");

    if (state.viewer.selfPos) {
      const dist = haversineMeters(state.viewer.selfPos.latitude, state.viewer.selfPos.longitude, t.latitude, t.longitude);
      hide("viewer-distance-card", false); txt("viewer-distance-text", formatDistance(dist));
      hide("viewer-fit-both-btn", false); txt("btn-use-my-location", "My Location Active");
      txt("viewer-route-eta", state.viewer.routeMeta
        ? `${formatDuration(state.viewer.routeMeta.durationSeconds)} ${state.viewer.routeMode === "walking" ? "walk" : "drive"} · ${formatRouteDistance(state.viewer.routeMeta.distanceMeters)} road route`
        : "Tap Meet Me / Directions for road route");
    } else {
      hide("viewer-distance-card", true); hide("viewer-fit-both-btn", true); txt("btn-use-my-location", "Use My Location");
    }

    hide("viewer-route-controls", !state.viewer.routeActive);
    $("route-mode-driving").className = `btn btn-sm ${state.viewer.routeMode === "driving" ? "btn-primary" : "btn-secondary"}`;
    $("route-mode-walking").className = `btn btn-sm ${state.viewer.routeMode === "walking" ? "btn-primary" : "btn-secondary"}`;
  }
}

function applyViewerLocationPayload(payload) {
  if (!payload?.status) return;
  if (["stopped", "expired", "invalid"].includes(payload.status)) {
    state.viewer.status = payload.status; state.viewer.targetPos = null; state.viewer.map?.clearAllLayers();
    if (state.viewer.pollTimer) { window.clearInterval(state.viewer.pollTimer); state.viewer.pollTimer = null; }
    return renderViewerState();
  }
  state.viewer.personName = payload.display_name || "Shared User";
  state.viewer.expiresAt = payload.expires_at || null;
  if (payload.expires_at && Date.parse(payload.expires_at) <= Date.now()) return applyViewerLocationPayload({ status: "expired" });
  if (payload.status === "waiting") { state.viewer.status = "waiting"; return renderViewerState(); }
  if (payload.status === "active" && Number.isFinite(payload.latitude) && Number.isFinite(payload.longitude)) {
    state.viewer.status = "active";
    state.viewer.targetPos = {
      latitude: payload.latitude, longitude: payload.longitude, accuracy: Number.isFinite(payload.accuracy) ? payload.accuracy : 20,
      speed: payload.speed, heading: payload.heading, recordedAt: payload.recorded_at || new Date().toISOString(),
      geo: { location_label: payload.location_label, area_name: payload.area_name, city: payload.city, state: payload.state, country: payload.country }
    };
    if (!state.viewer.map) state.viewer.map = new GhostMapController("viewer-map-canvas");
    state.viewer.map.setTargetLocation(state.viewer.targetPos.latitude, state.viewer.targetPos.longitude, state.viewer.targetPos.accuracy, state.viewer.personName);
    if (state.viewer.routeActive && state.viewer.selfPos) maybeRecalculateViewerRoute(false);
    renderViewerState();
  }
}

async function fetchViewerSnapshot() {
  if (!state.viewer.token) return;
  try {
    if (state.supabase && !state.supabaseDbBlocked) {
      const { data, error } = await state.supabase.rpc("get_shared_location", { p_token: state.viewer.token });
      if (!error && data) {
        if (data.status === "invalid") {
          const localMatch = LocalStore.getSharedLocation(state.viewer.token);
          if (localMatch && localMatch.status !== "invalid") return applyViewerLocationPayload(localMatch);
        }
        return applyViewerLocationPayload(data);
      }
      if (error && isDbPermissionOrSchemaError(error)) {
        const sRes = await state.supabase.from("live_sessions").select("*").eq("share_token", state.viewer.token).maybeSingle();
        if (!sRes.error && sRes.data) {
          const sess = sRes.data;
          if (sess.expires_at && Date.parse(sess.expires_at) <= Date.now()) return applyViewerLocationPayload({ status: "expired" });
          if (!sess.is_active || sess.status !== "active") return applyViewerLocationPayload({ status: sess.status === "expired" ? "expired" : "stopped" });
          const lRes = await state.supabase.from("live_locations").select("*").eq("session_id", sess.id).maybeSingle();
          if (!lRes.error && lRes.data) return applyViewerLocationPayload({ status: "active", display_name: "Shared User", expires_at: sess.expires_at, ...lRes.data });
          return applyViewerLocationPayload({ status: "waiting", display_name: "Shared User", expires_at: sess.expires_at });
        }
        state.supabaseDbBlocked = true;
      } else if (error) throw error;
    }
    applyViewerLocationPayload(LocalStore.getSharedLocation(state.viewer.token));
  } catch (err) {
    if (state.viewer.status === "loading") { state.viewer.status = "invalid"; renderViewerState(); }
    showNotification(err.message || "Unable to reach GHOST live session.", "error", "Connection Error", true);
  }
}

function subscribeViewerRealtime(token) {
  if (!state.supabase || !token) return;
  if (state.viewer.channel) state.supabase.removeChannel(state.viewer.channel);
  state.viewer.channel = state.supabase.channel(`ghost-live:${token}`)
    .on("broadcast", { event: "location_update" }, ({ payload }) => applyViewerLocationPayload(payload))
    .on("broadcast", { event: "session_ended" }, ({ payload }) => applyViewerLocationPayload({ status: payload?.status || "stopped" }))
    .subscribe((s) => { if (s === "CHANNEL_ERROR" || s === "TIMED_OUT") updateNetworkBanner(); });
}

async function openViewerForToken(token) {
  teardownViewerSession(); setActiveView("viewer");
  const clean = String(token || "").trim();
  state.viewer.token = clean;
  if (!clean || clean.length < 24) { state.viewer.status = "invalid"; return renderViewerState(); }
  state.viewer.status = "loading"; renderViewerState();
  await fetchViewerSnapshot();
  if (["waiting", "active"].includes(state.viewer.status)) {
    if (state.supabase) subscribeViewerRealtime(clean);
    state.viewer.pollTimer = window.setInterval(() => {
      if (["waiting", "active"].includes(state.viewer.status) && (state.isOnline || !state.supabase)) fetchViewerSnapshot();
    }, APP_CFG.viewerPollIntervalMs);
  }
}

function startViewerOwnLocation(triggerRoute = false) {
  if (!("geolocation" in navigator)) return showNotification("Your browser does not support device geolocation.", "error", "Unavailable", true);
  if (state.viewer.watchId !== null) {
    if (triggerRoute && state.viewer.selfPos) { state.viewer.routeActive = true; maybeRecalculateViewerRoute(true); }
    return;
  }
  state.viewer.watchId = navigator.geolocation.watchPosition(
    (geoPos) => {
      const { latitude, longitude, accuracy } = geoPos.coords;
      state.viewer.selfPos = { latitude, longitude, accuracy: Number.isFinite(accuracy) ? accuracy : 20 };
      if (!state.viewer.map) state.viewer.map = new GhostMapController("viewer-map-canvas");
      state.viewer.map.setSelfLocation(latitude, longitude, state.viewer.selfPos.accuracy);
      if (triggerRoute && !state.viewer.routeActive) { state.viewer.routeActive = true; maybeRecalculateViewerRoute(true); }
      else if (state.viewer.routeActive) maybeRecalculateViewerRoute(false);
      renderViewerState();
    },
    (err) => {
      const m = err.code === 1 ? "Location permission is required to measure distance and routes." : err.code === 2 ? "Your device GPS is currently unavailable." : err.code === 3 ? "Timed out locating your device." : "Unable to read your location.";
      showNotification(m, "error", "Location Error", true);
      if (state.viewer.watchId !== null) { navigator.geolocation.clearWatch(state.viewer.watchId); state.viewer.watchId = null; }
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 4000 }
  );
}

async function maybeRecalculateViewerRoute(force = false) {
  if (!state.viewer.selfPos || !state.viewer.targetPos) return;
  const tMoved = state.viewer.lastRouteTarget ? haversineMeters(state.viewer.lastRouteTarget.latitude, state.viewer.lastRouteTarget.longitude, state.viewer.targetPos.latitude, state.viewer.targetPos.longitude) : Infinity;
  const sMoved = state.viewer.lastRouteSelf ? haversineMeters(state.viewer.lastRouteSelf.latitude, state.viewer.lastRouteSelf.longitude, state.viewer.selfPos.latitude, state.viewer.selfPos.longitude) : Infinity;
  if (!force && tMoved < APP_CFG.routeRecalcMeters && sMoved < APP_CFG.routeRecalcMeters) return;
  if (!force && Date.now() - state.viewer.lastRouteAt < APP_CFG.routeThrottleMs) return;

  state.viewer.lastRouteAt = Date.now();
  hide("viewer-route-error", true);
  try {
    const r = await fetchRoadRoute(state.viewer.selfPos.latitude, state.viewer.selfPos.longitude, state.viewer.targetPos.latitude, state.viewer.targetPos.longitude, state.viewer.routeMode);
    state.viewer.routeMeta = { distanceMeters: r.distanceMeters, durationSeconds: r.durationSeconds };
    state.viewer.lastRouteTarget = { ...state.viewer.targetPos };
    state.viewer.lastRouteSelf = { ...state.viewer.selfPos };
    state.viewer.map?.setRouteCoordinates(r.coordinates);
    renderViewerState();
  } catch {
    state.viewer.routeMeta = null; state.viewer.map?.clearRoute();
    txt("viewer-route-error", "In-app road routing is temporarily unavailable. Use Open in External Maps below.");
    hide("viewer-route-error", false); renderViewerState();
  }
}

// ============================================================================
// 10. SETTINGS & ADMIN CONSOLE
// ============================================================================
function populateSettingsView() {
  if (!state.profile) return;
  $("settings-username").value = getDisplayUsername(state.profile);
  $("settings-default-exp").value = state.profile.default_expiration || "until_stopped";
  $("settings-notifications-toggle").checked = state.profile.notifications_enabled !== false;
  txt("settings-member-since", formatMemberDate(state.profile.created_at));
  txt("settings-perm-text", formatPermissionLabel(state.owner.permissionStatus));
  txt("settings-sharing-status", state.owner.sharingPhase === "live" ? "Sharing live" : state.owner.sharingPhase === "acquiring" ? "Starting..." : "Off");
}

async function loadAdminDashboard() {
  if (state.profile?.role !== "admin") return;
  hide("admin-error-box", true);
  try {
    let stats = {}, users = [];
    if (state.supabase && !state.supabaseDbBlocked) {
      const [sRes, uRes] = await Promise.all([state.supabase.rpc("admin_get_stats"), state.supabase.rpc("admin_list_users")]);
      if (!sRes.error && !uRes.error) {
        stats = sRes.data || {}; users = uRes.data || [];
      } else if (isDbPermissionOrSchemaError(sRes.error) || isDbPermissionOrSchemaError(uRes.error)) {
        state.supabaseDbBlocked = true;
        ({ stats, users } = LocalStore.adminOverview());
      } else throw (sRes.error || uRes.error);
    } else ({ stats, users } = LocalStore.adminOverview());
    state.admin = { stats, users };
    const total = stats.total_accounts ?? 0, sharers = stats.active_sharers ?? 0;
    txt("stat-total-accounts", total); txt("stat-active-sessions", stats.active_links ?? 0);
    txt("stat-active-sharers", sharers); txt("stat-not-sharing", stats.not_sharing_count ?? Math.max(0, total - sharers));
    renderAdminUsers();
  } catch (err) {
    txt("admin-error-box", err.message || "Failed to load admin overview."); hide("admin-error-box", false);
  }
}

function createAdminActionButtons(u, uname, isSelf, isDisabled) {
  const wrap = document.createElement("div");
  wrap.className = "admin-user-card-actions";
  if (u.is_sharing) {
    const rb = document.createElement("button");
    rb.type = "button"; rb.className = "btn btn-danger btn-sm"; rb.textContent = "Revoke";
    rb.addEventListener("click", () => openConfirmModal({ title: "Revoke Live Session?", message: `Stop active location sharing for ${uname} immediately?`, confirmLabel: "Revoke", onConfirm: () => adminRevokeUser(u.id, uname) }));
    wrap.appendChild(rb);
  }
  if (!isSelf) {
    const tb = document.createElement("button");
    tb.type = "button"; tb.className = "btn btn-secondary btn-sm"; tb.textContent = isDisabled ? "Enable" : "Disable";
    tb.addEventListener("click", () => {
      const next = isDisabled ? "active" : "disabled";
      openConfirmModal({ title: isDisabled ? "Enable Account?" : "Disable Account?", message: isDisabled ? `Restore GHOST access for ${uname}?` : `Disable ${uname} and end any active live sessions?`, confirmLabel: isDisabled ? "Enable" : "Disable", onConfirm: () => adminToggleAccount(u.id, next, uname) });
    });
    wrap.appendChild(tb);
  }
  return wrap;
}

function renderAdminUsers() {
  const tbody = $("admin-users-tbody"), cards = $("admin-users-cards");
  if (!tbody || !cards) return;
  tbody.innerHTML = ""; cards.innerHTML = "";
  if (!state.admin.users.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="muted-copy">No registered accounts found.</td></tr>`;
    cards.innerHTML = `<div class="muted-copy">No registered accounts found.</div>`;
    return;
  }
  for (const u of state.admin.users) {
    const uname = getDisplayUsername(u), isSelf = state.user && u.id === state.user.id, isDis = u.account_status === "disabled";
    const reg = formatMemberDate(u.created_at), seen = formatRelativeTime(u.last_seen_at);
    const tr = document.createElement("tr");
    tr.innerHTML = `<td><strong>${escapeHtml(uname)}</strong>${u.role === "admin" ? '<div class="muted-copy" style="font-size:0.74rem">Admin</div>' : ""}</td><td><span class="status-tag ${isDis ? "is-ended" : "is-live"}"><span class="status-tag-dot" aria-hidden="true"></span>${isDis ? "Disabled" : "Active"}</span></td><td><span class="status-tag ${u.is_sharing ? "is-live" : "is-off"}"><span class="status-tag-dot" aria-hidden="true"></span>${u.is_sharing ? "Sharing" : "Not sharing"}</span></td><td class="tabular-nums muted-copy">${escapeHtml(reg)}</td><td class="tabular-nums muted-copy">${escapeHtml(seen)}</td><td></td>`;
    tr.lastElementChild.appendChild(createAdminActionButtons(u, uname, isSelf, isDis));
    tbody.appendChild(tr);

    const card = document.createElement("div");
    card.className = "admin-user-card";
    card.innerHTML = `<div class="admin-user-card-head"><div><strong>${escapeHtml(uname)}</strong>${u.role === "admin" ? '<div class="muted-copy" style="font-size:0.75rem">Admin</div>' : ""}</div><span class="status-tag ${u.is_sharing ? "is-live" : "is-off"}"><span class="status-tag-dot" aria-hidden="true"></span>${u.is_sharing ? "Sharing" : "Not sharing"}</span></div><div class="telemetry-rows"><div class="telemetry-row"><span class="telemetry-label">Account</span><span class="telemetry-value">${isDis ? "Disabled" : "Active"}</span></div><div class="telemetry-row"><span class="telemetry-label">Registered</span><span class="telemetry-value tabular-nums">${escapeHtml(reg)}</span></div><div class="telemetry-row"><span class="telemetry-label">Last seen</span><span class="telemetry-value tabular-nums">${escapeHtml(seen)}</span></div></div>`;
    card.appendChild(createAdminActionButtons(u, uname, isSelf, isDis));
    cards.appendChild(card);
  }
}

async function adminToggleAccount(targetId, newStatus, name) {
  try {
    if (state.supabase && !state.supabaseDbBlocked) { const { error } = await state.supabase.rpc("admin_set_account_status", { p_target_user_id: targetId, p_new_status: newStatus }); if (error) throw error; }
    else LocalStore.adminSetStatus(targetId, newStatus);
    showNotification(`${name} is now ${newStatus}.`, "success", "Updated", true);
    await loadAdminDashboard();
  } catch (err) { showNotification(err.message || "Failed to update account status.", "error", "Error", true); }
}

async function adminRevokeUser(targetId, name) {
  try {
    if (state.supabase && !state.supabaseDbBlocked) { const { error } = await state.supabase.rpc("admin_revoke_user_sessions", { p_target_user_id: targetId }); if (error) throw error; }
    else LocalStore.stopOwnerSession(targetId, null);
    showNotification(`Ended active sharing for ${name}.`, "success", "Session Revoked", true);
    await loadAdminDashboard();
  } catch (err) { showNotification(err.message || "Failed to revoke sharing session.", "error", "Error", true); }
}

// ============================================================================
// 11. PWA SUPPORT & EVENT WIRING
// ============================================================================
function initPwaSupport() {
  const canSw = location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1";
  if (canSw && "serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => undefined);
  const standalone = window.matchMedia?.("(display-mode: standalone)")?.matches || window.navigator.standalone === true;
  const isIos = /iphone|ipad|ipod/i.test(window.navigator.userAgent);
  let dismissed = false;
  try { dismissed = window.localStorage.getItem(LS_KEYS.pwaDismissed) === "1"; } catch {}
  if (isIos && !standalone) hide("settings-pwa-ios-note", false);

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); state.deferredInstallPrompt = e;
    if (!standalone) { hide("settings-pwa-install-row", false); if (!dismissed) hide("pwa-install-card", false); }
  });
  window.addEventListener("appinstalled", () => {
    state.deferredInstallPrompt = null; hide("pwa-install-card", true); hide("settings-pwa-install-row", true);
    showNotification("GHOST has been installed.", "success", "Installed", true);
  });
}

function wireEvents() {
  document.querySelectorAll("[data-toggle-password]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const inp = $(btn.getAttribute("data-toggle-password")); if (!inp) return;
      const showPwd = inp.type !== "text";
      inp.type = showPwd ? "text" : "password";
      btn.setAttribute("aria-pressed", showPwd ? "true" : "false");
      btn.setAttribute("aria-label", showPwd ? "Hide password" : "Show password");
      btn.querySelector(".icon-eye")?.classList.toggle("hidden", showPwd);
      btn.querySelector(".icon-eye-off")?.classList.toggle("hidden", !showPwd);
    });
  });

  on("go-register-btn", "click", () => switchAuthPanel("register"));
  on("go-login-btn", "click", () => switchAuthPanel("login"));

  on("form-login", "submit", async (e) => {
    e.preventDefault();
    const u = String($("login-username").value || "").trim(), p = $("login-password").value;
    if (!u) return showNotification("Please enter your username.", "error", "Missing Username", true);
    if (!p) return showNotification("Please enter your password.", "error", "Missing Password", true);
    const btn = $("login-submit-btn"); btn.disabled = true; btn.textContent = "Signing in...";
    state._manualAuthInFlight = true;
    try {
      const sess = state.supabase
        ? ((r) => { if (r.error) throw r.error; return r.data.session; })(await state.supabase.auth.signInWithPassword({ email: syntheticEmail(u), password: p }))
        : await LocalStore.login(u, p);
      const ok = await handleAuthenticatedSession(sess, { navigate: true, rethrow: true });
      if (ok) {
        $("login-password").value = "";
        showNotification("Signed in to GHOST.", "success", "Welcome Back", true);
      }
    } catch (err) {
      showNotification(err.message || "Incorrect username or password.", "error", "Sign In Failed", true);
    } finally { state._manualAuthInFlight = false; btn.disabled = false; btn.textContent = "Log In"; }
  });

  on("form-register", "submit", async (e) => {
    e.preventDefault();
    const c = validateRegistrationFields($("reg-username").value, $("reg-password").value, $("reg-confirm-password").value);
    if (!c.ok) return showNotification(c.error, "error", "Check Your Details", true);
    const btn = $("register-submit-btn"); btn.disabled = true; btn.textContent = "Creating account...";
    state._manualAuthInFlight = true;
    try {
      let sess = null;
      if (state.supabase) {
        const { data, error } = await state.supabase.auth.signUp({ email: syntheticEmail(c.username), password: c.password, options: { data: { username: c.username } } });
        if (error) {
          const em = String(error.message || "").toLowerCase();
          if (em.includes("already registered")) throw new Error("This username is already registered. Please sign in instead.");
          throw error;
        }
        sess = data.session;
        if (data.user && !sess) {
          const signInRes = await state.supabase.auth.signInWithPassword({ email: syntheticEmail(c.username), password: c.password }).catch(() => null);
          if (signInRes?.data?.session) sess = signInRes.data.session;
          else throw new Error("Account created, but email confirmation is enabled on your Supabase project. Disable Confirm Email in Supabase Auth or check email to sign in.");
        }
        if (data.user && sess && !state.supabaseProfileBlocked) {
          const up = await state.supabase.from("profiles").upsert({ id: data.user.id, username: c.username, display_name: c.username, role: "user", account_status: "active", default_expiration: "until_stopped", notifications_enabled: true }, { onConflict: "id" });
          if (up.error && isDbPermissionOrSchemaError(up.error)) state.supabaseProfileBlocked = true;
        }
      } else {
        sess = await LocalStore.register(c.username, c.password);
      }
      const ok = await handleAuthenticatedSession(sess, { navigate: true, rethrow: true });
      if (ok) {
        $("reg-password").value = ""; $("reg-confirm-password").value = "";
        showNotification("Your account has been created successfully.", "success", "Account Created", true);
      }
    } catch (err) {
      showNotification(err.message || "Could not create account.", "error", "Registration Failed", true);
    } finally { state._manualAuthInFlight = false; btn.disabled = false; btn.textContent = "Create Account"; }
  });

  document.querySelectorAll("[data-nav]").forEach((b) => {
    b.addEventListener("click", () => {
      const t = b.getAttribute("data-nav");
      if (t === "home") setActiveView("dashboard", "home");
      else if (t === "map") setActiveView("dashboard", "map");
      else if (t === "settings") { populateSettingsView(); setActiveView("settings"); }
      else if (t === "admin" && state.profile?.role === "admin") { setActiveView("admin"); loadAdminDashboard(); }
    });
  });

  on("top-profile-btn", "click", () => { populateSettingsView(); setActiveView("settings"); });
  on("brand-home-link", "click", (e) => { e.preventDefault(); setActiveView(state.user && state.profile ? "dashboard" : "auth", "home"); });

  const confirmStop = () => openConfirmModal({ title: "Stop Live Sharing?", message: "Your private live link will stop immediately and your location will no longer be visible.", confirmLabel: "Stop Sharing", onConfirm: () => stopOwnerSharing(true) });
  on("btn-start-sharing", "click", () => openModal("modal-start-sharing"));
  on("owner-map-toggle-share-btn", "click", () => (state.owner.sharingPhase === "offline" ? openModal("modal-start-sharing") : confirmStop()));
  on("confirm-start-sharing-btn", "click", () => { const p = $("share-expiration-select").value; closeModal("modal-start-sharing"); beginLocationWatch(p); });
  on("btn-stop-sharing", "click", confirmStop);
  on("btn-open-shared-link", "click", () => openModal("modal-open-link"));
  on("viewer-try-another-btn", "click", () => openModal("modal-open-link"));
  on("owner-recenter-btn", "click", () => state.owner.map?.recenterOnTarget());

  on("btn-copy-link", "click", async () => {
    if (!state.owner.session) return;
    try { await navigator.clipboard.writeText(buildShareUrl(state.owner.session.share_token)); showNotification("Your live location link has been copied.", "success", "Link Copied", true); }
    catch { showNotification("Select and copy the link manually from the box above.", "info", "Copy Link", true); }
  });

  on("btn-share-link", "click", async () => {
    if (!state.owner.session) return;
    const url = buildShareUrl(state.owner.session.share_token);
    if (navigator.share) {
      try { await navigator.share({ title: "GHOST — Live Location", text: "View my live location privately on GHOST.", url }); return; }
      catch (err) { if (err?.name === "AbortError") return; }
    }
    $("btn-copy-link").click();
  });

  on("form-open-link", "submit", (e) => {
    e.preventDefault();
    const token = extractLiveTokenFromInput($("input-live-link").value);
    $("input-live-link").value = "";
    closeModal("modal-open-link");
    if (!token) return openViewerForToken("invalid");
    const u = new URL(window.location.href); u.searchParams.set("live", token); safePushUrl(u.toString());
    openViewerForToken(token);
  });

  const exitViewer = async () => {
    teardownViewerSession();
    const u = new URL(window.location.href); u.searchParams.delete("live"); safePushUrl(u.toString());
    if (state.user && state.profile) {
      setActiveView("dashboard", "home");
      await restoreOwnerActiveSession();
      await syncBrowserPermissionState();
    } else {
      setActiveView("auth", "home");
    }
  };
  on("viewer-exit-btn", "click", exitViewer);
  on("viewer-back-home-btn", "click", exitViewer);

  on("btn-use-my-location", "click", () => {
    if (state.viewer.selfPos) return state.viewer.map?.fitBoth();
    state.viewer._pendingRouteRequest = false; openModal("modal-viewer-permission");
  });
  on("btn-meet-me", "click", () => {
    if (!state.viewer.selfPos) { state.viewer._pendingRouteRequest = true; return openModal("modal-viewer-permission"); }
    state.viewer.routeActive = true; maybeRecalculateViewerRoute(true); renderViewerState();
  });
  on("confirm-viewer-location-btn", "click", () => { closeModal("modal-viewer-permission"); startViewerOwnLocation(Boolean(state.viewer._pendingRouteRequest)); });
  on("route-mode-driving", "click", () => { state.viewer.routeMode = "driving"; state.viewer.routeActive = true; maybeRecalculateViewerRoute(true); renderViewerState(); });
  on("route-mode-walking", "click", () => { state.viewer.routeMode = "walking"; state.viewer.routeActive = true; maybeRecalculateViewerRoute(true); renderViewerState(); });
  on("viewer-recenter-btn", "click", () => state.viewer.map?.recenterOnTarget());
  on("viewer-fit-both-btn", "click", () => state.viewer.map?.fitBoth());

  on("form-settings-account", "submit", async (e) => {
    e.preventDefault(); if (!state.user) return;
    const c = validateUsername($("settings-username").value);
    if (!c.ok) return showNotification(c.error, "error", "Invalid Username", true);
    const btn = $("settings-save-account-btn"); btn.disabled = true; btn.textContent = "Updating...";
    try {
      let data = null;
      if (state.supabase) {
        if (!state.supabaseProfileBlocked) {
          const res = await state.supabase.from("profiles").update({ username: c.value, display_name: c.value }).eq("id", state.user.id).select("*").maybeSingle();
          if (res.error) {
            if (isDbPermissionOrSchemaError(res.error)) state.supabaseProfileBlocked = true;
            else throw new Error(res.error.code === "23505" || String(res.error.message).toLowerCase().includes("duplicate") ? "This username is already taken." : res.error.message);
          } else data = res.data;
        }
        if (!data) {
          await state.supabase.auth.updateUser({ data: { username: c.value, display_name: c.value } }).catch(() => undefined);
          writeSupabaseProfileCache(state.user.id, { username: c.value, display_name: c.value });
          data = { ...state.profile, username: c.value, display_name: c.value };
        } else writeSupabaseProfileCache(state.user.id, data);
      } else data = LocalStore.updateProfile(state.user.id, { username: c.value, display_name: c.value });
      state.profile = data; updateNavigationUI(); populateSettingsView();
      showNotification("Your username has been updated.", "success", "Account Updated", true);
    } catch (err) { showNotification(err.message || "Could not update username.", "error", "Update Failed", true); }
    finally { btn.disabled = false; btn.textContent = "Update Username"; }
  });

  on("form-settings-prefs", "submit", async (e) => {
    e.preventDefault(); if (!state.user) return;
    const btn = $("settings-save-prefs-btn"); btn.disabled = true; btn.textContent = "Saving...";
    try {
      const default_expiration = $("settings-default-exp").value, notifications_enabled = $("settings-notifications-toggle").checked;
      let data = null;
      if (state.supabase) {
        if (!state.supabaseProfileBlocked) {
          const res = await state.supabase.from("profiles").update({ default_expiration, notifications_enabled }).eq("id", state.user.id).select("*").maybeSingle();
          if (res.error) {
            if (isDbPermissionOrSchemaError(res.error)) state.supabaseProfileBlocked = true;
            else throw res.error;
          } else data = res.data;
        }
        if (!data) {
          writeSupabaseProfileCache(state.user.id, { default_expiration, notifications_enabled });
          data = { ...state.profile, default_expiration, notifications_enabled };
        } else writeSupabaseProfileCache(state.user.id, data);
      } else data = LocalStore.updateProfile(state.user.id, { default_expiration, notifications_enabled });
      state.profile = data; state.notificationsEnabled = notifications_enabled;
      $("share-expiration-select").value = data.default_expiration;
      showNotification("Your preferences have been saved.", "success", "Preferences Saved", true);
    } catch (err) { showNotification(err.message || "Could not save preferences.", "error", "Save Failed", true); }
    finally { btn.disabled = false; btn.textContent = "Save Preferences"; }
  });

  on("btn-settings-logout", "click", async () => {
    await stopOwnerSharing(false);
    if (state.supabase) await state.supabase.auth.signOut().catch(() => undefined); else LocalStore.signOut();
    state.user = state.profile = null; state.supabaseProfileBlocked = state.supabaseDbBlocked = false;
    ["login-password", "reg-password", "reg-confirm-password"].forEach((id) => { const inp = $(id); if (inp) inp.value = ""; });
    switchAuthPanel("login"); setActiveView("auth");
    showNotification("You have signed out of GHOST.", "info", "Signed Out", true);
  });

  on("admin-refresh-btn", "click", loadAdminDashboard);

  const installApp = async () => {
    if (!state.deferredInstallPrompt) return;
    await state.deferredInstallPrompt.prompt();
    const ch = await state.deferredInstallPrompt.userChoice;
    if (ch?.outcome === "accepted") { hide("pwa-install-card", true); hide("settings-pwa-install-row", true); }
    state.deferredInstallPrompt = null;
  };
  on("btn-pwa-install", "click", installApp);
  on("settings-pwa-install-btn", "click", installApp);
  on("btn-pwa-dismiss", "click", () => { try { window.localStorage.setItem(LS_KEYS.pwaDismissed, "1"); } catch {} hide("pwa-install-card", true); });

  on("confirm-modal-ok-btn", "click", async () => { const fn = state.confirmAction; closeModal("modal-confirm"); if (typeof fn === "function") await fn(); });
  on("confirm-modal-cancel-btn", "click", () => closeModal("modal-confirm"));
  on("confirm-modal-close-x", "click", () => closeModal("modal-confirm"));
  document.querySelectorAll("[data-close-modal]").forEach((b) => b.addEventListener("click", () => closeModal(b.getAttribute("data-close-modal"))));
  document.querySelectorAll(".modal-backdrop").forEach((b) => b.addEventListener("click", (e) => { if (e.target === b) closeModal(b.id); }));
  window.addEventListener("keydown", (e) => { if (e.key === "Escape") document.querySelectorAll(".modal-backdrop:not(.hidden)").forEach((m) => closeModal(m.id)); });

  window.addEventListener("online", () => {
    state.isOnline = true; updateNetworkBanner();
    if (state.owner.sharingPhase === "live" && state.owner.lastPosition) {
      if (state.owner.session && state.supabase) joinOwnerBroadcastChannel(state.owner.session.share_token);
      syncOwnerLocationToBackend(state.owner.lastPosition, false);
    }
    if (state.activeView === "viewer" && state.viewer.token) {
      if (state.supabase) subscribeViewerRealtime(state.viewer.token);
      fetchViewerSnapshot();
    }
    showNotification("Your internet connection is back.", "success", "Reconnected", true);
  });

  window.addEventListener("offline", () => {
    state.isOnline = false; updateNetworkBanner();
    if (state.owner.sharingPhase === "live") renderOwnerDashboardState();
    if (state.activeView === "viewer") renderViewerState();
    showNotification("Connection lost. Waiting to reconnect.", "warning", "Offline", true);
  });

  window.addEventListener("popstate", () => {
    const token = new URLSearchParams(window.location.search).get("live");
    if (token) openViewerForToken(token);
    else { teardownViewerSession(); setActiveView(state.user && state.profile ? "dashboard" : "auth", "home"); }
  });

  if ("BroadcastChannel" in globalThis) {
    try {
      state.localBc = new BroadcastChannel("ghost-live-sync");
      state.localBc.onmessage = (ev) => {
        const msg = ev.data;
        if (msg && state.activeView === "viewer" && state.viewer.token && msg.payload?.token === state.viewer.token) applyViewerLocationPayload(msg.payload);
      };
    } catch {}
  }

  window.addEventListener("storage", (e) => {
    if (state.activeView === "viewer" && state.viewer.token && (e.key === LS_KEYS.locations || e.key === LS_KEYS.sessions)) fetchViewerSnapshot();
  });
}

function startLiveTicker() {
  if (state.tickerId) window.clearInterval(state.tickerId);
  state.tickerId = window.setInterval(() => {
    if (state.activeView === "dashboard" && state.owner.sharingPhase === "live") renderOwnerDashboardState();
    if (state.activeView === "viewer" && state.viewer.status === "active") renderViewerState();
    if (!state.isOnline) updateNetworkBanner();
  }, 1000);
}

async function initializeAppState() {
  state.configured = isSupabaseConfigured();
  if (state.configured && globalThis.supabase?.createClient) {
    state.supabase = globalThis.supabase.createClient(SUPABASE_CFG.url, SUPABASE_CFG.anonKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } });
    state.supabase.auth.onAuthStateChange(async (event, sess) => {
      if (event === "INITIAL_SESSION" || state._manualAuthInFlight) return;
      if (event === "SIGNED_OUT") return await handleAuthenticatedSession(null);
      if (sess?.user) await handleAuthenticatedSession(sess, { navigate: event === "SIGNED_IN" && state.activeView === "auth" });
    });
  }
  const liveToken = new URLSearchParams(window.location.search).get("live");
  try {
    const sess = state.supabase ? (await state.supabase.auth.getSession()).data?.session : await LocalStore.getSession();
    if (liveToken) {
      if (sess?.user) { state.user = sess.user; await loadUserProfile().catch(() => null); }
      await openViewerForToken(liveToken);
    } else if (sess || (!state._manualAuthInFlight && !state.user)) {
      await handleAuthenticatedSession(sess);
    }
  } catch { setActiveView(liveToken ? "viewer" : "auth"); }
}

function hideBootScreen() {
  const boot = $("boot-screen");
  if (!boot || boot.classList.contains("is-leaving")) return;
  boot.classList.add("is-leaving");
  window.setTimeout(() => boot.classList.add("hidden"), 320);
}

async function bootstrap() {
  const failsafe = window.setTimeout(hideBootScreen, 2500);
  try {
    wireEvents(); initPwaSupport(); startLiveTicker(); updateNetworkBanner();
    await Promise.all([initializeAppState(), new Promise((r) => window.setTimeout(r, APP_CFG.minBootDurationMs || 1200))]);
  } catch (err) {
    console.error("GHOST initialization error:", err); setActiveView("auth");
  } finally { window.clearTimeout(failsafe); hideBootScreen(); }
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bootstrap);
  else bootstrap();
}
