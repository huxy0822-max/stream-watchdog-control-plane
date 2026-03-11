import { setTimeout as delay } from "node:timers/promises";
import { SshSession } from "./ssh.js";

function shellSingleQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
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

function buildManagedMatchTerms(sourcePath, streamKey) {
  return [...new Set([
    normalizeStreamKey(streamKey),
    normalizeMediaPath(sourcePath)
  ].filter(Boolean))];
}

function parseManagedStreamFields(command) {
  const text = String(command ?? "").trim();
  if (!text) {
    return { sourcePath: "", streamKey: "" };
  }

  const sourceMatch = text.match(/(?:^|\s)-i\s+('(?:[^']|\\')*'|"(?:[^"\\]|\\.)*"|\S+)/);
  const streamKeyMatch = text.match(/rtmp:\/\/[^/\s'"]+\/live2\/([A-Za-z0-9-]+)/i);
  return {
    sourcePath: sourceMatch ? normalizeMediaPath(unquoteShellToken(sourceMatch[1])) : "",
    streamKey: streamKeyMatch ? normalizeStreamKey(streamKeyMatch[1]) : ""
  };
}

function trimRestartHistory(history, nowMs, windowSeconds) {
  return history.filter((timestamp) => timestamp >= nowMs - windowSeconds * 1000);
}

function buildRestartCommand(stream, storedCommand) {
  if (stream.restartCommand) {
    return stream.restartCommand;
  }

  if (!storedCommand) {
    return null;
  }

  const logPath = stream.restartLogPath || `/tmp/${stream.id}.log`;
  const innerCommand = `nohup ${storedCommand} >> ${logPath} 2>&1 </dev/null &`;
  return `bash -lc ${shellSingleQuote(innerCommand)}`;
}

function parseProcessLines(stdout) {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const firstSpace = line.indexOf(" ");
      if (firstSpace === -1) {
        return null;
      }

      return {
        pid: line.slice(0, firstSpace).trim(),
        args: line.slice(firstSpace + 1).trim()
      };
    })
    .filter(Boolean);
}

function findMatchingProcess(processes, matchTerms) {
  return processes.find((process) => matchTerms.every((term) => process.args.includes(term))) ?? null;
}

async function collectProcesses(session) {
  const result = await session.run("ps -eo pid=,args= | grep [f]fmpeg || true");
  return parseProcessLines(result.stdout);
}

