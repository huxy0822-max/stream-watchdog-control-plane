import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

function safeNumber(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function readText(filePath, fallback = null) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return fallback;
  }
}

function readLinuxCpuSample() {
  try {
    const line = fs.readFileSync("/proc/stat", "utf8").split(/\r?\n/)[0];
    const parts = line.trim().split(/\s+/).slice(1).map(Number);
    const idle = safeNumber(parts[3]) + safeNumber(parts[4]);
    const total = parts.reduce((sum, value) => sum + safeNumber(value), 0);
    return { idle, total };
  } catch {
    return null;
  }
}

function readLinuxNetworkTotals() {
  try {
    const baseDir = "/sys/class/net";
    const interfaces = fs.readdirSync(baseDir).filter((name) => name !== "lo");
    return interfaces.reduce((totals, name) => {
      const prefix = path.join(baseDir, name, "statistics");
      return {
        rxBytes: totals.rxBytes + safeNumber(fs.readFileSync(path.join(prefix, "rx_bytes"), "utf8").trim()),
        txBytes: totals.txBytes + safeNumber(fs.readFileSync(path.join(prefix, "tx_bytes"), "utf8").trim())
      };
    }, { rxBytes: 0, txBytes: 0 });
  } catch {
    return null;
  }
}

function getDiskStats(targetPath) {
  try {
    const stats = fs.statfsSync(targetPath);
    const blockSize = safeNumber(stats.bsize || stats.frsize, 0);
    const totalBytes = blockSize * safeNumber(stats.blocks);
    const freeBytes = blockSize * safeNumber(stats.bavail);
    const usedBytes = Math.max(0, totalBytes - freeBytes);
    return {
      path: targetPath,
      totalBytes,
      freeBytes,
      usedBytes,
      usedPercent: totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 1000) / 10 : 0
    };
  } catch {
    return null;
  }
}

function formatPercent(value) {
  return Math.round(safeNumber(value) * 10) / 10;
}

export class RuntimeMetrics {
  constructor() {
    this.startedAt = new Date().toISOString();
    this.http = {
      requests: 0,
      rxBytes: 0,
      txBytes: 0
    };
    this.processSample = {
      at: process.hrtime.bigint(),
      cpu: process.cpuUsage()
    };
    this.hostCpuSample = readLinuxCpuSample();
  }

  trackRequest(req, res, next) {
    this.http.requests += 1;
    this.http.rxBytes += safeNumber(req.headers["content-length"], 0);

    let responseBytes = 0;
    const originalWrite = res.write.bind(res);
    const originalEnd = res.end.bind(res);

    res.write = (chunk, ...args) => {
      if (chunk) {
        responseBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
      }
      return originalWrite(chunk, ...args);
    };

    res.end = (chunk, ...args) => {
      if (chunk) {
        responseBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
      }
      this.http.txBytes += responseBytes;
      return originalEnd(chunk, ...args);
    };

    next();
  }

  sampleProcessCpu() {
    const currentUsage = process.cpuUsage();
    const currentAt = process.hrtime.bigint();
    const elapsedMicros = Number(currentAt - this.processSample.at) / 1000;
    const usedMicros =
      (currentUsage.user - this.processSample.cpu.user) +
      (currentUsage.system - this.processSample.cpu.system);

    const coreCount = (os.availableParallelism?.() ?? os.cpus().length) || 1;
    const corePercent = elapsedMicros > 0 ? (usedMicros / elapsedMicros) * 100 : 0;
    const hostPercent = coreCount > 0 ? corePercent / coreCount : corePercent;

    this.processSample = {
      at: currentAt,
      cpu: currentUsage
    };

    return {
      corePercent: formatPercent(corePercent),
      hostPercent: formatPercent(hostPercent)
    };
  }

  sampleHostCpu() {
    const previous = this.hostCpuSample;
    const current = readLinuxCpuSample();
    this.hostCpuSample = current;

    if (!previous || !current) {
      return null;
    }

    const idleDelta = current.idle - previous.idle;
    const totalDelta = current.total - previous.total;
    if (totalDelta <= 0) {
      return null;
    }

    return formatPercent((1 - idleDelta / totalDelta) * 100);
  }

  getSnapshot() {
    const memory = process.memoryUsage();
    const totalMemory = os.totalmem();
    const freeMemory = os.freemem();
    const hostNetwork = readLinuxNetworkTotals();
    const cgroupInfo = readText("/proc/self/cgroup", null);

    return {
      collectedAt: new Date().toISOString(),
      host: {
        hostname: os.hostname(),
        platform: os.platform(),
        release: os.release(),
        arch: os.arch(),
        uptimeSeconds: Math.floor(os.uptime()),
        cpu: {
          cores: os.availableParallelism?.() ?? os.cpus().length,
          loadAverage: os.loadavg().map((value) => formatPercent(value)),
          utilizationPercent: this.sampleHostCpu()
        },
        memory: {
          totalBytes: totalMemory,
          freeBytes: freeMemory,
          usedBytes: Math.max(0, totalMemory - freeMemory),
          usedPercent: totalMemory > 0 ? formatPercent(((totalMemory - freeMemory) / totalMemory) * 100) : 0
        },
        storage: getDiskStats(process.platform === "win32" ? process.cwd().slice(0, 3) : "/"),
        network: hostNetwork
      },
      app: {
        pid: process.pid,
        nodeVersion: process.version,
        uptimeSeconds: Math.floor(process.uptime()),
        startedAt: this.startedAt,
        cpu: this.sampleProcessCpu(),
        memory: {
          rssBytes: memory.rss,
          heapTotalBytes: memory.heapTotal,
          heapUsedBytes: memory.heapUsed,
          externalBytes: memory.external,
          arrayBuffersBytes: memory.arrayBuffers
        },
        traffic: {
          httpRequests: this.http.requests,
          rxBytes: this.http.rxBytes,
          txBytes: this.http.txBytes
        },
        runtime: {
          cwd: process.cwd(),
          env: process.env.NODE_ENV || "production",
          containerized: Boolean(process.env.HOSTNAME && String(process.env.HOSTNAME).length >= 12),
          cgroup: typeof cgroupInfo === "string" ? cgroupInfo.trim() : null
        }
      }
    };
  }
}
