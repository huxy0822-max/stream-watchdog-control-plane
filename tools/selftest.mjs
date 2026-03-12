import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "stream-watchdog-selftest-"));
process.env.STREAM_WATCH_DB_PATH = path.join(tempRoot, "stream-watchdog.db");
process.env.STREAM_WATCH_KEY_FILE = path.join(tempRoot, "master.key");
process.env.STREAM_WATCH_STATE_PATH = path.join(tempRoot, "state.json");
process.env.STREAM_WATCH_CONFIG = path.join(process.cwd(), "config", "watcher.example.json");
process.env.STREAM_WATCH_WEB_HOST = "127.0.0.1";
process.env.STREAM_WATCH_WEB_PORT = String(39000 + Math.floor(Math.random() * 500));

const [
  { loadConfig },
  { AppDatabase },
  { createLogger },
  { StreamMonitor, findMatchingProcess, findProcessesByStreamKey },
  { EmailNotifier },
  { RuntimeMetrics },
  { loadOrCreateMasterKey },
  { startWebServer }
] = await Promise.all([
  import("../src/config.js"),
  import("../src/database.js"),
  import("../src/logger.js"),
  import("../src/monitor.js"),
  import("../src/notifier.js"),
  import("../src/runtime-metrics.js"),
  import("../src/security.js"),
  import("../src/web.js")
]);

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

