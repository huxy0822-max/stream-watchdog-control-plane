import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { Client } from "ssh2";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(__dirname, "..");

const EXCLUDED_DIR_NAMES = new Set([
  ".git",
  ".github",
  ".npm-cache",
  ".playwright-cli",
  "data",
  "deploy",
  "node_modules",
  "output",
  "scripts",
  "skills",
  "tools"
]);

const EXCLUDED_RELATIVE_PATHS = new Set([
  ".env",
  ".env.production.local",
  ".env.test.local",
  "config/watcher.local.json"
]);

function normalizeRemotePath(value) {
  return String(value ?? "").replace(/\\/g, "/");
}

export function remoteQuote(value) {
  return `'${String(value ?? "").replace(/'/g, `'\\''`)}'`;
}

export function timestampTag(date = new Date()) {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}

export function loadProductionDeployEnv() {
  const deployEnvPath = path.join(repoRoot, ".env.production.local");
  if (fs.existsSync(deployEnvPath)) {
    dotenv.config({ path: deployEnvPath, override: false });
  }
}

export function loadTestProfileEnv() {
  const testEnvPath = path.join(repoRoot, ".env.test.local");
  if (fs.existsSync(testEnvPath)) {
    dotenv.config({ path: testEnvPath, override: false });
  }
}

export function getCurrentGitSha() {
  return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8"
  }).trim();
}

export function getProductionConfig() {
  const host = String(process.env.PROD_DEPLOY_HOST ?? "").trim();
  const user = String(process.env.PROD_DEPLOY_USER ?? "root").trim() || "root";
  const password = String(process.env.PROD_DEPLOY_PASSWORD ?? "").trim();
  const port = Number(process.env.PROD_DEPLOY_PORT ?? 22);
  const appDir = normalizeRemotePath(process.env.PROD_DEPLOY_APP_DIR ?? "/opt/stream-watchdog");
  const backupRoot = normalizeRemotePath(process.env.PROD_DEPLOY_BACKUP_ROOT ?? "/opt/stream-watchdog-releases");

  if (!host) {
    throw new Error("Missing PROD_DEPLOY_HOST. Copy .env.production.example to .env.production.local and fill it.");
  }

  if (!password) {
    throw new Error("Missing PROD_DEPLOY_PASSWORD. Copy .env.production.example to .env.production.local and fill it.");
  }

  if (!Number.isFinite(port) || port <= 0) {
    throw new Error("PROD_DEPLOY_PORT must be a valid positive integer.");
  }

  return {
    host,
    user,
    password,
    port,
    appDir,
    backupRoot
  };
}

export function parseArgValue(flagName, defaultValue = "") {
  const flag = `--${flagName}`;
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return defaultValue;
  }

  const nextValue = process.argv[index + 1];
  if (!nextValue || nextValue.startsWith("--")) {
    return defaultValue;
  }

  return nextValue;
}

export function hasArg(flagName) {
  return process.argv.includes(`--${flagName}`);
}

export function collectProjectFiles(currentDir = repoRoot, relativeDir = "") {
  const entries = fs.readdirSync(currentDir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const relativePath = normalizeRemotePath(path.posix.join(relativeDir, entry.name));
    if (EXCLUDED_RELATIVE_PATHS.has(relativePath)) {
      continue;
    }

    if (entry.isDirectory()) {
      if (EXCLUDED_DIR_NAMES.has(entry.name)) {
        continue;
      }

      files.push(...collectProjectFiles(path.join(currentDir, entry.name), relativePath));
      continue;
    }

    if (entry.isFile()) {
      files.push(relativePath);
    }
  }

  return files.sort((left, right) => left.localeCompare(right, "en"));
}

export async function connectRemote(config) {
  const client = new Client();
  await new Promise((resolve, reject) => {
    client.once("ready", resolve);
    client.once("error", reject);
    client.connect({
      host: config.host,
      port: config.port,
      username: config.user,
      password: config.password,
      readyTimeout: 20000,
      tryKeyboard: true
    });
  });
  return client;
}

export async function openSftp(client) {
  return new Promise((resolve, reject) => {
    client.sftp((error, sftp) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(sftp);
    });
  });
}

export async function execRemote(client, command) {
  return new Promise((resolve, reject) => {
    client.exec(`bash -lc ${remoteQuote(command)}`, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }

      let stdout = "";
      let stderr = "";

      stream.on("close", (code, signal) => {
        if ((code ?? 0) !== 0) {
          reject(new Error(stderr.trim() || stdout.trim() || `Remote command failed with code ${code ?? 0}${signal ? ` (${signal})` : ""}`));
          return;
        }

        resolve({ stdout, stderr, code: code ?? 0, signal: signal ?? null });
      });

      stream.on("data", (chunk) => {
        stdout += chunk.toString("utf8");
      });

      stream.stderr.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
      });
    });
  });
}

async function mkdirRemote(sftp, remoteDir) {
  await new Promise((resolve, reject) => {
    sftp.mkdir(remoteDir, (error) => {
      if (!error) {
        resolve();
        return;
      }

      if (/failure|exists/i.test(String(error.message ?? ""))) {
        resolve();
        return;
      }

      reject(error);
    });
  });
}

async function putRemoteFile(sftp, localPath, remotePath) {
  await new Promise((resolve, reject) => {
    sftp.fastPut(localPath, remotePath, (error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

export async function uploadProjectTree(sftp, remoteRoot, relativeFiles) {
  const ensuredDirs = new Set();

  async function ensureRemoteDirTree(targetDir) {
    const normalized = normalizeRemotePath(targetDir);
    const parts = normalized.split("/").filter(Boolean);
    let current = normalized.startsWith("/") ? "/" : "";

    for (const part of parts) {
      current = current === "/"
        ? `/${part}`
        : current
          ? `${current}/${part}`
          : part;

      if (ensuredDirs.has(current)) {
        continue;
      }

      await mkdirRemote(sftp, current);
      ensuredDirs.add(current);
    }
  }

  await ensureRemoteDirTree(remoteRoot);

  for (const relativePath of relativeFiles) {
    const localPath = path.join(repoRoot, ...relativePath.split("/"));
    const remotePath = path.posix.join(remoteRoot, relativePath);
    const remoteDir = path.posix.dirname(remotePath);
    await ensureRemoteDirTree(remoteDir);
    await putRemoteFile(sftp, localPath, remotePath);
  }
}

export async function listRemoteBackups(client, config) {
  const result = await execRemote(client, `
    if [ ! -d ${remoteQuote(config.backupRoot)} ]; then
      exit 0
    fi
    find ${remoteQuote(config.backupRoot)} -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort -r
  `);

  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}
