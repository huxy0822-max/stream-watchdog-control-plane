import { spawn } from "node:child_process";
import { repoRoot, loadTestProfileEnv } from "./production-remote.mjs";

const profileName = String(process.argv[2] ?? "test").trim() || "test";
const extraArgs = process.argv.slice(3);

if (profileName !== "test") {
  throw new Error(`Unknown local profile: ${profileName}`);
}

loadTestProfileEnv();

const profileEnv = {
  STREAM_WATCH_WEB_HOST: process.env.STREAM_WATCH_WEB_HOST ?? "127.0.0.1",
  STREAM_WATCH_WEB_PORT: process.env.STREAM_WATCH_WEB_PORT ?? "3031",
  STREAM_WATCH_COOKIE_NAME: process.env.STREAM_WATCH_COOKIE_NAME ?? "stream_watch_session_test",
  STREAM_WATCH_DB_PATH: process.env.STREAM_WATCH_DB_PATH ?? "./data/stream-watchdog.test.db",
  STREAM_WATCH_KEY_FILE: process.env.STREAM_WATCH_KEY_FILE ?? "./data/master.test.key",
  STREAM_WATCH_STATE_PATH: process.env.STREAM_WATCH_STATE_PATH ?? "./data/state.test.json",
  STREAM_WATCH_CONFIG: process.env.STREAM_WATCH_CONFIG ?? "./config/watcher.example.json"
};

const child = spawn(process.execPath, ["src/index.js", ...extraArgs], {
  cwd: repoRoot,
  stdio: "inherit",
  env: {
    ...process.env,
    ...profileEnv
  }
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});
