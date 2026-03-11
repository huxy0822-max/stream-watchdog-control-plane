import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function ensureParentDirectory(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function normalizeKeyMaterial(rawValue) {
  if (!rawValue) {
    return null;
  }

  const trimmed = rawValue.trim();
  if (/^[a-fA-F0-9]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }

  try {
    const base64 = Buffer.from(trimmed, "base64");
    if (base64.length >= 32) {
      return base64.subarray(0, 32);
    }
  } catch {
    // Fall through to scrypt below.
  }

  return crypto.scryptSync(trimmed, "stream-watchdog-app-key", 32);
}

function formatStoredKey(buffer) {
  return buffer.toString("base64");
}

export function loadOrCreateMasterKey(filePath, envValue) {
  if (envValue) {
    return normalizeKeyMaterial(envValue);
  }

  const resolved = path.resolve(filePath);
  ensureParentDirectory(resolved);
  if (fs.existsSync(resolved)) {
    return normalizeKeyMaterial(fs.readFileSync(resolved, "utf8"));
  }

  const generated = crypto.randomBytes(32);
  fs.writeFileSync(resolved, `${formatStoredKey(generated)}\n`, "utf8");
  return generated;
}

export function encryptText(plainText, key) {
  if (!plainText) {
    return null;
  }

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(String(plainText), "utf8"),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();
  return [
    "v1",
    iv.toString("base64"),
    tag.toString("base64"),
    encrypted.toString("base64")
  ].join(":");
}

export function decryptText(cipherText, key) {
  if (!cipherText) {
    return null;
  }

  const [version, ivBase64, tagBase64, dataBase64] = String(cipherText).split(":");
  if (version !== "v1" || !ivBase64 || !tagBase64 || !dataBase64) {
    throw new Error("Unsupported encrypted payload format");
  }

  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(ivBase64, "base64")
  );
  decipher.setAuthTag(Buffer.from(tagBase64, "base64"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataBase64, "base64")),
    decipher.final()
  ]);
  return decrypted.toString("utf8");
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("base64");
  const derived = crypto.scryptSync(password, salt, 64).toString("base64");
  return `scrypt:${salt}:${derived}`;
}

export function verifyPassword(password, storedHash) {
  if (!storedHash) {
    return false;
  }

  const [algorithm, salt, encodedHash] = String(storedHash).split(":");
  if (algorithm !== "scrypt" || !salt || !encodedHash) {
    return false;
  }

  const derived = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(encodedHash, "base64");
  return expected.length === derived.length && crypto.timingSafeEqual(expected, derived);
}

export function issueSessionToken() {
  return crypto.randomBytes(32).toString("base64url");
}

export function hashSessionToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

export function createId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}
