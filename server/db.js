'use strict';

const path = require('path');
const Database = require('better-sqlite3');

// Database Initialisation
const DB_PATH = path.join(__dirname, 'database.sqlite');
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Schema
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    google_id   TEXT    UNIQUE NOT NULL,
    name        TEXT    NOT NULL,
    email       TEXT    NOT NULL,
    avatar_url  TEXT,
    created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE IF NOT EXISTS chats (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title         TEXT    NOT NULL DEFAULT 'New Chat',
    messages_json TEXT    NOT NULL DEFAULT '[]',
    updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE INDEX IF NOT EXISTS idx_chats_user_id ON chats(user_id);
`);

// Safe migrations for email/password authentication
try { db.exec(`ALTER TABLE users ADD COLUMN password_hash TEXT;`); } catch {}
try { db.exec(`ALTER TABLE users ADD COLUMN provider TEXT DEFAULT 'google';`); } catch {}
try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email);`); } catch {}

const crypto = require('crypto');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.includes(':')) return false;
  try {
    const [salt, key] = storedHash.split(':');
    const keyBuffer = Buffer.from(key, 'hex');
    const derivedKey = crypto.scryptSync(password, salt, 64);
    return crypto.timingSafeEqual(keyBuffer, derivedKey);
  } catch {
    return false;
  }
}

// Prepared Statements
const stmts = {
  upsertUser: db.prepare(`
    INSERT INTO users (google_id, name, email, avatar_url)
    VALUES (@google_id, @name, @email, @avatar_url)
    ON CONFLICT(google_id) DO UPDATE SET
      name       = excluded.name,
      email      = excluded.email,
      avatar_url = excluded.avatar_url
    RETURNING id, google_id, name, email, avatar_url, created_at
  `),
  getUserById: db.prepare(`SELECT id, google_id, name, email, avatar_url, created_at FROM users WHERE id = ?`),
  getUserByEmail: db.prepare(`SELECT id, google_id, name, email, password_hash, provider, avatar_url, created_at FROM users WHERE email = ?`),
  insertEmailUser: db.prepare(`
    INSERT INTO users (google_id, name, email, password_hash, provider)
    VALUES (@google_id, @name, @email, @password_hash, 'email')
    RETURNING id, name, email, avatar_url, created_at
  `),
  getChatsByUser: db.prepare(`SELECT id, title, updated_at FROM chats WHERE user_id = ? ORDER BY updated_at DESC`),
  getChatById: db.prepare(`SELECT id, user_id, title, messages_json, updated_at FROM chats WHERE id = ? AND user_id = ?`),
  insertChat: db.prepare(`INSERT INTO chats (user_id, title, messages_json, updated_at) VALUES (@user_id, @title, @messages_json, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) RETURNING id`),
  updateChat: db.prepare(`UPDATE chats SET title = @title, messages_json = @messages_json, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = @id AND user_id = @user_id`),
  deleteChat: db.prepare(`DELETE FROM chats WHERE id = ? AND user_id = ?`)
};

function upsertUser(userData) { return stmts.upsertUser.get(userData); }
function getUserById(id) { return stmts.getUserById.get(id) || null; }
function getUserByEmail(email) {
  if (!email) return null;
  return stmts.getUserByEmail.get(email.trim().toLowerCase()) || null;
}
function createEmailUser({ name, email, password }) {
  const cleanEmail = email.trim().toLowerCase();
  const password_hash = hashPassword(password);
  const google_id = 'email:' + cleanEmail;
  return stmts.insertEmailUser.get({
    google_id,
    name: name.trim(),
    email: cleanEmail,
    password_hash
  });
}
function getChatsByUser(userId) { return stmts.getChatsByUser.all(userId); }
function getChatById(chatId, userId) {
  const row = stmts.getChatById.get(chatId, userId);
  if (!row) return null;
  try { row.messages = JSON.parse(row.messages_json); } catch { row.messages = []; }
  return row;
}
function saveChat({ userId, chatId, title, messages }) {
  const messagesJson = JSON.stringify(messages || []);
  const safeTitle = (title || 'New Chat').slice(0, 120);
  if (chatId) {
    const info = stmts.updateChat.run({ id: chatId, user_id: userId, title: safeTitle, messages_json: messagesJson });
    if (info.changes > 0) return chatId;
  }
  const row = stmts.insertChat.get({ user_id: userId, title: safeTitle, messages_json: messagesJson });
  return row.id;
}
function deleteChat(chatId, userId) {
  const info = stmts.deleteChat.run(chatId, userId);
  return info.changes > 0;
}

module.exports = {
  db,
  upsertUser,
  getUserById,
  getUserByEmail,
  createEmailUser,
  verifyPassword,
  hashPassword,
  getChatsByUser,
  getChatById,
  saveChat,
  deleteChat
};