function discoverRunningStreams(processes) {
  const seen = new Set();
  return processes.map((process) => {
    const managed = parseManagedStreamFields(process.args);
    return {
      pid: process.pid,
      command: process.args,
      sourcePath: managed.sourcePath,
      sourceFileName: managed.sourcePath ? managed.sourcePath.split("/").pop() : "",
      streamKey: managed.streamKey,
      label: managed.sourcePath ? managed.sourcePath.split("/").pop() : `ffmpeg-${process.pid}`,
      matchTerms: buildManagedMatchTerms(managed.sourcePath, managed.streamKey)
    };
  }).filter((item) => {
    if (!item.sourcePath || !item.streamKey) {
      return false;
    }

    const key = `${item.sourcePath}::${item.streamKey}`;
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

export class StreamMonitor {
  constructor(database, notifier, logger) {
    this.database = database;
    this.notifier = notifier;
    this.logger = logger;
    this.startedAt = new Date().toISOString();
    this.isBusy = false;
    this.intervalHandle = null;
    this.setMeta({
      startedAt: this.startedAt,
      lastCycleAt: null,
      lastCycleDurationMs: null,
      lastCycleReason: null,
      isBusy: false
    });
  }

  setMeta(patch) {
    const current = this.database.getMonitorMeta();
    this.database.setMonitorMeta({
      ...current,
      ...patch,
      startedAt: current.startedAt ?? this.startedAt
    });
  }

  recordEvent(level, type, message, context = {}) {
    this.database.addEvent(level, type, message, context);
  }

  start() {
    if (this.intervalHandle) {
      return;
    }

    this.runOnce("startup").catch((error) => {
      this.logger.error("Initial monitoring cycle failed", { error: error.message });
    });

    const pollIntervalSeconds = this.database.getRuntimeSettings().pollIntervalSeconds;
    this.intervalHandle = setInterval(() => {
      this.runOnce("scheduled").catch((error) => {
        this.logger.error("Scheduled monitoring cycle failed", { error: error.message });
      });
    }, pollIntervalSeconds * 1000);
  }

  stop() {
    if (!this.intervalHandle) {
      return;
    }

    clearInterval(this.intervalHandle);
    this.intervalHandle = null;
  }

  getPublicStatus(actor = null) {
    return this.database.getDashboardData(this.startedAt, this.isBusy, actor);
  }

  getServerForActor(serverId, actor = null) {
    const allowedIds = new Set(this.database.listServers(false, actor).map((item) => item.id));
    const server = this.database.listServers(true, actor).find((item) => item.id === serverId && allowedIds.has(item.id));
    if (!server) {
      throw new Error(`未找到服务器：${serverId}`);
    }

    return server;
  }

  async discoverServerStreams(serverId, actor = null) {
    const server = this.getServerForActor(serverId, actor);
    const session = new SshSession(server, this.database.getRuntimeSettings().connectionTimeoutSeconds);
    try {
      await session.connect();
      const processes = await collectProcesses(session);
      const streams = discoverRunningStreams(processes);
      this.recordEvent("info", "server.discovery.completed", "Discovered live ffmpeg streams from server", {
        serverId,
        discoveredCount: streams.length
      });
      return {
        ok: true,
        serverId,
        streams
      };
    } finally {
      session.close();
    }
  }

  async importServerStreams(serverId, actor = null) {
    const server = this.getServerForActor(serverId, actor);
    const discovery = await this.discoverServerStreams(serverId, actor);
    const existingStreams = this.database.listStreams(false, actor);
    const imported = [];
    const skipped = [];
    const now = new Date().toISOString();

    for (const item of discovery.streams) {
      const duplicate = existingStreams.find((stream) => (
        stream.serverId === server.id &&
        stream.sourcePath === item.sourcePath &&
        stream.streamKey === item.streamKey
      ));

      if (duplicate) {
        skipped.push({
          reason: "exists",
          streamId: duplicate.id,
          label: duplicate.label,
          sourcePath: item.sourcePath,
          streamKey: item.streamKey
        });
        continue;
      }

      const created = this.database.saveStream({
        tenantId: server.tenantId,
        serverId: server.id,
        label: item.label,
        sourcePath: item.sourcePath,
        streamKey: item.streamKey,
        matchTerms: item.matchTerms,
        enabled: true
      }, actor);
      this.database.updateStreamRuntime(created.id, {
        status: "healthy",
        lastSeenAt: now,
        lastRestartAt: null,
        restartHistory: [],
        lastError: null,
        discoveredCommand: item.command
      });
      imported.push(created);
      existingStreams.push(created);
    }

    this.recordEvent("info", "server.discovery.imported", "Imported live ffmpeg streams from server", {
      serverId,
      discoveredCount: discovery.streams.length,
      importedCount: imported.length,
      skippedCount: skipped.length
    });

    return {
      ok: true,
      serverId,
      discoveredCount: discovery.streams.length,
      importedCount: imported.length,
      skippedCount: skipped.length,
      imported,
      skipped,
      streams: discovery.streams,
      message: imported.length > 0
        ? `Discovered ${discovery.streams.length} live stream(s); imported ${imported.length}, skipped ${skipped.length}.`
        : discovery.streams.length > 0
          ? `Discovered ${discovery.streams.length} live stream(s), but all were already imported.`
          : "No running YouTube ffmpeg streams were discovered on this server."
    };
  }

  async runOnce(reason = "manual") {
    if (this.isBusy) {
      return {
        ok: false,
        skipped: true,
        message: "已有监控任务正在运行。"
      };
    }

    this.isBusy = true;
    const startedAtMs = Date.now();
    this.setMeta({
      lastCycleReason: reason,
      isBusy: true
    });
    this.recordEvent("info", "cycle.started", "Monitoring cycle started", { reason });

    const monitorConfig = this.database.getMonitorConfig();
    const byServer = new Map();
    for (const stream of monitorConfig.streams) {
      if (!byServer.has(stream.serverId)) {
        byServer.set(stream.serverId, []);
      }

      byServer.get(stream.serverId).push(stream);
    }

    try {
      await Promise.all(
        [...byServer.entries()].map(async ([serverId, streams]) => {
          const server = monitorConfig.servers.find((item) => item.id === serverId);
          if (server) {
            await this.inspectServer(server, streams, monitorConfig.runtime.connectionTimeoutSeconds);
          }
        })
      );

      return {
        ok: true,
        skipped: false,
        message: "巡检已完成。"
      };
    } finally {
      this.isBusy = false;
      this.setMeta({
        lastCycleAt: new Date().toISOString(),
        lastCycleDurationMs: Date.now() - startedAtMs,
        lastCycleReason: reason,
        isBusy: false
      });
      this.recordEvent("info", "cycle.finished", "Monitoring cycle finished", {
        reason,
        durationMs: Date.now() - startedAtMs
      });
    }
  }

  async recoverStream(streamId, reason = "manual", actor = null) {
    if (this.isBusy) {
      throw new Error("已有监控任务正在运行。");
    }

    const monitorConfig = this.database.getMonitorConfig();
    const allowedIds = new Set(this.database.listStreams(false, actor).map((item) => item.id));
    const stream = monitorConfig.streams.find((item) => item.id === streamId && allowedIds.has(item.id));
    if (!stream) {
      throw new Error(`未找到直播流：${streamId}`);
    }

    const server = monitorConfig.servers.find((item) => item.id === stream.serverId);
    if (!server) {
      throw new Error(`未找到服务器：${stream.serverId}`);
    }

    this.isBusy = true;
    this.recordEvent("warn", "stream.manual_recover", "Manual recovery requested", {
      streamId,
      reason
    });
    this.setMeta({ isBusy: true });

    const session = new SshSession(server, monitorConfig.runtime.connectionTimeoutSeconds);
    try {
      await session.connect();
      const processes = await collectProcesses(session);
      const existingMatch = findMatchingProcess(processes, stream.matchTerms);
      if (existingMatch) {
        this.database.updateStreamRuntime(stream.id, {
          status: "healthy",
          lastSeenAt: new Date().toISOString(),
          restartHistory: stream.restartHistory,
          lastError: null,
          discoveredCommand: existingMatch.args
        });
        this.recordEvent("info", "stream.already_healthy", "Manual recovery skipped because stream is already healthy", {
          streamId
        });
        return {
          ok: true,
          message: `${stream.label} is already healthy.`
        };
      }

      const outcome = await this.tryRestartStream(
        session,
        server,
        stream,
        processes,
        "manual",
        monitorConfig.runtime.connectionTimeoutSeconds,
        monitorConfig.runtime.defaultVerifyDelaySeconds
      );
      return {
        ok: outcome.ok,
        message: outcome.message
      };
    } finally {
      session.close();
      this.isBusy = false;
      this.setMeta({ isBusy: false });
    }
  }

  async inspectServer(server, streams, connectionTimeoutSeconds) {
    const session = new SshSession(server, connectionTimeoutSeconds);

    try {
      await session.connect();
      if (server.connectionStatus === "down") {
        await this.notifier.send(
          `[RECOVERED] SSH back on ${server.label}`,
          `SSH connectivity to ${server.label} (${server.host}) recovered.`
        );
        this.recordEvent("info", "server.recovered", "SSH connectivity recovered", {
          serverId: server.id
        });
      }

      this.database.updateServerRuntime(server.id, {
        connectionStatus: "up",
        lastError: null,
        lastCheckedAt: new Date().toISOString()
      });

      let processes = await collectProcesses(session);
      for (const stream of streams) {
        const outcome = await this.inspectStream(session, server, stream, processes, connectionTimeoutSeconds);
        processes = outcome.processes;
      }
    } catch (error) {
      this.logger.error("SSH inspection failed", {
        serverId: server.id,
        error: error.message
      });

      this.database.updateServerRuntime(server.id, {
        connectionStatus: "down",
        lastError: error.message,
        lastCheckedAt: new Date().toISOString()
      });
      this.recordEvent("error", "server.down", "SSH inspection failed", {
        serverId: server.id,
        error: error.message
      });

      if (server.connectionStatus !== "down" || server.lastError !== error.message) {
        await this.notifier.send(
          `[DOWN] SSH unreachable ${server.label}`,
          `Failed to reach ${server.label} (${server.host}). Error: ${error.message}`
        );
      }
    } finally {
      session.close();
    }
  }

  async inspectStream(session, server, stream, processes, connectionTimeoutSeconds) {
    const match = findMatchingProcess(processes, stream.matchTerms);
    const now = new Date().toISOString();

    if (match) {
      const wasHealthy = stream.status === "healthy";
      this.database.updateStreamRuntime(stream.id, {
        status: "healthy",
        lastSeenAt: now,
        lastRestartAt: stream.lastRestartAt,
        restartHistory: stream.restartHistory,
        lastError: null,
        discoveredCommand: match.args
      });

      if (!wasHealthy) {
        this.recordEvent("info", "stream.healthy", "Stream is healthy", {
          streamId: stream.id,
          serverId: server.id
        });
      }

      return { processes };
    }

    return this.tryRestartStream(
      session,
      server,
      stream,
      processes,
      "scheduled",
      connectionTimeoutSeconds,
      this.database.getRuntimeSettings().defaultVerifyDelaySeconds
    );
  }

  async tryRestartStream(session, server, stream, processes, source, connectionTimeoutSeconds, defaultVerifyDelaySeconds) {
    const now = new Date();
    const nowMs = now.getTime();
    const restartHistory = trimRestartHistory(
      stream.restartHistory ?? [],
      nowMs,
      stream.restartWindowSeconds ?? 300
    );
    const secondsSinceRestart = stream.lastRestartAt
      ? Math.floor((nowMs - Date.parse(stream.lastRestartAt)) / 1000)
      : null;

    if (secondsSinceRestart !== null && secondsSinceRestart < (stream.cooldownSeconds ?? 60)) {
      this.database.updateStreamRuntime(stream.id, {
        status: "cooldown",
        lastSeenAt: stream.lastSeenAt,
        lastRestartAt: stream.lastRestartAt,
        restartHistory,
        lastError: null
      });
      this.recordEvent("warn", "stream.cooldown", "Restart skipped during cooldown", {
        streamId: stream.id,
        serverId: server.id,
        secondsSinceRestart
      });
      return { ok: false, message: "当前处于冷却期，已跳过重启。", processes };
    }

    if (restartHistory.length >= (stream.maxRestartsInWindow ?? 3)) {
      const message = `Restart limit reached for ${stream.label} on ${server.label}`;
      this.database.updateStreamRuntime(stream.id, {
        status: "failed",
        lastSeenAt: stream.lastSeenAt,
        lastRestartAt: stream.lastRestartAt,
        restartHistory,
        lastError: message
      });
      this.recordEvent("error", "stream.limit_reached", message, {
        streamId: stream.id,
        serverId: server.id
      });
      await this.notifier.send(`[FAILED] ${stream.label}`, message);
      return { ok: false, message, processes };
    }

    const restartCommand = buildRestartCommand(stream, stream.discoveredCommand);
    if (!restartCommand) {
      const message = `Stream ${stream.label} is down and no restart command has been learned yet. Start it manually once so the watcher can cache the ffmpeg command.`;
      this.database.updateStreamRuntime(stream.id, {
        status: "failed",
        lastSeenAt: stream.lastSeenAt,
        lastRestartAt: stream.lastRestartAt,
        restartHistory,
        lastError: message
      });
      this.recordEvent("error", "stream.no_restart_command", message, {
        streamId: stream.id,
        serverId: server.id
      });
      await this.notifier.send(`[FAILED] ${stream.label}`, message);
      return { ok: false, message, processes };
    }

    const lastRestartAt = now.toISOString();
    restartHistory.push(nowMs);
    this.database.updateStreamRuntime(stream.id, {
      status: "restarting",
      lastSeenAt: stream.lastSeenAt,
      lastRestartAt,
      restartHistory,
      lastError: null
    });
    this.recordEvent("warn", "stream.restarting", "Stream missing, attempting restart", {
      streamId: stream.id,
      serverId: server.id,
      source
    });

    const commandResult = await session.run(restartCommand, connectionTimeoutSeconds);
    if (commandResult.code !== 0) {
      const message = `Restart command failed for ${stream.label} on ${server.label}. stderr: ${commandResult.stderr.trim() || "(empty)"}`;
      this.database.updateStreamRuntime(stream.id, {
        status: "failed",
        lastSeenAt: stream.lastSeenAt,
        lastRestartAt,
        restartHistory,
        lastError: message
      });
      this.recordEvent("error", "stream.restart_command_failed", message, {
        streamId: stream.id,
        serverId: server.id
      });
      await this.notifier.send(`[FAILED] ${stream.label}`, message);
      return { ok: false, message, processes };
    }

    await delay((stream.verifyDelaySeconds || defaultVerifyDelaySeconds) * 1000);
    const updatedProcesses = await collectProcesses(session);
    const recoveredMatch = findMatchingProcess(updatedProcesses, stream.matchTerms);

    if (recoveredMatch) {
      const message = `Stream ${stream.label} on ${server.label} was restarted successfully.`;
      this.database.updateStreamRuntime(stream.id, {
        status: "healthy",
        lastSeenAt: new Date().toISOString(),
        lastRestartAt,
        restartHistory,
        lastError: null,
        discoveredCommand: recoveredMatch.args
      });
      this.recordEvent("info", "stream.restarted", message, {
        streamId: stream.id,
        serverId: server.id,
        source
      });
      await this.notifier.send(`[RESTARTED] ${stream.label}`, message);
      return { ok: true, message, processes: updatedProcesses };
    }

    const message = `Restart was attempted for ${stream.label} on ${server.label}, but the ffmpeg process was still not found after verification.`;
    this.database.updateStreamRuntime(stream.id, {
      status: "failed",
      lastSeenAt: stream.lastSeenAt,
      lastRestartAt,
      restartHistory,
      lastError: message
    });
    this.recordEvent("error", "stream.restart_unverified", message, {
      streamId: stream.id,
      serverId: server.id,
      source
    });
    await this.notifier.send(`[FAILED] ${stream.label}`, message);
    return { ok: false, message, processes: updatedProcesses };
  }
}
