import path from "node:path";
import express from "express";

function parseCookies(header) {
  if (!header) {
    return {};
  }

  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const separator = part.indexOf("=");
        return separator === -1
          ? [part, ""]
          : [part.slice(0, separator), decodeURIComponent(part.slice(separator + 1))];
      })
  );
}

function authCookieOptions(config, maxAgeSeconds = undefined) {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: config.web.cookieSecure,
    path: "/",
    maxAge: maxAgeSeconds ? maxAgeSeconds * 1000 : undefined
  };
}

function normalizeMatchTerms(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }

  return String(value ?? "")
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeRecipients(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }

  return String(value ?? "")
    .split(/\r?\n|,|;/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function statusCodeForError(error) {
  const message = String(error?.message ?? "");
  if (/permission required|do not have access/i.test(message)) {
    return 403;
  }

  if (/unknown stream|unknown server|not found/i.test(message)) {
    return 404;
  }

  if (/already running|already initialized|quota reached/i.test(message)) {
    return 409;
  }

  if (/required|invalid|incorrect|does not exist|at least|not active|expired|already used|no available quota/i.test(message)) {
    return 400;
  }

  return Number(error?.statusCode ?? error?.status ?? 500);
}

function createAsyncHandler(logger, handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      logger.error("HTTP request failed", {
        path: req.path,
        error: error.message
      });
      res.status(statusCodeForError(error)).json({ ok: false, message: error.message });
    }
  };
}

