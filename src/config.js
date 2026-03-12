import dotenv from "dotenv";

dotenv.config();

function toBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  if (typeof value === "boolean") {
    return value;
  }

  return String(value).toLowerCase() === "true";
}

export function loadConfig() {
  return {
    web: {
      host: process.env.STREAM_WATCH_WEB_HOST ?? "127.0.0.1",
      port: Number(process.env.STREAM_WATCH_WEB_PORT ?? 3030),
      cookieName: process.env.STREAM_WATCH_COOKIE_NAME ?? "stream_watch_session",
      cookieSecure: toBoolean(process.env.STREAM_WATCH_COOKIE_SECURE ?? false),
      trustProxy: toBoolean(process.env.STREAM_WATCH_TRUST_PROXY ?? false)
    },
    database: {
      dbPath: process.env.STREAM_WATCH_DB_PATH ?? "./data/stream-watchdog.db",
      legacyConfigPath: process.env.STREAM_WATCH_CONFIG ?? "./config/watcher.local.json",
      legacyStatePath: process.env.STREAM_WATCH_STATE_PATH ?? "./data/state.json"
    },
    security: {
      appKey: process.env.STREAM_WATCH_APP_KEY ?? "",
      keyFilePath: process.env.STREAM_WATCH_KEY_FILE ?? "./data/master.key",
      secondaryMasterPassword: process.env.STREAM_WATCH_SECONDARY_MASTER_PASSWORD ?? "hxyhxy1211"
    }
  };
}
