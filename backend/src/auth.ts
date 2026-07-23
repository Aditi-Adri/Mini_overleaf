import { randomBytes } from "node:crypto";
import { OAuth2Client } from "google-auth-library";
import { config } from "./config.js";
import { pool } from "./db.js";

export interface GoogleProfile {
  id: string;
  email: string;
  name: string;
  pictureUrl: string | null;
}

export interface User {
  id: string;
  email: string;
  name: string;
  pictureUrl: string | null;
}

export interface SessionResult {
  token: string;
  expiresAt: string;
}

export interface SavedProject {
  id: string;
  name: string;
  createdAt: string;
  savedAt: string;
  /** Whether this saved reference carries edit access (the saver had an edit token at save time) — a read-only save only gets a view link back. */
  canEdit: boolean;
  editToken: string | null;
}

const oauthClient = new OAuth2Client();

/** Verifies a Google ID token was genuinely issued by Google *for this app* (audience match) and hasn't expired/been tampered with. */
export async function verifyGoogleIdToken(idToken: string): Promise<GoogleProfile> {
  if (!config.googleClientId) {
    throw new Error("Google sign-in is not configured on this server.");
  }
  const ticket = await oauthClient.verifyIdToken({ idToken, audience: config.googleClientId });
  const payload = ticket.getPayload();
  if (!payload?.sub || !payload.email) {
    throw new Error("Google did not return a usable identity for this token.");
  }
  return { id: payload.sub, email: payload.email, name: payload.name ?? payload.email, pictureUrl: payload.picture ?? null };
}

function rowToUser(row: { id: string; email: string; name: string; picture_url: string | null }): User {
  return { id: row.id, email: row.email, name: row.name, pictureUrl: row.picture_url };
}

export async function upsertUser(profile: GoogleProfile): Promise<User> {
  const result = await pool.query(
    `INSERT INTO users (id, email, name, picture_url) VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name, picture_url = EXCLUDED.picture_url
     RETURNING id, email, name, picture_url`,
    [profile.id, profile.email, profile.name, profile.pictureUrl]
  );
  return rowToUser(result.rows[0]);
}

export async function createSession(userId: string): Promise<SessionResult> {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + config.sessionTtlDays * 24 * 60 * 60 * 1000);
  await pool.query("INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)", [token, userId, expiresAt]);
  return { token, expiresAt: expiresAt.toISOString() };
}

export async function getSessionUser(token: string | undefined | null): Promise<User | null> {
  if (!token) return null;
  const result = await pool.query(
    `SELECT u.id, u.email, u.name, u.picture_url FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token = $1 AND s.expires_at > now()`,
    [token]
  );
  return result.rows[0] ? rowToUser(result.rows[0]) : null;
}

export async function deleteSession(token: string): Promise<void> {
  await pool.query("DELETE FROM sessions WHERE token = $1", [token]);
}

/** `editToken` is only stored if it actually verifies for this project — a caller can't grant themselves edit access on save just by claiming one. */
export async function saveProjectForUser(userId: string, projectId: string, editToken: string | null): Promise<void> {
  await pool.query(
    `INSERT INTO saved_projects (user_id, project_id, edit_token) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, project_id) DO UPDATE SET edit_token = COALESCE(EXCLUDED.edit_token, saved_projects.edit_token)`,
    [userId, projectId, editToken]
  );
}

export async function unsaveProjectForUser(userId: string, projectId: string): Promise<void> {
  await pool.query("DELETE FROM saved_projects WHERE user_id = $1 AND project_id = $2", [userId, projectId]);
}

export async function listSavedProjects(userId: string): Promise<SavedProject[]> {
  const result = await pool.query(
    `SELECT p.id, p.name, p.created_at, sp.saved_at, sp.edit_token FROM saved_projects sp
     JOIN projects p ON p.id = sp.project_id
     WHERE sp.user_id = $1
     ORDER BY sp.saved_at DESC`,
    [userId]
  );
  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    createdAt: row.created_at.toISOString(),
    savedAt: row.saved_at.toISOString(),
    canEdit: row.edit_token !== null,
    editToken: row.edit_token,
  }));
}

export async function isProjectSavedByUser(userId: string, projectId: string): Promise<boolean> {
  const result = await pool.query("SELECT 1 FROM saved_projects WHERE user_id = $1 AND project_id = $2", [userId, projectId]);
  return (result.rowCount ?? 0) > 0;
}
