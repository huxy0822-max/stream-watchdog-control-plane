import { Client } from "ssh2";

const host = process.env.SSH_HOST;
const port = Number(process.env.SSH_PORT ?? 22);
const username = process.env.SSH_USER;
const password = process.env.SSH_PASSWORD;
const command = process.argv.slice(2).join(" ");

if (!host || !username || !password || !command) {
  console.error("Usage: set SSH_HOST, SSH_USER, SSH_PASSWORD and pass a command.");
  process.exit(1);
}

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

function execCommand(client, commandText) {
  return new Promise((resolve, reject) => {
    client.exec(commandText, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }

      let stdout = "";
      let stderr = "";

      stream.on("close", (code) => {
        resolve({ code: code ?? 0, stdout, stderr });
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

const client = await connect();
try {
  const result = await execCommand(client, command);
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  process.exitCode = result.code;
} finally {
  client.end();
}