export function startWebServer({ config, database, monitor, notifier, logger, runtimeMetrics }) {
  const app = express();
  const publicDir = path.resolve("./public");
  const guidesDir = path.resolve("./docs");
  const loginAttempts = new Map();

  function rateLimitKey(req) {
    return req.ip || req.socket.remoteAddress || "unknown";
  }

  function isRateLimited(req) {
    const key = rateLimitKey(req);
    const now = Date.now();
    const bucket = (loginAttempts.get(key) ?? []).filter((timestamp) => timestamp > now - 10 * 60 * 1000);
    loginAttempts.set(key, bucket);
    return bucket.length >= 5;
  }

  function recordFailedLogin(req) {
    const key = rateLimitKey(req);
    const now = Date.now();
    const bucket = (loginAttempts.get(key) ?? []).filter((timestamp) => timestamp > now - 10 * 60 * 1000);
    bucket.push(now);
    loginAttempts.set(key, bucket);
  }

  function clearFailedLogins(req) {
    loginAttempts.delete(rateLimitKey(req));
  }

  if (config.web.trustProxy) {
    app.set("trust proxy", 1);
  }

  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => runtimeMetrics.trackRequest(req, res, next));

  app.use((req, _res, next) => {
    const cookies = parseCookies(req.headers.cookie ?? "");
    req.sessionUser = database.getUserBySession(cookies[config.web.cookieName]);
    req.sessionToken = cookies[config.web.cookieName] ?? null;
    next();
  });

  function requireAuth(req, res, next) {
    if (!req.sessionUser) {
      res.status(401).json({ ok: false, message: "Authentication required." });
      return;
    }

    next();
  }

  function requireSuperAdmin(req, res, next) {
    if (!req.sessionUser || req.sessionUser.role !== "super_admin") {
      res.status(403).json({ ok: false, message: "Super admin permission required." });
      return;
    }

    next();
  }

  function sendAdminState(req, res) {
    const payload = {
      ok: true,
      user: req.sessionUser,
      dashboard: monitor.getPublicStatus(req.sessionUser)
    };

    if (req.sessionUser?.role === "super_admin") {
      payload.dashboard.runtimeMetrics = runtimeMetrics.getSnapshot();
    }

    res.json(payload);
  }

  app.get("/api/setup/status", (_req, res) => {
    res.json({
      ok: true,
      ...database.getSetupStatus()
    });
  });

  app.post("/api/setup/bootstrap", createAsyncHandler(logger, async (req, res) => {
    database.bootstrapUser(req.body.username, req.body.password);
    res.json({ ok: true });
  }));

  app.get("/api/auth/session", (req, res) => {
    res.json({
      ok: true,
      authenticated: Boolean(req.sessionUser),
      user: req.sessionUser,
      setup: database.getSetupStatus()
    });
  });

  app.post("/api/auth/login", createAsyncHandler(logger, async (req, res) => {
    if (isRateLimited(req)) {
      res.status(429).json({ ok: false, message: "Too many failed login attempts. Try again later." });
      return;
    }

    const user = database.authenticateUser(req.body.username, req.body.password);
    if (!user) {
      recordFailedLogin(req);
      res.status(401).json({ ok: false, message: "Invalid username or password." });
      return;
    }

    clearFailedLogins(req);
    const session = database.createSession(user.id);
    res.cookie(
      config.web.cookieName,
      session.token,
      authCookieOptions(config, session.maxAgeSeconds)
    );
    res.json({ ok: true, user });
  }));

  app.post("/api/auth/logout", (req, res) => {
    database.deleteSession(req.sessionToken);
    res.clearCookie(config.web.cookieName, authCookieOptions(config));
    res.json({ ok: true });
  });

  app.post("/api/redeem", createAsyncHandler(logger, async (req, res) => {
    database.redeemCode({
      code: req.body.code,
      tenantName: req.body.tenantName,
      tenantSlug: req.body.tenantSlug,
      username: req.body.username,
      password: req.body.password
    });
    res.json({ ok: true });
  }));

  app.get("/api/admin/state", requireAuth, (req, res) => {
    sendAdminState(req, res);
  });

  app.post("/api/run-once", requireAuth, createAsyncHandler(logger, async (_req, res) => {
    const result = await monitor.runOnce("manual");
    res.json(result);
  }));

  app.post("/api/streams/:streamId/recover", requireAuth, createAsyncHandler(logger, async (req, res) => {
    const result = await monitor.recoverStream(req.params.streamId, "dashboard", req.sessionUser);
    res.json(result);
  }));

  app.post("/api/servers", requireAuth, createAsyncHandler(logger, async (req, res) => {
    const server = database.saveServer({
      tenantId: req.body.tenantId,
      groupName: req.body.groupName,
      label: req.body.label,
      host: req.body.host,
      port: req.body.port,
      username: req.body.username,
      password: req.body.password,
      enabled: req.body.enabled,
      notes: req.body.notes
    }, req.sessionUser);
    res.json({ ok: true, server });
  }));

  app.put("/api/servers/:serverId", requireAuth, createAsyncHandler(logger, async (req, res) => {
    const server = database.saveServer({
      id: req.params.serverId,
      tenantId: req.body.tenantId,
      groupName: req.body.groupName,
      label: req.body.label,
      host: req.body.host,
      port: req.body.port,
      username: req.body.username,
      password: req.body.password,
      enabled: req.body.enabled,
      notes: req.body.notes
    }, req.sessionUser);
    res.json({ ok: true, server });
  }));

  app.delete("/api/servers/:serverId", requireAuth, createAsyncHandler(logger, async (req, res) => {
    database.deleteServer(req.params.serverId, req.sessionUser);
    res.json({ ok: true });
  }));

  app.post("/api/groups", requireAuth, createAsyncHandler(logger, async (req, res) => {
    const group = database.saveServerGroup({
      tenantId: req.body.tenantId,
      name: req.body.name,
      notes: req.body.notes
    }, req.sessionUser);
    res.json({ ok: true, group });
  }));

  app.put("/api/groups/:groupId", requireAuth, createAsyncHandler(logger, async (req, res) => {
    const group = database.saveServerGroup({
      id: req.params.groupId,
      tenantId: req.body.tenantId,
      name: req.body.name,
      notes: req.body.notes
    }, req.sessionUser);
    res.json({ ok: true, group });
  }));

  app.delete("/api/groups/:groupId", requireAuth, createAsyncHandler(logger, async (req, res) => {
    database.deleteServerGroup(req.params.groupId, req.sessionUser);
    res.json({ ok: true });
  }));

  app.post("/api/streams", requireAuth, createAsyncHandler(logger, async (req, res) => {
    const stream = database.saveStream({
      tenantId: req.body.tenantId,
      serverId: req.body.serverId,
      label: req.body.label,
      matchTerms: normalizeMatchTerms(req.body.matchTerms),
      restartCommand: req.body.restartCommand,
      restartLogPath: req.body.restartLogPath,
      cooldownSeconds: req.body.cooldownSeconds,
      restartWindowSeconds: req.body.restartWindowSeconds,
      maxRestartsInWindow: req.body.maxRestartsInWindow,
      verifyDelaySeconds: req.body.verifyDelaySeconds,
      enabled: req.body.enabled
    }, req.sessionUser);
    res.json({ ok: true, stream });
  }));

  app.put("/api/streams/:streamId", requireAuth, createAsyncHandler(logger, async (req, res) => {
    const stream = database.saveStream({
      id: req.params.streamId,
      tenantId: req.body.tenantId,
      serverId: req.body.serverId,
      label: req.body.label,
      matchTerms: normalizeMatchTerms(req.body.matchTerms),
      restartCommand: req.body.restartCommand,
      restartLogPath: req.body.restartLogPath,
      cooldownSeconds: req.body.cooldownSeconds,
      restartWindowSeconds: req.body.restartWindowSeconds,
      maxRestartsInWindow: req.body.maxRestartsInWindow,
      verifyDelaySeconds: req.body.verifyDelaySeconds,
      enabled: req.body.enabled
    }, req.sessionUser);
    res.json({ ok: true, stream });
  }));

  app.delete("/api/streams/:streamId", requireAuth, createAsyncHandler(logger, async (req, res) => {
    database.deleteStream(req.params.streamId, req.sessionUser);
    res.json({ ok: true });
  }));

  app.put("/api/settings/runtime", requireSuperAdmin, createAsyncHandler(logger, async (req, res) => {
    const runtimeSettings = database.updateRuntimeSettings({
      panelTitle: req.body.panelTitle,
      publicBaseUrl: req.body.publicBaseUrl,
      pollIntervalSeconds: req.body.pollIntervalSeconds,
      connectionTimeoutSeconds: req.body.connectionTimeoutSeconds,
      defaultVerifyDelaySeconds: req.body.defaultVerifyDelaySeconds,
      sessionTtlHours: req.body.sessionTtlHours,
      eventRetentionCount: req.body.eventRetentionCount
    });
    res.json({ ok: true, runtimeSettings });
  }));

  app.put("/api/settings/email", requireSuperAdmin, createAsyncHandler(logger, async (req, res) => {
    const emailSettings = database.updateEmailSettings({
      enabled: req.body.enabled,
      smtpHost: req.body.smtpHost,
      smtpPort: req.body.smtpPort,
      smtpSecure: req.body.smtpSecure,
      smtpUser: req.body.smtpUser,
      smtpPass: req.body.smtpPass,
      fromAddress: req.body.fromAddress,
      toAddresses: normalizeRecipients(req.body.toAddresses)
    });
    res.json({ ok: true, emailSettings });
  }));

  app.post("/api/settings/email/test", requireSuperAdmin, createAsyncHandler(logger, async (_req, res) => {
    await notifier.send("[TEST] Stream Watchdog", "This is a test email from Stream Watchdog.");
    res.json({ ok: true });
  }));

  app.post("/api/account/password", requireAuth, createAsyncHandler(logger, async (req, res) => {
    database.changePassword(req.sessionUser.id, req.body.currentPassword, req.body.nextPassword);
    res.json({ ok: true });
  }));

  app.post("/api/tenants", requireSuperAdmin, createAsyncHandler(logger, async (req, res) => {
    const tenant = database.saveTenant(req.body);
    res.json({ ok: true, tenant });
  }));

  app.put("/api/tenants/:tenantId", requireSuperAdmin, createAsyncHandler(logger, async (req, res) => {
    const tenant = database.saveTenant({
      ...req.body,
      id: req.params.tenantId
    });
    res.json({ ok: true, tenant });
  }));

  app.delete("/api/tenants/:tenantId", requireSuperAdmin, createAsyncHandler(logger, async (req, res) => {
    database.deleteTenant(req.params.tenantId);
    res.json({ ok: true });
  }));

  app.post("/api/users", requireSuperAdmin, createAsyncHandler(logger, async (req, res) => {
    const user = database.createUser(req.body, req.sessionUser);
    res.json({ ok: true, user });
  }));

  app.delete("/api/users/:userId", requireSuperAdmin, createAsyncHandler(logger, async (req, res) => {
    database.deleteUser(req.params.userId);
    res.json({ ok: true });
  }));

  app.post("/api/redeem-codes", requireSuperAdmin, createAsyncHandler(logger, async (req, res) => {
    const redeemCode = database.createRedeemCode(req.body);
    res.json({ ok: true, redeemCode });
  }));

  app.use("/api", (_req, res) => {
    res.status(404).json({ ok: false, message: "API route not found." });
  });

  app.use("/guides", express.static(guidesDir));
  app.use(express.static(publicDir));

  app.get("/{*path}", (_req, res) => {
    res.sendFile(path.join(publicDir, "index.html"));
  });

  const server = app.listen(config.web.port, config.web.host, () => {
    logger.info("Web dashboard ready", {
      url: `http://${config.web.host}:${config.web.port}`
    });
  });

  return server;
}
