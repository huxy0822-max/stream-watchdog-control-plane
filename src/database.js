import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  createId,
  decryptText,
  encryptText,
  hashPassword,
  hashSessionToken,
  issueSessionToken,
  verifyPassword
} from "./security.js";

function nowIso() {
  return new Date().toISOString();
}

function ensureParentDirectory(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function parseJson(value, fallback) {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function toBoolean(value) {
  if (typeof value === "boolean") {
    return value;
  }

  return Number(value) === 1 || String(value).toLowerCase() === "true";
}

function normalizeGroupName(value) {
  return String(value ?? "").trim() || "Default";
}

function normalizeTenantSlug(value, fallback = "") {
  const raw = String(value ?? "").trim() || String(fallback ?? "").trim();
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

function resolveTenantSlug(value, fallback = "", existing = "") {
  return normalizeTenantSlug(value)
    || normalizeTenantSlug(existing)
    || normalizeTenantSlug("", fallback)
    || createId("workspace").replace(/_/g, "-");
}

function normalizeStreamKey(value) {
  return String(value ?? "")
    .trim()
    .replace(/^rtmp:\/\/[^/]+\/live2\//i, "")
    .replace(/^live2\//i, "")
    .trim();
}

function normalizeMediaPath(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    return "";
  }

  return normalized.includes("/") ? normalized : `/root/${normalized}`;
}

function shellSingleQuote(value) {
  return `'${String(value ?? "").replace(/'/g, `'\\''`)}'`;
}

function buildManagedRestartCommand(sourcePath, streamKey) {
  const normalizedSource = normalizeMediaPath(sourcePath);
  const normalizedKey = normalizeStreamKey(streamKey);
  if (!normalizedSource || !normalizedKey) {
    return "";
  }

  const rtmpUrl = `rtmp://a.rtmp.youtube.com/live2/${normalizedKey}`;
  return `nohup ffmpeg -stream_loop -1 -re -i ${shellSingleQuote(normalizedSource)} -c:v copy -c:a copy -f flv ${shellSingleQuote(rtmpUrl)} > /dev/null 2>&1 &`;
}

function buildManagedMatchTerms(sourcePath, streamKey) {
  return [...new Set([
    normalizeStreamKey(streamKey),
    normalizeMediaPath(sourcePath)
  ].filter(Boolean))];
}

const SELF_SERVICE_SIGNUP_DEFAULTS = Object.freeze({
  maxUsers: 1,
  maxServers: 3,
  maxStreams: 20,
  notes: "Self-service signup"
});

function unquoteShellToken(value) {
  const text = String(value ?? "").trim();
  if (
    (text.startsWith("'") && text.endsWith("'")) ||
    (text.startsWith('"') && text.endsWith('"'))
  ) {
    return text.slice(1, -1);
  }

  return text;
}

function parseManagedStreamFields(...commands) {
  for (const command of commands) {
    const text = String(command ?? "").trim();
    if (!text) {
      continue;
    }

    const sourceMatch = text.match(/(?:^|\s)-i\s+('(?:[^']|\\')*'|"(?:[^"\\]|\\.)*"|\S+)/);
    const streamKeyMatch = text.match(/rtmp:\/\/[^/\s'"]+\/live2\/([A-Za-z0-9-]+)/i);
    const sourcePath = sourceMatch ? normalizeMediaPath(unquoteShellToken(sourceMatch[1])) : "";
    const streamKey = streamKeyMatch ? normalizeStreamKey(streamKeyMatch[1]) : "";

    if (sourcePath || streamKey) {
      return { sourcePath, streamKey };
    }
  }

  return { sourcePath: "", streamKey: "" };
}

function isExpired(expiresAt) {
  if (!expiresAt) {
    return false;
  }

  const timestamp = Date.parse(expiresAt);
  return Number.isFinite(timestamp) && timestamp <= Date.now();
}

function generateRedeemCodeValue() {
  return createId("cdk")
    .replace(/^cdk-/, "")
    .replace(/-/g, "")
    .slice(0, 12)
    .toUpperCase();
}

function normalizeRedeemCodeValue(value) {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function parseLegacyJson(filePath) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(resolved, "utf8"));
}

function resolveLegacyServerPassword(server) {
  if (server.password) {
    return server.password;
  }

  if (server.passwordEnv && process.env[server.passwordEnv]) {
    return process.env[server.passwordEnv];
  }

  return "";
}

function resolveLegacyNotificationSettings(rawNotifications) {
  const email = rawNotifications?.email;
  if (!email) {
    return null;
  }

  return {
    enabled: toBoolean(email.enabled ?? false),
    smtpHost: email.smtpHostEnv ? process.env[email.smtpHostEnv] : email.smtpHost,
    smtpPort: Number(email.smtpPortEnv ? process.env[email.smtpPortEnv] : email.smtpPort ?? 587),
    smtpSecure: toBoolean(email.smtpSecureEnv ? process.env[email.smtpSecureEnv] : email.smtpSecure ?? false),
    smtpUser: email.smtpUserEnv ? process.env[email.smtpUserEnv] : email.smtpUser,
    smtpPass: email.smtpPassEnv ? process.env[email.smtpPassEnv] : email.smtpPass,
    fromAddress: email.fromEnv ? process.env[email.fromEnv] : email.from,
    toAddresses: email.to ?? []
  };
}

function tenantScopeClause(actor, columnName = "tenant_id") {
  if (!actor || actor.role === "super_admin") {
    return {
      where: "",
      params: []
    };
  }

  return {
    where: `WHERE ${columnName} = ?`,
    params: [actor.tenantId]
  };
}

export class AppDatabase {
  constructor(options, masterKey, logger) {
    this.options = options;
    this.masterKey = masterKey;
    this.logger = logger;
    this.dbPath = path.resolve(options.dbPath);
    ensureParentDirectory(this.dbPath);
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.prepareSchema();
    this.runMigrations();
    this.seedDefaults();
    this.importLegacyConfigIfNeeded();
    this.ensureDefaultTenantForLegacyData();
    this.syncServerGroupsFromServers();
  }

  prepareSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS app_users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'admin',
        tenant_id TEXT REFERENCES tenants(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_login_at TEXT
      );

      CREATE TABLE IF NOT EXISTS app_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runtime_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        panel_title TEXT NOT NULL,
        public_base_url TEXT,
        poll_interval_seconds INTEGER NOT NULL,
        connection_timeout_seconds INTEGER NOT NULL,
        default_verify_delay_seconds INTEGER NOT NULL,
        session_ttl_hours INTEGER NOT NULL,
        event_retention_count INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS notification_email_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        enabled INTEGER NOT NULL,
        smtp_host TEXT,
        smtp_port INTEGER,
        smtp_secure INTEGER NOT NULL,
        smtp_user TEXT,
        smtp_pass_enc TEXT,
        from_address TEXT,
        to_addresses TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tenants (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'active',
        expires_at TEXT,
        max_users INTEGER NOT NULL DEFAULT 1,
        max_servers INTEGER NOT NULL DEFAULT 20,
        max_streams INTEGER NOT NULL DEFAULT 200,
        notes TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS server_groups (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        notes TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (tenant_id, name)
      );

      CREATE TABLE IF NOT EXISTS server_configs (
        id TEXT PRIMARY KEY,
        tenant_id TEXT REFERENCES tenants(id) ON DELETE CASCADE,
        group_name TEXT NOT NULL DEFAULT 'Default',
        label TEXT NOT NULL,
        host TEXT NOT NULL,
        port INTEGER NOT NULL,
        username TEXT NOT NULL,
        password_enc TEXT,
        enabled INTEGER NOT NULL,
        notes TEXT,
        connection_status TEXT NOT NULL DEFAULT 'unknown',
        last_error TEXT,
        last_checked_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS stream_configs (
        id TEXT PRIMARY KEY,
        tenant_id TEXT REFERENCES tenants(id) ON DELETE CASCADE,
        server_id TEXT NOT NULL REFERENCES server_configs(id) ON DELETE CASCADE,
        label TEXT NOT NULL,
        match_terms_json TEXT NOT NULL,
        restart_command TEXT,
        restart_log_path TEXT,
        discovered_command_enc TEXT,
        cooldown_seconds INTEGER NOT NULL,
        restart_window_seconds INTEGER NOT NULL,
        max_restarts_in_window INTEGER NOT NULL,
        verify_delay_seconds INTEGER,
        enabled INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'unknown',
        last_seen_at TEXT,
        last_restart_at TEXT,
        restart_history_json TEXT NOT NULL DEFAULT '[]',
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS app_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        level TEXT NOT NULL,
        type TEXT NOT NULL,
        message TEXT NOT NULL,
        context_json TEXT
      );

      CREATE TABLE IF NOT EXISTS app_meta (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS redeem_codes (
        id TEXT PRIMARY KEY,
        code TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        duration_days INTEGER NOT NULL,
        max_users INTEGER NOT NULL DEFAULT 1,
        max_servers INTEGER NOT NULL DEFAULT 20,
        max_streams INTEGER NOT NULL DEFAULT 200,
        status TEXT NOT NULL DEFAULT 'unused',
        tenant_id TEXT REFERENCES tenants(id) ON DELETE SET NULL,
        redeemed_by_user_id TEXT REFERENCES app_users(id) ON DELETE SET NULL,
        redeemed_at TEXT,
        notes TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  columnExists(tableName, columnName) {
    return this.db.prepare(`PRAGMA table_info(${tableName})`).all()
      .some((row) => row.name === columnName);
  }

  runMigrations() {
    if (!this.columnExists("app_users", "tenant_id")) {
      this.db.exec("ALTER TABLE app_users ADD COLUMN tenant_id TEXT REFERENCES tenants(id) ON DELETE SET NULL;");
    }

    if (!this.columnExists("server_configs", "tenant_id")) {
      this.db.exec("ALTER TABLE server_configs ADD COLUMN tenant_id TEXT REFERENCES tenants(id) ON DELETE CASCADE;");
    }

    if (!this.columnExists("server_configs", "group_name")) {
      this.db.exec("ALTER TABLE server_configs ADD COLUMN group_name TEXT NOT NULL DEFAULT 'Default';");
    }

    if (!this.columnExists("stream_configs", "tenant_id")) {
      this.db.exec("ALTER TABLE stream_configs ADD COLUMN tenant_id TEXT REFERENCES tenants(id) ON DELETE CASCADE;");
    }
  }

  seedDefaults() {
    const now = nowIso();
    this.db.prepare(`
      INSERT OR IGNORE INTO runtime_settings (
        id,
        panel_title,
        public_base_url,
        poll_interval_seconds,
        connection_timeout_seconds,
        default_verify_delay_seconds,
        session_ttl_hours,
        event_retention_count,
        updated_at
      ) VALUES (1, 'Stream Watchdog', '', 20, 15, 8, 168, 500, ?)
    `).run(now);

    this.db.prepare(`
      INSERT OR IGNORE INTO notification_email_settings (
        id,
        enabled,
        smtp_host,
        smtp_port,
        smtp_secure,
        smtp_user,
        smtp_pass_enc,
        from_address,
        to_addresses,
        updated_at
      ) VALUES (1, 0, '', 587, 0, '', '', '', '[]', ?)
    `).run(now);

    this.setMonitorMeta({
      startedAt: null,
      lastCycleAt: null,
      lastCycleDurationMs: null,
      lastCycleReason: null,
      isBusy: false
    }, true);
  }

  importLegacyConfigIfNeeded() {
    const hasServers = this.db.prepare("SELECT COUNT(*) AS count FROM server_configs").get().count > 0;
    const hasStreams = this.db.prepare("SELECT COUNT(*) AS count FROM stream_configs").get().count > 0;
    if (hasServers || hasStreams) {
      return;
    }

    const legacyConfig = parseLegacyJson(this.options.legacyConfigPath);
    if (!legacyConfig) {
      return;
    }

    const legacyState = parseLegacyJson(this.options.legacyStatePath) ?? { streams: {}, servers: {} };
    const now = nowIso();

    this.updateRuntimeSettings({
      panelTitle: "Stream Watchdog",
      publicBaseUrl: "",
      pollIntervalSeconds: legacyConfig.pollIntervalSeconds ?? 20,
      connectionTimeoutSeconds: legacyConfig.connectionTimeoutSeconds ?? 15,
      defaultVerifyDelaySeconds: legacyConfig.verifyDelaySeconds ?? 8,
      sessionTtlHours: 168,
      eventRetentionCount: 500
    });

    const emailSettings = resolveLegacyNotificationSettings(legacyConfig.notifications);
    if (emailSettings) {
      this.updateEmailSettings(emailSettings);
    }

    const insertServer = this.db.prepare(`
      INSERT INTO server_configs (
        id,
        group_name,
        label,
        host,
        port,
        username,
        password_enc,
        enabled,
        notes,
        connection_status,
        last_error,
        last_checked_at,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
    `);

    for (const server of legacyConfig.servers ?? []) {
      const runtime = legacyState.servers?.[server.id] ?? {};
      insertServer.run(
        server.id,
        server.groupName ?? "Default",
        server.label ?? server.host,
        server.host,
        Number(server.port ?? 22),
        server.username,
        encryptText(resolveLegacyServerPassword(server), this.masterKey) ?? "",
        server.notes ?? "",
        runtime.connectionStatus ?? "unknown",
        runtime.lastError ?? null,
        runtime.lastCheckedAt ?? null,
        now,
        now
      );
    }

    const insertStream = this.db.prepare(`
      INSERT INTO stream_configs (
        id,
        server_id,
        label,
        match_terms_json,
        restart_command,
        restart_log_path,
        discovered_command_enc,
        cooldown_seconds,
        restart_window_seconds,
        max_restarts_in_window,
        verify_delay_seconds,
        enabled,
        status,
        last_seen_at,
        last_restart_at,
        restart_history_json,
        last_error,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const stream of legacyConfig.streams ?? []) {
      const runtime = legacyState.streams?.[stream.id] ?? {};
      insertStream.run(
        stream.id,
        stream.serverId,
        stream.label ?? stream.id,
        JSON.stringify(stream.matchTerms ?? []),
        stream.restartCommand ?? "",
        stream.restartLogPath ?? "",
        encryptText(runtime.discoveredCommand ?? "", this.masterKey) ?? "",
        Number(stream.cooldownSeconds ?? 60),
        Number(stream.restartWindowSeconds ?? 300),
        Number(stream.maxRestartsInWindow ?? 3),
        Number(stream.verifyDelaySeconds ?? legacyConfig.verifyDelaySeconds ?? 8),
        runtime.status ?? "unknown",
        runtime.lastSeenAt ?? null,
        runtime.lastRestartAt ?? null,
        JSON.stringify(runtime.restartHistory ?? []),
        runtime.lastError ?? null,
        now,
        now
      );
    }

    this.addEvent("info", "bootstrap.import_legacy", "Imported legacy JSON configuration into SQLite.", {
      serverCount: legacyConfig.servers?.length ?? 0,
      streamCount: legacyConfig.streams?.length ?? 0
    });
  }

  ensureDefaultTenantForLegacyData() {
    const tenantCount = this.db.prepare("SELECT COUNT(*) AS count FROM tenants").get().count;
    const orphanedServers = this.db.prepare("SELECT COUNT(*) AS count FROM server_configs WHERE tenant_id IS NULL").get().count;
    const orphanedStreams = this.db.prepare("SELECT COUNT(*) AS count FROM stream_configs WHERE tenant_id IS NULL").get().count;

    if (tenantCount > 0 && orphanedServers === 0 && orphanedStreams === 0) {
      return;
    }

    const now = nowIso();
    let tenant = this.db.prepare("SELECT id FROM tenants ORDER BY created_at ASC LIMIT 1").get();
    if (!tenant) {
      const tenantId = createId("tenant");
      this.db.prepare(`
        INSERT INTO tenants (
          id, name, slug, status, expires_at, max_users, max_servers, max_streams, notes, created_at, updated_at
        ) VALUES (?, 'Default Workspace', 'default-workspace', 'active', NULL, 10, 100, 1000, 'Imported from legacy config', ?, ?)
      `).run(tenantId, now, now);
      tenant = { id: tenantId };
    }

    this.db.prepare("UPDATE server_configs SET tenant_id = ? WHERE tenant_id IS NULL").run(tenant.id);
    this.db.prepare("UPDATE stream_configs SET tenant_id = ? WHERE tenant_id IS NULL").run(tenant.id);
    this.ensureServerGroupExists(tenant.id, "Default");
  }

  syncServerGroupsFromServers() {
    const rows = this.db.prepare(`
      SELECT DISTINCT tenant_id, group_name
      FROM server_configs
      WHERE tenant_id IS NOT NULL
    `).all();

    for (const row of rows) {
      this.ensureServerGroupExists(row.tenant_id, row.group_name);
    }
  }

  getSetupStatus() {
    const userCount = this.db.prepare("SELECT COUNT(*) AS count FROM app_users").get().count;
    const settings = this.getRuntimeSettings();
    return {
      setupRequired: userCount === 0,
      panelTitle: settings.panelTitle
    };
  }

  getTenantRecord(tenantId) {
    if (!tenantId) {
      return null;
    }

    return this.db.prepare("SELECT * FROM tenants WHERE id = ?").get(tenantId) ?? null;
  }

  assertUsernameAvailable(username, currentUserId = null) {
    const normalizedUsername = String(username ?? "").trim();
    if (!normalizedUsername) {
      throw new Error("请输入账号。");
    }

    const duplicate = currentUserId
      ? this.db.prepare("SELECT id FROM app_users WHERE username = ? AND id <> ?").get(normalizedUsername, currentUserId)
      : this.db.prepare("SELECT id FROM app_users WHERE username = ?").get(normalizedUsername);
    if (duplicate) {
      throw new Error("该账号已存在。");
    }

    return normalizedUsername;
  }

  assertTenantSlugAvailable(slug, currentTenantId = null) {
    const normalizedSlug = normalizeTenantSlug(slug);
    if (!normalizedSlug) {
      throw new Error("请输入客户空间标识。");
    }

    const duplicate = currentTenantId
      ? this.db.prepare("SELECT id FROM tenants WHERE slug = ? AND id <> ?").get(normalizedSlug, currentTenantId)
      : this.db.prepare("SELECT id FROM tenants WHERE slug = ?").get(normalizedSlug);
    if (duplicate) {
      throw new Error("该客户空间标识已存在。");
    }

    return normalizedSlug;
  }

  assertTenantIsAvailable(tenantId) {
    const tenant = this.getTenantRecord(tenantId);
    if (!tenant) {
      throw new Error("所选客户空间不存在。");
    }

    if (tenant.status !== "active") {
      throw new Error("所选客户空间未启用。");
    }

    if (isExpired(tenant.expires_at)) {
      throw new Error("所选客户空间已过期。");
    }

    return tenant;
  }

  assertTenantQuota(tenantId, fieldName, currentId = null, additionalCount = 1) {
    const tenant = this.getTenantRecord(tenantId);
    if (!tenant) {
      throw new Error("所选客户空间不存在。");
    }

    const limit = Number(tenant[fieldName] ?? 0);
    if (limit <= 0) {
      throw new Error("所选客户空间没有可用配额。");
    }

    const normalizedAdditionalCount = Math.max(1, Number(additionalCount ?? 1));
    const whereId = currentId ? "AND id <> ?" : "";
    const count = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM ${fieldName === "max_users" ? "app_users" : fieldName === "max_servers" ? "server_configs" : "stream_configs"}
      WHERE tenant_id = ?
      ${whereId}
    `).get(...(currentId ? [tenantId, currentId] : [tenantId])).count;

    if (count + normalizedAdditionalCount > limit) {
      const label = fieldName === "max_users"
        ? "users"
        : fieldName === "max_servers"
          ? "servers"
          : "streams";
      throw new Error(`客户空间的${label === "users" ? "账号" : label === "servers" ? "服务器" : "直播流"}配额已达上限。`);
    }

    return tenant;
  }

  ensureServerGroupExists(tenantId, groupName, notes = "") {
    if (!tenantId) {
      return null;
    }

    const normalizedName = normalizeGroupName(groupName);
    const existing = this.db.prepare(`
      SELECT *
      FROM server_groups
      WHERE tenant_id = ? AND name = ?
    `).get(tenantId, normalizedName);

    if (existing) {
      if (notes && !existing.notes) {
        this.db.prepare(`
          UPDATE server_groups
          SET notes = ?, updated_at = ?
          WHERE id = ?
        `).run(String(notes).trim(), nowIso(), existing.id);
      }

      return existing.id;
    }

    const id = createId("group");
    const now = nowIso();
    this.db.prepare(`
      INSERT INTO server_groups (id, tenant_id, name, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, tenantId, normalizedName, String(notes).trim(), now, now);
    return id;
  }

  isUserTenantAccessible(row) {
    if (!row) {
      return false;
    }

    if (row.role === "super_admin") {
      return true;
    }

    if (!row.tenant_id || !row.tenant_status) {
      return false;
    }

    if (row.tenant_status !== "active") {
      return false;
    }

    return !isExpired(row.tenant_expires_at);
  }

  bootstrapUser(username, password) {
    const existing = this.db.prepare("SELECT COUNT(*) AS count FROM app_users").get().count;
    if (existing > 0) {
      throw new Error("系统已经初始化过了。");
    }

    const normalizedUsername = this.assertUsernameAvailable(username);
    if (!normalizedUsername || !password || String(password).length < 8) {
      throw new Error("请输入账号，且密码长度不能少于 8 位。");
    }

    const now = nowIso();
    this.db.prepare(`
      INSERT INTO app_users (id, username, password_hash, role, tenant_id, created_at, updated_at)
      VALUES (?, ?, ?, 'super_admin', NULL, ?, ?)
    `).run(createId("user"), normalizedUsername, hashPassword(password), now, now);
    this.addEvent("info", "auth.bootstrap", "System bootstrap completed.", {
      username: normalizedUsername
    });
  }

  authenticateUser(username, password) {
    const row = this.db.prepare(`
      SELECT
        app_users.id,
        app_users.username,
        app_users.password_hash,
        app_users.role,
        app_users.tenant_id,
        tenants.status AS tenant_status,
        tenants.expires_at AS tenant_expires_at
      FROM app_users
      LEFT JOIN tenants ON tenants.id = app_users.tenant_id
      WHERE app_users.username = ?
    `).get(String(username).trim());

    if (!row || !verifyPassword(password, row.password_hash)) {
      return null;
    }

    if (!this.isUserTenantAccessible(row)) {
      return null;
    }

    this.db.prepare("UPDATE app_users SET last_login_at = ?, updated_at = ? WHERE id = ?")
      .run(nowIso(), nowIso(), row.id);
    return {
      id: row.id,
      username: row.username,
      role: row.role,
      tenantId: row.tenant_id ?? null
    };
  }

  createSession(userId) {
    const runtime = this.getRuntimeSettings();
    const token = issueSessionToken();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + runtime.sessionTtlHours * 60 * 60 * 1000);
    this.db.prepare(`
      INSERT INTO app_sessions (id, user_id, token_hash, created_at, expires_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      createId("session"),
      userId,
      hashSessionToken(token),
      now.toISOString(),
      expiresAt.toISOString(),
      now.toISOString()
    );
    return {
      token,
      maxAgeSeconds: runtime.sessionTtlHours * 60 * 60
    };
  }

  getUserBySession(token) {
    if (!token) {
      return null;
    }

    const now = nowIso();
    const row = this.db.prepare(`
      SELECT
        app_users.id,
        app_users.username,
        app_users.role,
        app_users.tenant_id,
        app_sessions.id AS session_id,
        tenants.status AS tenant_status,
        tenants.expires_at AS tenant_expires_at
      FROM app_sessions
      JOIN app_users ON app_users.id = app_sessions.user_id
      LEFT JOIN tenants ON tenants.id = app_users.tenant_id
      WHERE app_sessions.token_hash = ? AND app_sessions.expires_at > ?
    `).get(hashSessionToken(token), now);

    if (!row || !this.isUserTenantAccessible(row)) {
      return null;
    }

    this.db.prepare("UPDATE app_sessions SET last_seen_at = ? WHERE id = ?").run(nowIso(), row.session_id);
    return {
      id: row.id,
      username: row.username,
      role: row.role,
      tenantId: row.tenant_id ?? null
    };
  }

  deleteSession(token) {
    if (!token) {
      return;
    }

    this.db.prepare("DELETE FROM app_sessions WHERE token_hash = ?").run(hashSessionToken(token));
  }

  changePassword(userId, currentPassword, nextPassword) {
    const row = this.db.prepare("SELECT password_hash FROM app_users WHERE id = ?").get(userId);
    if (!row || !verifyPassword(currentPassword, row.password_hash)) {
      throw new Error("当前密码不正确。");
    }

    if (!nextPassword || String(nextPassword).length < 8) {
      throw new Error("新密码长度不能少于 8 位。");
    }

    this.db.prepare("UPDATE app_users SET password_hash = ?, updated_at = ? WHERE id = ?")
      .run(hashPassword(nextPassword), nowIso(), userId);
  }

  getRuntimeSettings() {
    const row = this.db.prepare("SELECT * FROM runtime_settings WHERE id = 1").get();
    return {
      panelTitle: row.panel_title,
      publicBaseUrl: row.public_base_url ?? "",
      pollIntervalSeconds: Number(row.poll_interval_seconds),
      connectionTimeoutSeconds: Number(row.connection_timeout_seconds),
      defaultVerifyDelaySeconds: Number(row.default_verify_delay_seconds),
      sessionTtlHours: Number(row.session_ttl_hours),
      eventRetentionCount: Number(row.event_retention_count)
    };
  }

  updateRuntimeSettings(input) {
    const current = this.getRuntimeSettings();
    const next = {
      panelTitle: String(input.panelTitle ?? current.panelTitle ?? "Stream Watchdog").trim() || "Stream Watchdog",
      publicBaseUrl: String(input.publicBaseUrl ?? current.publicBaseUrl ?? "").trim(),
      pollIntervalSeconds: Number(input.pollIntervalSeconds ?? current.pollIntervalSeconds ?? 20),
      connectionTimeoutSeconds: Number(input.connectionTimeoutSeconds ?? current.connectionTimeoutSeconds ?? 15),
      defaultVerifyDelaySeconds: Number(input.defaultVerifyDelaySeconds ?? current.defaultVerifyDelaySeconds ?? 8),
      sessionTtlHours: Number(input.sessionTtlHours ?? current.sessionTtlHours ?? 168),
      eventRetentionCount: Number(input.eventRetentionCount ?? current.eventRetentionCount ?? 500)
    };

    this.db.prepare(`
      UPDATE runtime_settings
      SET panel_title = ?,
          public_base_url = ?,
          poll_interval_seconds = ?,
          connection_timeout_seconds = ?,
          default_verify_delay_seconds = ?,
          session_ttl_hours = ?,
          event_retention_count = ?,
          updated_at = ?
      WHERE id = 1
    `).run(
      next.panelTitle,
      next.publicBaseUrl,
      next.pollIntervalSeconds,
      next.connectionTimeoutSeconds,
      next.defaultVerifyDelaySeconds,
      next.sessionTtlHours,
      next.eventRetentionCount,
      nowIso()
    );

    return this.getRuntimeSettings();
  }

  getEmailSettings(includeSecret = false) {
    const row = this.db.prepare("SELECT * FROM notification_email_settings WHERE id = 1").get();
    return {
      enabled: toBoolean(row.enabled),
      smtpHost: row.smtp_host ?? "",
      smtpPort: Number(row.smtp_port ?? 587),
      smtpSecure: toBoolean(row.smtp_secure),
      smtpUser: row.smtp_user ?? "",
      smtpPass: includeSecret ? (decryptText(row.smtp_pass_enc, this.masterKey) ?? "") : "",
      fromAddress: row.from_address ?? "",
      toAddresses: parseJson(row.to_addresses, [])
    };
  }

  updateEmailSettings(input) {
    const current = this.getEmailSettings(true);
    const nextPassword = Object.prototype.hasOwnProperty.call(input, "smtpPass")
      ? String(input.smtpPass ?? "").trim()
      : current.smtpPass;
    const next = {
      enabled: toBoolean(input.enabled ?? current.enabled),
      smtpHost: String(input.smtpHost ?? current.smtpHost ?? "").trim(),
      smtpPort: Number(input.smtpPort ?? current.smtpPort ?? 587),
      smtpSecure: toBoolean(input.smtpSecure ?? current.smtpSecure ?? false),
      smtpUser: String(input.smtpUser ?? current.smtpUser ?? "").trim(),
      smtpPass: nextPassword,
      fromAddress: String(input.fromAddress ?? current.fromAddress ?? "").trim(),
      toAddresses: Array.isArray(input.toAddresses)
        ? input.toAddresses.map((item) => String(item).trim()).filter(Boolean)
        : current.toAddresses
    };

    this.db.prepare(`
      UPDATE notification_email_settings
      SET enabled = ?,
          smtp_host = ?,
          smtp_port = ?,
          smtp_secure = ?,
          smtp_user = ?,
          smtp_pass_enc = ?,
          from_address = ?,
          to_addresses = ?,
          updated_at = ?
      WHERE id = 1
    `).run(
      next.enabled ? 1 : 0,
      next.smtpHost,
      next.smtpPort,
      next.smtpSecure ? 1 : 0,
      next.smtpUser,
      encryptText(next.smtpPass, this.masterKey) ?? "",
      next.fromAddress,
      JSON.stringify(next.toAddresses),
      nowIso()
    );

    return this.getEmailSettings(false);
  }

  listServers(includeSecrets = false, actor = null) {
    const scope = tenantScopeClause(actor, "tenant_id");
    return this.db.prepare(`
      SELECT *
      FROM server_configs
      ${scope.where}
      ORDER BY created_at ASC
    `).all(...scope.params).map((row) => ({
      id: row.id,
      tenantId: row.tenant_id ?? null,
      groupName: normalizeGroupName(row.group_name),
      label: row.label,
      host: row.host,
      port: Number(row.port),
      username: row.username,
      password: includeSecrets ? (decryptText(row.password_enc, this.masterKey) ?? "") : "",
      hasPassword: Boolean(row.password_enc),
      enabled: toBoolean(row.enabled),
      notes: row.notes ?? "",
      connectionStatus: row.connection_status,
      lastError: row.last_error,
      lastCheckedAt: row.last_checked_at
    }));
  }

  saveServer(input, actor = null) {
    const now = nowIso();
    const current = input.id
      ? this.db.prepare("SELECT * FROM server_configs WHERE id = ?").get(input.id)
      : null;
    const attachedStreamCount = current
      ? this.db.prepare("SELECT COUNT(*) AS count FROM stream_configs WHERE server_id = ?").get(current.id).count
      : 0;

    if (current && actor?.role !== "super_admin" && current.tenant_id !== actor?.tenantId) {
      throw new Error("你没有权限访问这台服务器。");
    }

    const nextPassword = Object.prototype.hasOwnProperty.call(input, "password")
      ? String(input.password ?? "").trim()
      : current
        ? decryptText(current.password_enc, this.masterKey) ?? ""
        : "";

    const payload = {
      id: current?.id ?? createId("server"),
      tenantId: actor?.role === "super_admin"
        ? String(input.tenantId ?? current?.tenant_id ?? "").trim()
        : (actor?.tenantId ?? current?.tenant_id ?? null),
      groupName: normalizeGroupName(input.groupName ?? current?.group_name),
      label: String(input.label ?? current?.label ?? "").trim(),
      host: String(input.host ?? current?.host ?? "").trim(),
      port: Number(input.port ?? current?.port ?? 22),
      username: String(input.username ?? current?.username ?? "").trim(),
      password: nextPassword,
      enabled: toBoolean(input.enabled ?? current?.enabled ?? true),
      notes: String(input.notes ?? current?.notes ?? "").trim()
    };

    if (!payload.tenantId || !payload.label || !payload.host || !payload.username) {
      throw new Error("请输入服务器名称、主机地址和登录账号。");
    }

    if (!current) {
      this.assertTenantIsAvailable(payload.tenantId);
      this.assertTenantQuota(payload.tenantId, "max_servers");
    } else if (payload.tenantId !== current.tenant_id) {
      this.assertTenantIsAvailable(payload.tenantId);
      this.assertTenantQuota(payload.tenantId, "max_servers", current.id);
      if (attachedStreamCount > 0) {
        this.assertTenantQuota(payload.tenantId, "max_streams", null, attachedStreamCount);
      }
    }

    this.ensureServerGroupExists(payload.tenantId, payload.groupName);

    if (current) {
      this.db.prepare(`
        UPDATE server_configs
        SET tenant_id = ?,
            group_name = ?,
            label = ?,
            host = ?,
            port = ?,
            username = ?,
            password_enc = ?,
            enabled = ?,
            notes = ?,
            updated_at = ?
        WHERE id = ?
      `).run(
        payload.tenantId,
        payload.groupName,
        payload.label,
        payload.host,
        payload.port,
        payload.username,
        encryptText(payload.password, this.masterKey) ?? "",
        payload.enabled ? 1 : 0,
        payload.notes,
        now,
        payload.id
      );

      if (payload.tenantId !== current.tenant_id) {
        this.db.prepare(`
          UPDATE stream_configs
          SET tenant_id = ?, updated_at = ?
          WHERE server_id = ?
        `).run(payload.tenantId, now, payload.id);
      }
    } else {
      this.db.prepare(`
        INSERT INTO server_configs (
          id, tenant_id, group_name, label, host, port, username, password_enc, enabled, notes,
          connection_status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unknown', ?, ?)
      `).run(
        payload.id,
        payload.tenantId,
        payload.groupName,
        payload.label,
        payload.host,
        payload.port,
        payload.username,
        encryptText(payload.password, this.masterKey) ?? "",
        payload.enabled ? 1 : 0,
        payload.notes,
        now,
        now
      );
    }

    return this.listServers(false, actor).find((server) => server.id === payload.id);
  }

  deleteServer(serverId, actor = null) {
    const current = this.db.prepare("SELECT tenant_id FROM server_configs WHERE id = ?").get(serverId);
    if (!current) {
      return;
    }

    if (actor?.role !== "super_admin" && current.tenant_id !== actor?.tenantId) {
      throw new Error("你没有权限访问这台服务器。");
    }

    this.db.prepare("DELETE FROM server_configs WHERE id = ?").run(serverId);
  }

  listServerGroups(actor = null) {
    const scope = tenantScopeClause(actor, "tenant_id");
    const groups = new Map(
      this.db.prepare(`
        SELECT *
        FROM server_groups
        ${scope.where}
        ORDER BY created_at ASC
      `).all(...scope.params).map((row) => {
        const key = `${row.tenant_id}:${row.name}`;
        return [key, {
          id: row.id,
          tenantId: row.tenant_id,
          name: row.name,
          notes: row.notes ?? "",
          serverCount: 0,
          streamCount: 0,
          healthyStreamCount: 0
        }];
      })
    );

    const streamsByServer = new Map();
    for (const stream of this.listStreams(false, actor)) {
      if (!streamsByServer.has(stream.serverId)) {
        streamsByServer.set(stream.serverId, []);
      }

      streamsByServer.get(stream.serverId).push(stream);
    }

    for (const server of this.listServers(false, actor)) {
      const name = normalizeGroupName(server.groupName);
      const key = `${server.tenantId}:${name}`;
      if (!groups.has(key)) {
        groups.set(key, {
          id: null,
          tenantId: server.tenantId,
          name,
          notes: "",
          serverCount: 0,
          streamCount: 0,
          healthyStreamCount: 0
        });
      }

      const group = groups.get(key);
      const streams = streamsByServer.get(server.id) ?? [];
      group.serverCount += 1;
      group.streamCount += streams.length;
      group.healthyStreamCount += streams.filter((stream) => stream.status === "healthy").length;
    }

    return [...groups.values()].sort((a, b) => {
      if (a.tenantId === b.tenantId) {
        return a.name.localeCompare(b.name, "en");
      }

      return String(a.tenantId).localeCompare(String(b.tenantId), "en");
    });
  }

  saveServerGroup(input, actor = null) {
    const now = nowIso();
    const current = input.id
      ? this.db.prepare("SELECT * FROM server_groups WHERE id = ?").get(input.id)
      : null;

    if (current && actor?.role !== "super_admin" && current.tenant_id !== actor?.tenantId) {
      throw new Error("你没有权限访问这个分组。");
    }

    const payload = {
      id: current?.id ?? createId("group"),
      tenantId: actor?.role === "super_admin"
        ? String(input.tenantId ?? current?.tenant_id ?? "").trim()
        : (actor?.tenantId ?? current?.tenant_id ?? null),
      name: normalizeGroupName(input.name ?? current?.name),
      notes: String(input.notes ?? current?.notes ?? "").trim()
    };

    if (!payload.tenantId || !payload.name) {
      throw new Error("请输入分组名称。");
    }

    this.assertTenantIsAvailable(payload.tenantId);

    const duplicate = this.db.prepare(`
      SELECT id
      FROM server_groups
      WHERE tenant_id = ? AND name = ? AND id <> ?
    `).get(payload.tenantId, payload.name, payload.id);
    if (duplicate) {
      throw new Error("已存在同名分组。");
    }

    if (current) {
      const affectedServerIds = (current.name !== payload.name || current.tenant_id !== payload.tenantId)
        ? this.db.prepare(`
            SELECT id
            FROM server_configs
            WHERE tenant_id = ? AND group_name = ?
          `).all(current.tenant_id, current.name).map((row) => row.id)
        : [];
      const affectedStreamCount = affectedServerIds.length > 0
        ? this.db.prepare(`
            SELECT COUNT(*) AS count
            FROM stream_configs
            WHERE server_id IN (${affectedServerIds.map(() => "?").join(", ")})
          `).get(...affectedServerIds).count
        : 0;

      if (current.tenant_id !== payload.tenantId) {
        if (affectedServerIds.length > 0) {
          this.assertTenantQuota(payload.tenantId, "max_servers", null, affectedServerIds.length);
        }
        if (affectedStreamCount > 0) {
          this.assertTenantQuota(payload.tenantId, "max_streams", null, affectedStreamCount);
        }
      }

      this.db.prepare(`
        UPDATE server_groups
        SET tenant_id = ?, name = ?, notes = ?, updated_at = ?
        WHERE id = ?
      `).run(payload.tenantId, payload.name, payload.notes, now, payload.id);

      if (current.name !== payload.name || current.tenant_id !== payload.tenantId) {
        this.db.prepare(`
          UPDATE server_configs
          SET tenant_id = ?, group_name = ?, updated_at = ?
          WHERE tenant_id = ? AND group_name = ?
        `).run(payload.tenantId, payload.name, now, current.tenant_id, current.name);

        if (affectedServerIds.length > 0) {
          const placeholders = affectedServerIds.map(() => "?").join(", ");
          this.db.prepare(`
            UPDATE stream_configs
            SET tenant_id = ?, updated_at = ?
            WHERE server_id IN (${placeholders})
          `).run(payload.tenantId, now, ...affectedServerIds);
        }
      }
    } else {
      this.db.prepare(`
        INSERT INTO server_groups (id, tenant_id, name, notes, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(payload.id, payload.tenantId, payload.name, payload.notes, now, now);
    }

    return this.listServerGroups(actor).find((group) => group.id === payload.id)
      ?? this.listServerGroups(actor).find((group) => group.tenantId === payload.tenantId && group.name === payload.name);
  }

  deleteServerGroup(groupId, actor = null) {
    const current = this.db.prepare("SELECT * FROM server_groups WHERE id = ?").get(groupId);
    if (!current) {
      return;
    }

    if (actor?.role !== "super_admin" && current.tenant_id !== actor?.tenantId) {
      throw new Error("你没有权限访问这个分组。");
    }

    if (current.name === "Default") {
      throw new Error("默认分组不能删除。");
    }

    this.ensureServerGroupExists(current.tenant_id, "Default");
    this.db.prepare(`
      UPDATE server_configs
      SET group_name = 'Default', updated_at = ?
      WHERE tenant_id = ? AND group_name = ?
    `).run(nowIso(), current.tenant_id, current.name);
    this.db.prepare("DELETE FROM server_groups WHERE id = ?").run(groupId);
  }

  listStreams(includeSecrets = false, actor = null) {
    const scope = tenantScopeClause(actor, "stream_configs.tenant_id");
    return this.db.prepare(`
      SELECT stream_configs.*, server_configs.label AS server_label
      FROM stream_configs
      JOIN server_configs ON server_configs.id = stream_configs.server_id
      ${scope.where}
      ORDER BY stream_configs.created_at ASC
    `).all(...scope.params).map((row) => {
      const discoveredCommand = decryptText(row.discovered_command_enc, this.masterKey) ?? "";
      const managed = parseManagedStreamFields(row.restart_command ?? "", discoveredCommand);
      return {
        id: row.id,
        tenantId: row.tenant_id ?? null,
        serverId: row.server_id,
        serverLabel: row.server_label,
        label: row.label,
        matchTerms: parseJson(row.match_terms_json, []),
        restartCommand: row.restart_command ?? "",
        restartLogPath: row.restart_log_path ?? "",
        discoveredCommand: includeSecrets ? discoveredCommand : "",
        sourcePath: managed.sourcePath,
        sourceFileName: managed.sourcePath ? path.basename(managed.sourcePath) : "",
        streamKey: managed.streamKey,
        cooldownSeconds: Number(row.cooldown_seconds),
        restartWindowSeconds: Number(row.restart_window_seconds),
        maxRestartsInWindow: Number(row.max_restarts_in_window),
        verifyDelaySeconds: Number(row.verify_delay_seconds ?? 0),
        enabled: toBoolean(row.enabled),
        status: row.status,
        lastSeenAt: row.last_seen_at,
        lastRestartAt: row.last_restart_at,
        restartHistory: parseJson(row.restart_history_json, []),
        lastError: row.last_error
      };
    });
  }

  saveStream(input, actor = null) {
    const now = nowIso();
    const current = input.id
      ? this.db.prepare("SELECT * FROM stream_configs WHERE id = ?").get(input.id)
      : null;

    if (current && actor?.role !== "super_admin" && current.tenant_id !== actor?.tenantId) {
      throw new Error("你没有权限访问这路直播流。");
    }

    const currentManaged = current
      ? parseManagedStreamFields(
          current.restart_command ?? "",
          decryptText(current.discovered_command_enc, this.masterKey) ?? ""
        )
      : { sourcePath: "", streamKey: "" };

    const hasExplicitSourcePath = Object.prototype.hasOwnProperty.call(input, "sourcePath");
    const hasExplicitStreamKey = Object.prototype.hasOwnProperty.call(input, "streamKey");
    const sourcePath = normalizeMediaPath(hasExplicitSourcePath ? input.sourcePath : currentManaged.sourcePath);
    const streamKey = normalizeStreamKey(hasExplicitStreamKey ? input.streamKey : currentManaged.streamKey);
    const managedMode = Boolean(sourcePath || streamKey);

    if (managedMode && (!sourcePath || !streamKey)) {
      throw new Error("媒体文件和推流码都必须填写。");
    }

    const fallbackMatchTerms = managedMode ? buildManagedMatchTerms(sourcePath, streamKey) : [];
    const matchTerms = Array.isArray(input.matchTerms)
      ? input.matchTerms.map((item) => String(item).trim()).filter(Boolean)
      : current
        ? parseJson(current.match_terms_json, [])
        : fallbackMatchTerms;

    const finalMatchTerms = matchTerms.length > 0 ? [...new Set(matchTerms)] : fallbackMatchTerms;

    if (finalMatchTerms.length === 0) {
      throw new Error("至少需要填写一个匹配关键词。");
    }

    const payload = {
      id: current?.id ?? createId("stream"),
      tenantId: actor?.role === "super_admin"
        ? String(input.tenantId ?? current?.tenant_id ?? "").trim()
        : (actor?.tenantId ?? current?.tenant_id ?? null),
      serverId: String(input.serverId ?? current?.server_id ?? "").trim(),
      label: String(input.label ?? current?.label ?? "").trim() || (sourcePath ? path.basename(sourcePath) : current?.label ?? ""),
      matchTerms: finalMatchTerms,
      restartCommand: managedMode
        ? buildManagedRestartCommand(sourcePath, streamKey)
        : String(input.restartCommand ?? current?.restart_command ?? "").trim(),
      restartLogPath: String(input.restartLogPath ?? current?.restart_log_path ?? "").trim(),
      cooldownSeconds: Number(input.cooldownSeconds ?? current?.cooldown_seconds ?? 60),
      restartWindowSeconds: Number(input.restartWindowSeconds ?? current?.restart_window_seconds ?? 300),
      maxRestartsInWindow: Number(input.maxRestartsInWindow ?? current?.max_restarts_in_window ?? 3),
      verifyDelaySeconds: Number(input.verifyDelaySeconds ?? current?.verify_delay_seconds ?? this.getRuntimeSettings().defaultVerifyDelaySeconds),
      enabled: toBoolean(input.enabled ?? current?.enabled ?? true)
    };

    if (!payload.tenantId || !payload.serverId || !payload.label) {
      throw new Error("请输入直播流名称并选择服务器。");
    }

    if (!current) {
      this.assertTenantIsAvailable(payload.tenantId);
      this.assertTenantQuota(payload.tenantId, "max_streams");
    } else if (payload.tenantId !== current.tenant_id) {
      this.assertTenantIsAvailable(payload.tenantId);
      this.assertTenantQuota(payload.tenantId, "max_streams", current.id);
    }

    const serverRecord = this.db.prepare("SELECT id, tenant_id FROM server_configs WHERE id = ?").get(payload.serverId);
    if (!serverRecord) {
      throw new Error("所选服务器不存在。");
    }

    if (serverRecord.tenant_id !== payload.tenantId) {
      throw new Error("直播流所属客户空间必须与所选服务器一致。");
    }

    if (actor?.role !== "super_admin") {
      if (serverRecord.tenant_id !== actor?.tenantId) {
        throw new Error("你没有权限访问所选服务器。");
      }
    }

    if (current) {
      this.db.prepare(`
        UPDATE stream_configs
        SET tenant_id = ?,
            server_id = ?,
            label = ?,
            match_terms_json = ?,
            restart_command = ?,
            restart_log_path = ?,
            cooldown_seconds = ?,
            restart_window_seconds = ?,
            max_restarts_in_window = ?,
            verify_delay_seconds = ?,
            enabled = ?,
            updated_at = ?
        WHERE id = ?
      `).run(
        payload.tenantId,
        payload.serverId,
        payload.label,
        JSON.stringify(payload.matchTerms),
        payload.restartCommand,
        payload.restartLogPath,
        payload.cooldownSeconds,
        payload.restartWindowSeconds,
        payload.maxRestartsInWindow,
        payload.verifyDelaySeconds,
        payload.enabled ? 1 : 0,
        now,
        payload.id
      );
    } else {
      this.db.prepare(`
        INSERT INTO stream_configs (
          id, tenant_id, server_id, label, match_terms_json, restart_command, restart_log_path,
          discovered_command_enc, cooldown_seconds, restart_window_seconds,
          max_restarts_in_window, verify_delay_seconds, enabled, status,
          restart_history_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, 'unknown', '[]', ?, ?)
      `).run(
        payload.id,
        payload.tenantId,
        payload.serverId,
        payload.label,
        JSON.stringify(payload.matchTerms),
        payload.restartCommand,
        payload.restartLogPath,
        payload.cooldownSeconds,
        payload.restartWindowSeconds,
        payload.maxRestartsInWindow,
        payload.verifyDelaySeconds,
        payload.enabled ? 1 : 0,
        now,
        now
      );
    }

    return this.listStreams(false, actor).find((stream) => stream.id === payload.id);
  }

  deleteStream(streamId, actor = null) {
    const current = this.db.prepare("SELECT tenant_id FROM stream_configs WHERE id = ?").get(streamId);
    if (!current) {
      return;
    }

    if (actor?.role !== "super_admin" && current.tenant_id !== actor?.tenantId) {
      throw new Error("你没有权限访问这路直播流。");
    }

    this.db.prepare("DELETE FROM stream_configs WHERE id = ?").run(streamId);
  }

  getMonitorConfig() {
    return {
      runtime: this.getRuntimeSettings(),
      email: this.getEmailSettings(true),
      servers: this.listServers(true).filter((server) => server.enabled),
      streams: this.listStreams(true).filter((stream) => stream.enabled)
    };
  }

  getStreamForRecovery(streamId) {
    return this.listStreams(true).find((stream) => stream.id === streamId) ?? null;
  }

  listTenants() {
    return this.db.prepare(`
      SELECT
        tenants.*,
        (SELECT COUNT(*) FROM app_users WHERE tenant_id = tenants.id) AS user_count,
        (SELECT COUNT(*) FROM server_configs WHERE tenant_id = tenants.id) AS server_count,
        (SELECT COUNT(*) FROM stream_configs WHERE tenant_id = tenants.id) AS stream_count
      FROM tenants
      ORDER BY tenants.created_at ASC
    `).all().map((row) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      status: row.status,
      expiresAt: row.expires_at,
      maxUsers: Number(row.max_users),
      maxServers: Number(row.max_servers),
      maxStreams: Number(row.max_streams),
      userCount: Number(row.user_count),
      serverCount: Number(row.server_count),
      streamCount: Number(row.stream_count),
      notes: row.notes ?? ""
    }));
  }

  getWorkspaceSummary(tenantId) {
    const row = this.db.prepare(`
      SELECT
        tenants.*,
        (SELECT COUNT(*) FROM app_users WHERE tenant_id = tenants.id) AS user_count,
        (SELECT COUNT(*) FROM server_configs WHERE tenant_id = tenants.id) AS server_count,
        (SELECT COUNT(*) FROM stream_configs WHERE tenant_id = tenants.id) AS stream_count
      FROM tenants
      WHERE tenants.id = ?
    `).get(tenantId);

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      status: row.status,
      expiresAt: row.expires_at,
      maxUsers: Number(row.max_users),
      maxServers: Number(row.max_servers),
      maxStreams: Number(row.max_streams),
      userCount: Number(row.user_count),
      serverCount: Number(row.server_count),
      groupCount: this.listServerGroups({ role: "tenant_admin", tenantId }).length,
      streamCount: Number(row.stream_count),
      notes: row.notes ?? ""
    };
  }

  saveTenant(input) {
    const now = nowIso();
    const current = input.id ? this.db.prepare("SELECT * FROM tenants WHERE id = ?").get(input.id) : null;
    const payload = {
      id: current?.id ?? createId("tenant"),
      name: String(input.name ?? current?.name ?? "").trim(),
      slug: resolveTenantSlug(input.slug, input.name ?? current?.name ?? "", current?.slug ?? ""),
      status: String(input.status ?? current?.status ?? "active").trim() || "active",
      expiresAt: String(input.expiresAt ?? current?.expires_at ?? "").trim() || null,
      maxUsers: Number(input.maxUsers ?? current?.max_users ?? 1),
      maxServers: Number(input.maxServers ?? current?.max_servers ?? 20),
      maxStreams: Number(input.maxStreams ?? current?.max_streams ?? 200),
      notes: String(input.notes ?? current?.notes ?? "").trim()
    };

    if (!payload.name || !payload.slug) {
      throw new Error("客户空间名称和标识都必须填写。");
    }

    this.assertTenantSlugAvailable(payload.slug, current?.id ?? null);

    if (current) {
      this.db.prepare(`
        UPDATE tenants
        SET name = ?, slug = ?, status = ?, expires_at = ?, max_users = ?, max_servers = ?, max_streams = ?, notes = ?, updated_at = ?
        WHERE id = ?
      `).run(
        payload.name,
        payload.slug,
        payload.status,
        payload.expiresAt,
        payload.maxUsers,
        payload.maxServers,
        payload.maxStreams,
        payload.notes,
        now,
        payload.id
      );
    } else {
      this.db.prepare(`
        INSERT INTO tenants (
          id, name, slug, status, expires_at, max_users, max_servers, max_streams, notes, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        payload.id,
        payload.name,
        payload.slug,
        payload.status,
        payload.expiresAt,
        payload.maxUsers,
        payload.maxServers,
        payload.maxStreams,
        payload.notes,
        now,
        now
      );
      this.ensureServerGroupExists(payload.id, "Default");
    }

    return this.listTenants().find((tenant) => tenant.id === payload.id);
  }

  deleteTenant(tenantId) {
    this.db.prepare("DELETE FROM app_users WHERE tenant_id = ? AND role <> 'super_admin'").run(tenantId);
    this.db.prepare("DELETE FROM tenants WHERE id = ?").run(tenantId);
  }

  listUsers(actor = null) {
    const scope = actor?.role === "super_admin"
      ? { where: "", params: [] }
      : { where: "WHERE app_users.tenant_id = ?", params: [actor?.tenantId ?? null] };
    return this.db.prepare(`
      SELECT app_users.id, app_users.username, app_users.role, app_users.tenant_id, app_users.last_login_at, tenants.name AS tenant_name
      FROM app_users
      LEFT JOIN tenants ON tenants.id = app_users.tenant_id
      ${scope.where}
      ORDER BY app_users.created_at ASC
    `).all(...scope.params).map((row) => ({
      id: row.id,
      username: row.username,
      role: row.role,
      tenantId: row.tenant_id,
      tenantName: row.tenant_name ?? "",
      lastLoginAt: row.last_login_at
    }));
  }

  createUser(input, actor) {
    const now = nowIso();
    const payload = {
      id: createId("user"),
      username: this.assertUsernameAvailable(input.username),
      password: String(input.password ?? "").trim(),
      role: actor?.role === "super_admin"
        ? String(input.role ?? "tenant_admin").trim()
        : "tenant_admin",
      tenantId: actor?.role === "super_admin"
        ? String(input.tenantId ?? "").trim()
        : actor?.tenantId
    };

    if (!payload.username || payload.password.length < 8) {
      throw new Error("请输入账号，且密码长度不能少于 8 位。");
    }

    if (payload.role !== "super_admin") {
      this.assertTenantIsAvailable(payload.tenantId);
      this.assertTenantQuota(payload.tenantId, "max_users");
    }

    this.db.prepare(`
      INSERT INTO app_users (id, username, password_hash, role, tenant_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      payload.id,
      payload.username,
      hashPassword(payload.password),
      payload.role,
      payload.role === "super_admin" ? null : payload.tenantId,
      now,
      now
    );

    return this.listUsers(actor).find((user) => user.id === payload.id);
  }

  deleteUser(userId) {
    this.db.prepare("DELETE FROM app_users WHERE id = ?").run(userId);
  }

  listRedeemCodes() {
    return this.db.prepare(`
      SELECT redeem_codes.*, tenants.name AS tenant_name, app_users.username AS redeemed_by_username
      FROM redeem_codes
      LEFT JOIN tenants ON tenants.id = redeem_codes.tenant_id
      LEFT JOIN app_users ON app_users.id = redeem_codes.redeemed_by_user_id
      ORDER BY redeem_codes.created_at DESC
    `).all().map((row) => ({
      id: row.id,
      code: row.code,
      label: row.label,
      durationDays: Number(row.duration_days),
      maxUsers: Number(row.max_users),
      maxServers: Number(row.max_servers),
      maxStreams: Number(row.max_streams),
      status: row.status,
      tenantId: row.tenant_id,
      tenantName: row.tenant_name ?? "",
      redeemedByUsername: row.redeemed_by_username ?? "",
      redeemedAt: row.redeemed_at,
      notes: row.notes ?? ""
    }));
  }

  createRedeemCodes(input) {
    const quantity = Math.max(1, Math.min(100, Number(input.quantity ?? 1)));
    const customCode = normalizeRedeemCodeValue(input.code);
    if (quantity > 1 && customCode) {
      throw new Error("自定义 CDK 只能在单个生成时使用。");
    }

    const label = String(input.label ?? "Standard Plan").trim() || "Standard Plan";
    const durationDays = Number(input.durationDays ?? 30);
    const maxUsers = Number(input.maxUsers ?? 1);
    const maxServers = Number(input.maxServers ?? 20);
    const maxStreams = Number(input.maxStreams ?? 200);
    const notes = String(input.notes ?? "").trim();
    const insert = this.db.prepare(`
      INSERT INTO redeem_codes (
        id, code, label, duration_days, max_users, max_servers, max_streams, status, notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'unused', ?, ?, ?)
    `);
    const createdIds = [];

    for (let index = 0; index < quantity; index += 1) {
      const now = nowIso();
      const id = createId("cdk");
      let code = customCode;

      if (!code) {
        let attempts = 0;
        do {
          code = generateRedeemCodeValue();
          attempts += 1;
        } while (
          this.db.prepare("SELECT 1 FROM redeem_codes WHERE code = ?").get(code) &&
          attempts < 20
        );
      }

      if (code.length < 8) {
        throw new Error("CDK 至少需要 8 位字母或数字。");
      }

      if (this.db.prepare("SELECT 1 FROM redeem_codes WHERE code = ?").get(code)) {
        throw new Error(`CDK ${code} 已存在。`);
      }

      insert.run(
        id,
        code,
        label,
        durationDays,
        maxUsers,
        maxServers,
        maxStreams,
        notes,
        now,
        now
      );
      createdIds.push(id);
    }

    const createdIdSet = new Set(createdIds);
    return this.listRedeemCodes().filter((item) => createdIdSet.has(item.id));
  }

  createRedeemCode(input) {
    return this.createRedeemCodes(input)[0] ?? null;
  }

  registerCustomer(input) {
    const username = this.assertUsernameAvailable(input.username);
    const password = String(input.password ?? "").trim();
    const tenantName = String(input.tenantName ?? "").trim();
    const tenantSlug = this.assertTenantSlugAvailable(resolveTenantSlug(input.tenantSlug, tenantName));

    if (!tenantName || password.length < 8) {
      throw new Error("客户空间名称、登录账号和不少于 8 位的密码都必须填写。");
    }

    const now = nowIso();
    const tenantId = createId("tenant");
    const userId = createId("user");

    this.db.prepare(`
      INSERT INTO tenants (
        id, name, slug, status, expires_at, max_users, max_servers, max_streams, notes, created_at, updated_at
      ) VALUES (?, ?, ?, 'active', NULL, ?, ?, ?, ?, ?, ?)
    `).run(
      tenantId,
      tenantName,
      tenantSlug,
      SELF_SERVICE_SIGNUP_DEFAULTS.maxUsers,
      SELF_SERVICE_SIGNUP_DEFAULTS.maxServers,
      SELF_SERVICE_SIGNUP_DEFAULTS.maxStreams,
      SELF_SERVICE_SIGNUP_DEFAULTS.notes,
      now,
      now
    );
    this.ensureServerGroupExists(tenantId, "Default");

    this.db.prepare(`
      INSERT INTO app_users (id, username, password_hash, role, tenant_id, created_at, updated_at)
      VALUES (?, ?, ?, 'tenant_admin', ?, ?, ?)
    `).run(
      userId,
      username,
      hashPassword(password),
      tenantId,
      now,
      now
    );

    return {
      tenantId,
      userId,
      user: {
        id: userId,
        username,
        role: "tenant_admin",
        tenantId
      },
      workspace: this.getWorkspaceSummary(tenantId)
    };
  }

  redeemCode(input) {
    const code = String(input.code ?? "").trim().toUpperCase();
    const row = this.db.prepare("SELECT * FROM redeem_codes WHERE code = ?").get(code);
    if (!row || row.status !== "unused") {
      throw new Error("兑换码无效或已经被使用。");
    }

    const username = this.assertUsernameAvailable(input.username);
    const password = String(input.password ?? "").trim();
    const tenantName = String(input.tenantName ?? "").trim();
    const tenantSlug = this.assertTenantSlugAvailable(resolveTenantSlug(input.tenantSlug, tenantName));
    if (!username || password.length < 8 || !tenantName || !tenantSlug) {
      throw new Error("客户空间名称、登录账号和不少于 8 位的密码都必须填写。");
    }

    const now = new Date();
    const nowText = now.toISOString();
    const expiresAt = new Date(now.getTime() + Number(row.duration_days) * 24 * 60 * 60 * 1000).toISOString();
    const tenantId = createId("tenant");
    const userId = createId("user");

    this.db.prepare(`
      INSERT INTO tenants (
        id, name, slug, status, expires_at, max_users, max_servers, max_streams, notes, created_at, updated_at
      ) VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)
    `).run(
      tenantId,
      tenantName,
      tenantSlug,
      expiresAt,
      Number(row.max_users),
      Number(row.max_servers),
      Number(row.max_streams),
      row.notes ?? "",
      nowText,
      nowText
    );
    this.ensureServerGroupExists(tenantId, "Default");

    this.db.prepare(`
      INSERT INTO app_users (id, username, password_hash, role, tenant_id, created_at, updated_at)
      VALUES (?, ?, ?, 'tenant_admin', ?, ?, ?)
    `).run(
      userId,
      username,
      hashPassword(password),
      tenantId,
      nowText,
      nowText
    );

    this.db.prepare(`
      UPDATE redeem_codes
      SET status = 'redeemed',
          tenant_id = ?,
          redeemed_by_user_id = ?,
          redeemed_at = ?,
          updated_at = ?
      WHERE id = ?
    `).run(tenantId, userId, nowText, nowText, row.id);

    return {
      tenantId,
      userId
    };
  }

  updateServerRuntime(serverId, runtime) {
    this.db.prepare(`
      UPDATE server_configs
      SET connection_status = ?,
          last_error = ?,
          last_checked_at = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      runtime.connectionStatus ?? "unknown",
      runtime.lastError ?? null,
      runtime.lastCheckedAt ?? null,
      nowIso(),
      serverId
    );
  }

  updateStreamRuntime(streamId, runtime) {
    const current = this.db.prepare("SELECT discovered_command_enc FROM stream_configs WHERE id = ?").get(streamId);
    this.db.prepare(`
      UPDATE stream_configs
      SET status = ?,
          last_seen_at = ?,
          last_restart_at = ?,
          restart_history_json = ?,
          last_error = ?,
          discovered_command_enc = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      runtime.status ?? "unknown",
      runtime.lastSeenAt ?? null,
      runtime.lastRestartAt ?? null,
      JSON.stringify(runtime.restartHistory ?? []),
      runtime.lastError ?? null,
      Object.prototype.hasOwnProperty.call(runtime, "discoveredCommand")
        ? (encryptText(runtime.discoveredCommand ?? "", this.masterKey) ?? "")
        : current?.discovered_command_enc ?? "",
      nowIso(),
      streamId
    );
  }

  addEvent(level, type, message, context = null) {
    this.db.prepare(`
      INSERT INTO app_events (at, level, type, message, context_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(nowIso(), level, type, message, context ? JSON.stringify(context) : null);
    this.trimEvents();
  }

  trimEvents() {
    const retention = this.getRuntimeSettings().eventRetentionCount;
    this.db.prepare(`
      DELETE FROM app_events
      WHERE id NOT IN (
        SELECT id
        FROM app_events
        ORDER BY id DESC
        LIMIT ?
      )
    `).run(retention);
  }

  getEvents(limit = 50, actor = null) {
    const rawLimit = !actor || actor.role === "super_admin"
      ? limit
      : Math.max(limit * 5, 250);
    const rows = this.db.prepare(`
      SELECT *
      FROM app_events
      ORDER BY id DESC
      LIMIT ?
    `).all(rawLimit).map((row) => ({
      id: row.id,
      at: row.at,
      level: row.level,
      type: row.type,
      message: row.message,
      context: parseJson(row.context_json, {})
    }));

    if (!actor || actor.role === "super_admin") {
      return rows.slice(0, limit);
    }

    const allowedServerIds = new Set(this.listServers(false, actor).map((server) => server.id));
    const allowedStreamIds = new Set(this.listStreams(false, actor).map((stream) => stream.id));
    return rows.filter((event) => {
      if (event.context?.tenantId && event.context.tenantId === actor.tenantId) {
        return true;
      }

      if (event.context?.serverId && allowedServerIds.has(event.context.serverId)) {
        return true;
      }

      if (event.context?.streamId && allowedStreamIds.has(event.context.streamId)) {
        return true;
      }

      return false;
    }).slice(0, limit);
  }

  getMonitorMeta() {
    const row = this.db.prepare("SELECT value_json FROM app_meta WHERE key = 'monitor_state'").get();
    return parseJson(row?.value_json, {
      startedAt: null,
      lastCycleAt: null,
      lastCycleDurationMs: null,
      lastCycleReason: null,
      isBusy: false
    });
  }

  setMonitorMeta(value, preserveExisting = false) {
    const current = this.getMonitorMeta();
    const next = preserveExisting ? { ...value, ...current } : value;
    this.db.prepare(`
      INSERT INTO app_meta (key, value_json, updated_at)
      VALUES ('monitor_state', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
    `).run(JSON.stringify(next), nowIso());
  }

  getDashboardData(currentStartedAt, isBusy, actor = null) {
    const payload = {
      meta: {
        ...this.getMonitorMeta(),
        currentStartedAt,
        isBusy
      },
      runtimeSettings: this.getRuntimeSettings(),
      groups: this.listServerGroups(actor),
      servers: this.listServers(false, actor),
      streams: this.listStreams(false, actor),
      events: this.getEvents(100, actor)
    };

    if (actor?.tenantId) {
      payload.workspace = this.getWorkspaceSummary(actor.tenantId);
    }

    if (actor?.role === "super_admin") {
      payload.emailSettings = this.getEmailSettings(false);
      payload.tenants = this.listTenants();
      payload.users = this.listUsers(actor);
      payload.redeemCodes = this.listRedeemCodes();
    }

    return payload;
  }

  close() {
    this.db.close();
  }
}
