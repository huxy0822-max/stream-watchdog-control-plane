import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { AppDatabase } from "../src/database.js";
import { createLogger } from "../src/logger.js";
import { StreamMonitor } from "../src/monitor.js";
import { EmailNotifier } from "../src/notifier.js";
import { RuntimeMetrics } from "../src/runtime-metrics.js";
import { loadOrCreateMasterKey } from "../src/security.js";
import { startWebServer } from "../src/web.js";

const logger = createLogger();
const config = loadConfig();

function removeIfExists(filePath) {
  const resolved = path.resolve(filePath);
  if (fs.existsSync(resolved)) {
    fs.rmSync(resolved, { force: true });
  }
}

removeIfExists(config.database.dbPath);
removeIfExists(config.security.keyFilePath);

const masterKey = loadOrCreateMasterKey(config.security.keyFilePath, config.security.appKey);
const database = new AppDatabase(config.database, masterKey, logger);
const notifier = new EmailNotifier(database, logger);
const monitor = new StreamMonitor(database, notifier, logger);
const runtimeMetrics = new RuntimeMetrics();
const server = startWebServer({ config, database, monitor, notifier, logger, runtimeMetrics });

let cookie = "";

async function request(pathname, { method = "GET", body } = {}) {
  const response = await fetch(`http://${config.web.host}:${config.web.port}${pathname}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) {
    cookie = setCookie.split(";")[0];
  }

  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`${method} ${pathname} failed: ${response.status} ${payload?.message ?? text}`);
  }
  return payload;
}

async function requestExpectFailure(pathname, { method = "GET", body, status } = {}) {
  const response = await fetch(`http://${config.web.host}:${config.web.port}${pathname}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (response.status !== status) {
    throw new Error(`${method} ${pathname} expected ${status} but received ${response.status}: ${payload?.message ?? text}`);
  }
  return payload;
}

try {
  await new Promise((resolve) => setTimeout(resolve, 1000));

  const setup = await request("/api/setup/status");
  if (!setup.setupRequired) {
    throw new Error("Expected a clean database that still requires bootstrap.");
  }

  await request("/api/setup/bootstrap", {
    method: "POST",
    body: {
      username: "superadmin",
      password: "SuperPass123!"
    }
  });

  await request("/api/auth/login", {
    method: "POST",
    body: {
      username: "superadmin",
      password: "SuperPass123!"
    }
  });

  const stateAfterLogin = await request("/api/admin/state");
  if (stateAfterLogin.user.role !== "super_admin") {
    throw new Error("Bootstrap user should be a super admin.");
  }
  if (!stateAfterLogin.dashboard.runtimeMetrics) {
    throw new Error("Super admin dashboard should expose runtime metrics.");
  }

  const tenantCreate = await request("/api/tenants", {
    method: "POST",
    body: {
      name: "Tenant Alpha",
      slug: "tenant-alpha",
      maxUsers: 1,
      maxServers: 1,
      maxStreams: 1
    }
  });
  const tenantId = tenantCreate.tenant.id;

  await request("/api/groups", {
    method: "POST",
    body: {
      tenantId,
      name: "Priority"
    }
  });

  await request("/api/users", {
    method: "POST",
    body: {
      username: "tenant-admin",
      password: "TenantPass123!",
      role: "tenant_admin",
      tenantId
    }
  });

  const redeemCode = await request("/api/redeem-codes", {
    method: "POST",
    body: {
      code: "ALPHA2026",
      label: "Alpha Plan",
      durationDays: 30,
      maxUsers: 2,
      maxServers: 5,
      maxStreams: 10
    }
  });

  const serverCreate = await request("/api/servers", {
    method: "POST",
    body: {
      tenantId,
      groupName: "Priority",
      label: "Alpha Test Server",
      host: "127.0.0.2",
      port: 22,
      username: "root",
      password: "test-password",
      enabled: false
    }
  });

  const streamCreate = await request("/api/streams", {
    method: "POST",
    body: {
      tenantId,
      serverId: serverCreate.server.id,
      label: "Alpha Stream",
      matchTerms: ["ffmpeg", "alpha-key"],
      cooldownSeconds: 60,
      restartWindowSeconds: 300,
      maxRestartsInWindow: 3,
      verifyDelaySeconds: 2,
      enabled: false
    }
  });

  await requestExpectFailure("/api/servers", {
    method: "POST",
    status: 409,
    body: {
      tenantId,
      label: "Alpha Overflow Server",
      host: "127.0.0.3",
      port: 22,
      username: "root",
      password: "test-password",
      enabled: false
    }
  });

  await requestExpectFailure("/api/streams", {
    method: "POST",
    status: 409,
    body: {
      tenantId,
      serverId: serverCreate.server.id,
      label: "Alpha Overflow Stream",
      matchTerms: ["ffmpeg", "alpha-overflow"],
      cooldownSeconds: 60,
      restartWindowSeconds: 300,
      maxRestartsInWindow: 3,
      verifyDelaySeconds: 2,
      enabled: false
    }
  });

  await request("/api/run-once", { method: "POST" });
  await request("/api/auth/logout", { method: "POST" });

  cookie = "";
  await request("/api/auth/login", {
    method: "POST",
    body: {
      username: "tenant-admin",
      password: "TenantPass123!"
    }
  });

  const tenantState = await request("/api/admin/state");
  if (tenantState.user.role !== "tenant_admin") {
    throw new Error("Expected tenant-admin role.");
  }
  if (tenantState.dashboard.servers.length !== 1 || tenantState.dashboard.streams.length !== 1) {
    throw new Error("Tenant dashboard should be tenant-scoped.");
  }
  if (tenantState.dashboard.tenants || tenantState.dashboard.users || tenantState.dashboard.redeemCodes) {
    throw new Error("Tenant dashboard should not expose super admin data.");
  }
  if (!tenantState.dashboard.groups?.length) {
    throw new Error("Tenant dashboard should expose its group list.");
  }
  if (tenantState.dashboard.emailSettings) {
    throw new Error("Tenant dashboard should not expose email settings.");
  }
  if (tenantState.dashboard.runtimeMetrics) {
    throw new Error("Tenant dashboard should not expose runtime metrics.");
  }
  await requestExpectFailure("/api/settings/runtime", {
    method: "PUT",
    status: 403,
    body: {
      panelTitle: "Should Be Rejected"
    }
  });

  await request("/api/auth/logout", { method: "POST" });

  cookie = "";
  await request("/api/redeem", {
    method: "POST",
    body: {
      code: redeemCode.redeemCode.code,
      tenantName: "Tenant Redeemed",
      tenantSlug: "tenant-redeemed",
      username: "redeemed-admin",
      password: "RedeemPass123!"
    }
  });

  await request("/api/auth/login", {
    method: "POST",
    body: {
      username: "redeemed-admin",
      password: "RedeemPass123!"
    }
  });
  const redeemedState = await request("/api/admin/state");
  if (redeemedState.dashboard.servers.length !== 0 || redeemedState.dashboard.streams.length !== 0) {
    throw new Error("Redeemed tenant should start with an empty workspace.");
  }

  console.log(JSON.stringify({
    ok: true,
    setupRequired: setup.setupRequired,
    superAdminTenants: stateAfterLogin.dashboard.tenants?.length ?? 0,
    tenantScopedServers: tenantState.dashboard.servers.length,
    tenantScopedStreams: tenantState.dashboard.streams.length,
    redeemedTenantRole: redeemedState.user.role
  }));
} finally {
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
  monitor.stop();
}
