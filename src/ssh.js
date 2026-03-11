import fs from "node:fs";
import { Client } from "ssh2";

function buildConnectionOptions(server, timeoutSeconds) {
  const hasPassword = Boolean(server.password);
  const hasPrivateKey = Boolean(server.privateKeyPath);
  let passwordAttempted = false;
  let keyboardAttempted = false;
  let publicKeyAttempted = false;

  const options = {
    host: server.host,
    port: server.port ?? 22,
    username: server.username,
    readyTimeout: timeoutSeconds * 1000,
    tryKeyboard: hasPassword,
    authHandler(methodsLeft, _partialSuccess, callback) {
      const canUse = (method) => !Array.isArray(methodsLeft) || methodsLeft.length === 0 || methodsLeft.includes(method);

      if (hasPassword && !passwordAttempted && canUse("password")) {
        passwordAttempted = true;
        callback({
          type: "password",
          username: server.username,
          password: server.password
        });
        return;
      }

      if (hasPassword && !keyboardAttempted && canUse("keyboard-interactive")) {
        keyboardAttempted = true;
        callback({
          type: "keyboard-interactive",
          username: server.username
        });
        return;
      }

      if (hasPrivateKey && !publicKeyAttempted && canUse("publickey")) {
        publicKeyAttempted = true;
        callback({
          type: "publickey",
          username: server.username,
          key: options.privateKey
        });
        return;
      }

      callback(false);
    }
  };

  if (server.password) {
    options.password = server.password;
  } else if (server.privateKeyPath) {
    options.privateKey = fs.readFileSync(server.privateKeyPath, "utf8");
  } else {
    throw new Error(`Server ${server.id} is missing password or privateKeyPath`);
  }

  return options;
}

function connectClient(client, options) {
  return new Promise((resolve, reject) => {
    client.on("ready", resolve);
    client.on("error", reject);
    if (options.password) {
      client.on("keyboard-interactive", (_name, _instructions, _lang, _prompts, finish) => {
        finish(_prompts.map(() => options.password));
      });
    }
    client.connect(options);
  });
}

function execCommand(client, command, timeoutSeconds) {
  return new Promise((resolve, reject) => {
    client.exec(command, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }

      let stdout = "";
      let stderr = "";
      let finished = false;

      const timeout = setTimeout(() => {
        if (finished) {
          return;
        }

        finished = true;
        stream.close();
        reject(new Error(`SSH command timed out after ${timeoutSeconds}s: ${command}`));
      }, timeoutSeconds * 1000);

      stream.on("close", (code, signal) => {
        if (finished) {
          return;
        }

        finished = true;
        clearTimeout(timeout);
        resolve({
          code: code ?? 0,
          signal: signal ?? null,
          stdout,
          stderr
        });
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

export class SshSession {
  constructor(server, timeoutSeconds = 15) {
    this.server = server;
    this.timeoutSeconds = timeoutSeconds;
    this.client = new Client();
    this.connected = false;
  }

  async connect() {
    if (this.connected) {
      return;
    }

    const options = buildConnectionOptions(this.server, this.timeoutSeconds);
    await connectClient(this.client, options);
    this.connected = true;
  }

  async run(command, timeoutSeconds = this.timeoutSeconds) {
    if (!this.connected) {
      await this.connect();
    }

    return execCommand(this.client, command, timeoutSeconds);
  }

  close() {
    if (!this.connected) {
      return;
    }

    this.client.end();
    this.connected = false;
  }
}
