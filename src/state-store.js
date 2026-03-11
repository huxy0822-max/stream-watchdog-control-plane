import fs from "node:fs";
import path from "node:path";

function ensureParentDirectory(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

export class JsonStateStore {
  constructor(filePath) {
    this.filePath = path.resolve(filePath);
  }

  load() {
    ensureParentDirectory(this.filePath);
    if (!fs.existsSync(this.filePath)) {
      return { streams: {}, servers: {}, events: [], meta: {} };
    }

    const raw = fs.readFileSync(this.filePath, "utf8");
    if (!raw.trim()) {
      return { streams: {}, servers: {}, events: [], meta: {} };
    }

    const parsed = JSON.parse(raw);
    return {
      streams: parsed.streams ?? {},
      servers: parsed.servers ?? {},
      events: parsed.events ?? [],
      meta: parsed.meta ?? {}
    };
  }

  save(state) {
    ensureParentDirectory(this.filePath);
    fs.writeFileSync(this.filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }
}
