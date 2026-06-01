import { randomBytes } from "node:crypto";
import { getDb } from "../db/index.js";

export interface AuthUser {
  username: string;
  provider: "steemconnect";
  accessToken?: string;
}

export interface AuthSession {
  token: string;
  user: AuthUser;
  expiry: string;
}

type SessionRow = {
  token: string;
  username: string;
  provider: string;
  access_token: string | null;
  expiry: string;
};

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 3; // 3 days

export function createSession(user: AuthUser, ttlSeconds?: number): AuthSession {
  const token = randomBytes(36).toString("base64url");
  const ttlMs = typeof ttlSeconds === "number"
    ? Math.max(60_000, Math.min(SESSION_TTL_MS, ttlSeconds * 1000))
    : SESSION_TTL_MS;
  const expiry = new Date(Date.now() + ttlMs).toISOString();

  getDb().prepare(`
    INSERT OR REPLACE INTO sessions (token, username, provider, access_token, expiry)
    VALUES (?, ?, ?, ?, ?)
  `).run(token, user.username, user.provider, user.accessToken ?? null, expiry);

  return { token, user, expiry };
}

export function getSession(token: string | undefined): AuthSession | undefined {
  if (!token) return undefined;
  const db = getDb();

  const row = db.prepare(`
    SELECT token, username, provider, access_token, expiry
    FROM sessions WHERE token = ?
  `).get(token) as SessionRow | undefined;

  if (!row) return undefined;

  if (Date.parse(row.expiry) <= Date.now()) {
    db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
    return undefined;
  }

  return {
    token: row.token,
    user: {
      username: row.username,
      provider: "steemconnect",
      accessToken: row.access_token ?? undefined
    },
    expiry: row.expiry
  };
}

export function deleteSession(token: string | undefined): void {
  if (!token) return;
  getDb().prepare("DELETE FROM sessions WHERE token = ?").run(token);
}