async function waitForServerReady(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://${config.web.host}:${config.web.port}/api/auth/session`);
      if (response.ok) {
        return;
      }
      lastError = new Error(`Unexpected readiness status: ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw lastError ?? new Error("Server did not become ready in time.");
}

function buildPsOutput(processes) {
  return processes
    .map((process) => `${process.pid} ${process.args}`)
    .join("\n");
}

function createFakeSshSession(initialProcesses, spawnProcessForCommand = null) {
  let processes = initialProcesses.map((process) => ({ ...process }));
  let nextPid = 7000;
  const commands = [];

  return {
    commands,
    snapshot() {
      return processes.map((process) => ({ ...process }));
    },
    async run(command) {
      commands.push(command);

      if (command === "ps -eo pid=,args= | grep [f]fmpeg || true") {
        return {
          stdout: buildPsOutput(processes),
          stderr: "",
          code: 0
        };
      }

      if (command.startsWith("kill -TERM ") || command.startsWith("kill -KILL ")) {
        const pids = command.split(/\s+/).slice(2).filter(Boolean);
        processes = processes.filter((process) => !pids.includes(String(process.pid)));
        return { stdout: "", stderr: "", code: 0 };
      }

      if (typeof spawnProcessForCommand === "function") {
        const spawnedProcess = spawnProcessForCommand(command, nextPid);
        if (spawnedProcess) {
          nextPid += 1;
          processes.push({
            pid: String(spawnedProcess.pid ?? nextPid),
            args: spawnedProcess.args
          });
        }
      }

      return { stdout: "", stderr: "", code: 0 };
    }
  };
}

try {
  await waitForServerReady();

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

  const tenantBetaCreate = await request("/api/tenants", {
    method: "POST",
    body: {
      name: "Tenant Beta",
      slug: "tenant-beta",
      maxUsers: 1,
      maxServers: 2,
      maxStreams: 1
    }
  });
  const tenantBetaId = tenantBetaCreate.tenant.id;

  const tenantGammaCreate = await request("/api/tenants", {
    method: "POST",
    body: {
      name: "Tenant Gamma",
      slug: "tenant-gamma",
      maxUsers: 1,
      maxServers: 2,
      maxStreams: 2
    }
  });
  const tenantGammaId = tenantGammaCreate.tenant.id;

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

  const redeemCodeBatch = await request("/api/redeem-codes", {
    method: "POST",
    body: {
      label: "Alpha Plan",
      durationDays: 30,
      maxUsers: 2,
      maxServers: 5,
      maxStreams: 10,
      quantity: 2
    }
  });
  if (!Array.isArray(redeemCodeBatch.redeemCodes) || redeemCodeBatch.redeemCodes.length !== 2) {
    throw new Error("Batch CDK generation should return multiple codes.");
  }

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
      label: "",
      sourcePath: "alpha.mp4",
      streamKey: "alpha-key",
      matchTerms: [],
      cooldownSeconds: 60,
      restartWindowSeconds: 300,
      maxRestartsInWindow: 3,
      verifyDelaySeconds: 2,
      enabled: false
    }
  });

  if (streamCreate.stream.label !== "alpha.mp4") {
    throw new Error("Managed stream should derive its label from the media file when left blank.");
  }
  if (streamCreate.stream.sourcePath !== "/root/alpha.mp4" || streamCreate.stream.streamKey !== "alpha-key") {
    throw new Error("Managed stream fields should be exposed in the API response.");
  }
  if (!streamCreate.stream.restartCommand.includes("/root/alpha.mp4") || !streamCreate.stream.restartCommand.includes("alpha-key")) {
    throw new Error("Managed stream should generate a restart command from sourcePath and streamKey.");
  }

  const streamUpdate = await request(`/api/streams/${encodeURIComponent(streamCreate.stream.id)}`, {
    method: "PUT",
    body: {
      tenantId,
      serverId: serverCreate.server.id,
      label: "Alpha Managed Stream",
      sourcePath: "/root/alpha.mp4",
      streamKey: "alpha-key",
      matchTerms: ["legacy-wrong-term"],
      cooldownSeconds: 60,
      restartWindowSeconds: 300,
      maxRestartsInWindow: 3,
      verifyDelaySeconds: 2,
      enabled: false
    }
  });

  if (
    streamUpdate.stream.matchTerms.length !== 2
    || streamUpdate.stream.matchTerms[0] !== "alpha-key"
    || streamUpdate.stream.matchTerms[1] !== "/root/alpha.mp4"
  ) {
    throw new Error("Managed streams should ignore custom match terms and always use sourcePath + streamKey.");
  }

  const exactManagedProcess = {
    pid: "8001",
    args: "ffmpeg -stream_loop -1 -re -i /root/alpha.mp4 -c:v copy -c:a copy -f flv rtmp://a.rtmp.youtube.com/live2/alpha-key"
  };
  const staleManagedStream = {
    ...database.getStreamForRecovery(streamUpdate.stream.id),
    matchTerms: ["legacy-wrong-term"],
    status: "failed"
  };

  if (!findMatchingProcess([exactManagedProcess], staleManagedStream)) {
    throw new Error("Managed stream matching should use sourcePath + streamKey even when stale match terms exist.");
  }

  database.updateStreamRuntime(streamUpdate.stream.id, {
    status: "failed",
    lastSeenAt: null,
    lastRestartAt: null,
    restartHistory: [],
    lastError: "stale terms",
    discoveredCommand: ""
  });

  const inspectSession = createFakeSshSession([exactManagedProcess]);
  await monitor.inspectStream(
    inspectSession,
    serverCreate.server,
    staleManagedStream,
    inspectSession.snapshot(),
    5
  );
  if (inspectSession.commands.length !== 0) {
    throw new Error("Healthy managed streams should not trigger restart commands when sourcePath + streamKey already match.");
  }

  const inspectedStream = database.getStreamForRecovery(streamUpdate.stream.id);
  if (inspectedStream?.status !== "healthy") {
    throw new Error("Managed stream should recover to healthy when an exact sourcePath + streamKey process is already running.");
  }

  database.updateStreamRuntime(streamUpdate.stream.id, {
    status: "failed",
    lastSeenAt: null,
    lastRestartAt: null,
    restartHistory: [],
    lastError: "duplicate key test",
    discoveredCommand: ""
  });

  const restartTargetStream = {
    ...database.getStreamForRecovery(streamUpdate.stream.id),
    status: "failed",
    lastSeenAt: null,
    lastRestartAt: null,
    restartHistory: [],
    lastError: null,
    verifyDelaySeconds: 0
  };
  const competingProcess = {
    pid: "9001",
    args: "ffmpeg -stream_loop -1 -re -i /root/stale-alpha.mp4 -c:v copy -c:a copy -f flv rtmp://a.rtmp.youtube.com/live2/alpha-key"
  };
  const restartSession = createFakeSshSession([competingProcess], (command, nextPid) => {
    if (command === restartTargetStream.restartCommand) {
      return {
        pid: String(nextPid),
        args: "ffmpeg -stream_loop -1 -re -i /root/alpha.mp4 -c:v copy -c:a copy -f flv rtmp://a.rtmp.youtube.com/live2/alpha-key"
      };
    }

    return null;
  });
  const restartOutcome = await monitor.tryRestartStream(
    restartSession,
    serverCreate.server,
    restartTargetStream,
    restartSession.snapshot(),
    "scheduled",
    5,
    0
  );

  if (!restartOutcome.ok) {
    throw new Error("Managed stream restart should succeed after removing competing processes for the same stream key.");
  }
  if (!restartSession.commands.some((command) => command === "kill -TERM 9001")) {
    throw new Error("Restart flow should terminate competing ffmpeg processes that already use the same YouTube stream key.");
  }
  if (findProcessesByStreamKey(restartSession.snapshot(), "alpha-key").length !== 1) {
    throw new Error("Exactly one ffmpeg process should remain for a given YouTube stream key after restart.");
  }

  database.updateStreamRuntime(streamUpdate.stream.id, {
    status: "healthy",
    lastSeenAt: new Date().toISOString(),
    lastRestartAt: null,
    restartHistory: [],
    lastError: null,
    discoveredCommand: streamUpdate.stream.restartCommand
  });

  const mockedStops = [];
  monitor.stopStream = async (streamId, reason = "manual", actor = null) => {
    mockedStops.push({ streamId, reason, actorId: actor?.id ?? null });
    database.setStreamEnabled(streamId, false, actor);
    database.updateStreamRuntime(streamId, {
      status: "stopped",
      lastSeenAt: new Date().toISOString(),
      lastRestartAt: null,
      restartHistory: [],
      lastError: null,
      discoveredCommand: "mocked-stop"
    });
    return {
      ok: true,
      message: "Mock stop completed."
    };
  };

  await requestExpectFailure(`/api/streams/${encodeURIComponent(streamCreate.stream.id)}/stop`, {
    method: "POST",
    status: 403,
    body: {
      secondaryPassword: "WrongPass123!"
    }
  });

  const stopWithLoginPassword = await request(`/api/streams/${encodeURIComponent(streamCreate.stream.id)}/stop`, {
    method: "POST",
    body: {
      secondaryPassword: "SuperPass123!"
    }
  });
  if (!stopWithLoginPassword.ok || mockedStops.length !== 1) {
    throw new Error("Secondary password should default to the login password before customization.");
  }

  database.setStreamEnabled(streamCreate.stream.id, true, stateAfterLogin.user);
  database.updateStreamRuntime(streamCreate.stream.id, {
    status: "healthy",
    lastSeenAt: new Date().toISOString(),
    lastRestartAt: null,
    restartHistory: [],
    lastError: null,
    discoveredCommand: streamCreate.stream.restartCommand
  });

  await request("/api/account/secondary-password", {
    method: "POST",
    body: {
      currentPassword: "SuperPass123!",
      nextPassword: "StopPass123!"
    }
  });

  const stateAfterSecondaryPassword = await request("/api/admin/state");
  if (!stateAfterSecondaryPassword.user.hasSecondaryPassword) {
    throw new Error("User should report a custom secondary password after configuration.");
  }

  await requestExpectFailure(`/api/streams/${encodeURIComponent(streamCreate.stream.id)}/stop`, {
    method: "POST",
    status: 403,
    body: {
      secondaryPassword: "SuperPass123!"
    }
  });

  await request(`/api/streams/${encodeURIComponent(streamCreate.stream.id)}/stop`, {
    method: "POST",
    body: {
      secondaryPassword: "StopPass123!"
    }
  });

  const stoppedState = await request("/api/admin/state");
  const stoppedStream = stoppedState.dashboard.streams.find((item) => item.id === streamCreate.stream.id);
  if (!stoppedStream || stoppedStream.enabled !== false || stoppedStream.status !== "stopped") {
    throw new Error("Stopped stream should be disabled and marked as stopped.");
  }

  const betaServerCreate = await request("/api/servers", {
    method: "POST",
    body: {
      tenantId: tenantBetaId,
      groupName: "Default",
      label: "Beta Test Server",
      host: "127.0.0.4",
      port: 22,
      username: "root",
      password: "test-password",
      enabled: false
    }
  });

  await request("/api/streams", {
    method: "POST",
    body: {
      tenantId: tenantBetaId,
      serverId: betaServerCreate.server.id,
      label: "Beta Stream",
      sourcePath: "beta.mp4",
      streamKey: "beta-key",
      matchTerms: ["ffmpeg", "beta-key"],
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

  await requestExpectFailure("/api/streams", {
    method: "POST",
    status: 400,
    body: {
      tenantId: tenantGammaId,
      serverId: betaServerCreate.server.id,
      label: "Cross Tenant Stream",
      matchTerms: ["ffmpeg", "cross-tenant"],
      cooldownSeconds: 60,
      restartWindowSeconds: 300,
      maxRestartsInWindow: 3,
      verifyDelaySeconds: 2,
      enabled: false
    }
  });

  await requestExpectFailure(`/api/servers/${encodeURIComponent(serverCreate.server.id)}`, {
    method: "PUT",
    status: 409,
    body: {
      tenantId: tenantBetaId
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
      code: redeemCodeBatch.redeemCodes[0].code,
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
    if (!server.listening) {
      resolve();
      return;
    }

    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
  monitor.stop();
  database.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
