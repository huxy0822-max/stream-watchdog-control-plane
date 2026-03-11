import fs from "node:fs";
import path from "node:path";
import { Client } from "ssh2";

const host = process.env.SSH_HOST;
const port = Number(process.env.SSH_PORT ?? 22);
const username = process.env.SSH_USER;
const password = process.env.SSH_PASSWORD;
const [localPathArg, remotePathArg] = process.argv.slice(2);

if (!host || !username || !password || !localPathArg || !remotePathArg) {
  console.error("Usage: set SSH_HOST, SSH_USER, SSH_PASSWORD and pass localPath remotePath.");
  process.exit(1);
}

const localPath = path.resolve(localPathArg);
const remotePath = remotePathArg.replace(/\\/g, "/");

function connect() {
  return new Promise((resolve, reject) => {
    const client = new Client();
    client.on("ready", () => resolve(client));
    client.on("error", reject);
    client.connect({
      host,
      port,
      username,
      password,
      readyTimeout: 20000,
      tryKeyboard: true,
      authHandler(methodsLeft, _partialSuccess, callback) {
        if (!methodsLeft || methodsLeft.includes("password")) {
          callback({ type: "password", username, password });
          return;
        }

        if (methodsLeft.includes("keyboard-interactive")) {
          callback({ type: "keyboard-interactive", username });
          return;
        }

        callback(false);
      }
    });

    client.on("keyboard-interactive", (_name, _instructions, _lang, prompts, finish) => {
      finish(prompts.map(() => password));
    });
  });
}

function getSftp(client) {
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

function mkdirIfNeeded(sftp, directory) {
  return new Promise((resolve) => {
    sftp.mkdir(directory, { mode: 0o755 }, () => resolve());
  });
}

function fastPut(sftp, source, target) {
  return new Promise((resolve, reject) => {
    sftp.fastPut(source, target, (error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

async function ensureRemoteDirectoryTree(sftp, targetPath) {
  const parts = targetPath.split("/").filter(Boolean);
  let current = targetPath.startsWith("/") ? "/" : "";
  for (const part of parts) {
    current = current === "/" ? `/${part}` : current ? `${current}/${part}` : part;
    await mkdirIfNeeded(sftp, current);
  }
}

async function uploadPath(sftp, sourcePath, targetPath) {
  const stats = fs.statSync(sourcePath);
  if (stats.isDirectory()) {
    await ensureRemoteDirectoryTree(sftp, targetPath);
    for (const entry of fs.readdirSync(sourcePath)) {
      await uploadPath(
        sftp,
        path.join(sourcePath, entry),
        `${targetPath}/${entry}`.replace(/\/+/g, "/")
      );
    }
    return;
  }

  const targetDir = path.posix.dirname(targetPath);
  await ensureRemoteDirectoryTree(sftp, targetDir);
  await fastPut(sftp, sourcePath, targetPath);
}

const client = await connect();
try {
  const sftp = await getSftp(client);
  await uploadPath(sftp, localPath, remotePath);
} finally {
  client.end();
}
