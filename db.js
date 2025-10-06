import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

let db;

export function ensureDatabase() {
  const dataDir = path.join(process.cwd(), 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, 'tickets.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  migrate();
}

function migrate() {
  db.prepare(`CREATE TABLE IF NOT EXISTS guild_config (
    guild_id TEXT PRIMARY KEY,
    staff_role_id TEXT,
    tickets_category_id TEXT,
    max_open_tickets INTEGER,
    open_cooldown_sec INTEGER,
    auto_archive_hours INTEGER
  )`).run();

  db.prepare(`CREATE TABLE IF NOT EXISTS tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    panel_id INTEGER,
    reason TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    claimed_by TEXT,
    priority TEXT NOT NULL DEFAULT 'normal',
    tags TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    closed_at INTEGER,
    archived_at INTEGER,
    close_reason TEXT
  )`).run();

  db.prepare(`CREATE TABLE IF NOT EXISTS ticket_members (
    ticket_id INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    UNIQUE(ticket_id, user_id)
  )`).run();

  // Safe ALTERs for older databases (ignore if already exist)
  try { db.prepare('ALTER TABLE guild_config ADD COLUMN max_open_tickets INTEGER').run(); } catch {}
  try { db.prepare('ALTER TABLE guild_config ADD COLUMN open_cooldown_sec INTEGER').run(); } catch {}
  try { db.prepare('ALTER TABLE guild_config ADD COLUMN auto_archive_hours INTEGER').run(); } catch {}
  try { db.prepare('ALTER TABLE tickets ADD COLUMN priority TEXT NOT NULL DEFAULT "normal"').run(); } catch {}
  try { db.prepare('ALTER TABLE tickets ADD COLUMN tags TEXT NOT NULL DEFAULT ""').run(); } catch {}
  try { db.prepare('ALTER TABLE tickets ADD COLUMN closed_at INTEGER').run(); } catch {}
  try { db.prepare('ALTER TABLE tickets ADD COLUMN archived_at INTEGER').run(); } catch {}
  try { db.prepare('ALTER TABLE tickets ADD COLUMN close_reason TEXT').run(); } catch {}
  try { db.prepare('ALTER TABLE tickets ADD COLUMN panel_id INTEGER').run(); } catch {}

  db.prepare(`CREATE TABLE IF NOT EXISTS ticket_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    note TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  )`).run();

  db.prepare(`CREATE TABLE IF NOT EXISTS panels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    label TEXT NOT NULL,
    category_id TEXT NOT NULL,
    emoji TEXT,
    style TEXT NOT NULL DEFAULT 'Success',
    staff_role_id TEXT,
    max_open_tickets INTEGER,
    open_cooldown_sec INTEGER
  )`).run();

  try { db.prepare('ALTER TABLE panels ADD COLUMN staff_role_id TEXT').run(); } catch {}
  try { db.prepare('ALTER TABLE panels ADD COLUMN max_open_tickets INTEGER').run(); } catch {}
  try { db.prepare('ALTER TABLE panels ADD COLUMN open_cooldown_sec INTEGER').run(); } catch {}
}

export function upsertGuildConfig(guildId, staffRoleId, ticketsCategoryId) {
  const stmt = db.prepare(`INSERT INTO guild_config (guild_id, staff_role_id, tickets_category_id)
    VALUES (@guildId, @staffRoleId, @ticketsCategoryId)
    ON CONFLICT(guild_id) DO UPDATE SET staff_role_id=excluded.staff_role_id, tickets_category_id=excluded.tickets_category_id`);
  stmt.run({ guildId, staffRoleId, ticketsCategoryId });
}

export function getGuildConfig(guildId) {
  return db.prepare('SELECT * FROM guild_config WHERE guild_id = ?').get(guildId);
}

export function ensureTicket(guildId, channelId, userId, reason, panelId = null) {
  const stmt = db.prepare(`INSERT INTO tickets (guild_id, channel_id, user_id, panel_id, reason, status)
    VALUES (@guildId, @channelId, @userId, @panelId, @reason, 'open')`);
  const info = stmt.run({ guildId, channelId, userId, panelId, reason });
  return db.prepare('SELECT * FROM tickets WHERE id = ?').get(info.lastInsertRowid);
}

export function getTicketByChannelId(channelId) {
  return db.prepare('SELECT * FROM tickets WHERE channel_id = ? ORDER BY id DESC').get(channelId);
}

export function updateTicketStatus(ticketId, status) {
  const now = Math.floor(Date.now() / 1000);
  if (status === 'closed') {
    db.prepare('UPDATE tickets SET status = ?, closed_at = ? WHERE id = ?').run(status, now, ticketId);
  } else {
    db.prepare('UPDATE tickets SET status = ? WHERE id = ?').run(status, ticketId);
  }
}

export function claimTicket(ticketId, userId) {
  db.prepare('UPDATE tickets SET claimed_by = ? WHERE id = ?').run(userId, ticketId);
}

export function unclaimTicket(ticketId) {
  db.prepare('UPDATE tickets SET claimed_by = NULL WHERE id = ?').run(ticketId);
}

export function addUserToTicket(ticketId, userId) {
  db.prepare('INSERT OR IGNORE INTO ticket_members (ticket_id, user_id) VALUES (?, ?)').run(ticketId, userId);
}

export function removeUserFromTicket(ticketId, userId) {
  db.prepare('DELETE FROM ticket_members WHERE ticket_id = ? AND user_id = ?').run(ticketId, userId);
}

export function countOpenTicketsForUser(guildId, userId) {
  const row = db.prepare("SELECT COUNT(*) as c FROM tickets WHERE guild_id = ? AND user_id = ? AND status = 'open'").get(guildId, userId);
  return row?.c || 0;
}

export function countOpenTicketsForUserInPanel(guildId, userId, panelId) {
  const row = db.prepare("SELECT COUNT(*) as c FROM tickets WHERE guild_id = ? AND user_id = ? AND status = 'open' AND panel_id = ?").get(guildId, userId, panelId);
  return row?.c || 0;
}

export function getLastTicketCreatedAt(guildId, userId) {
  const row = db.prepare('SELECT created_at FROM tickets WHERE guild_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1').get(guildId, userId);
  return row?.created_at || null;
}

export function getLastTicketCreatedAtInPanel(guildId, userId, panelId) {
  const row = db.prepare('SELECT created_at FROM tickets WHERE guild_id = ? AND user_id = ? AND panel_id = ? ORDER BY id DESC LIMIT 1').get(guildId, userId, panelId);
  return row?.created_at || null;
}

export function upsertAdvancedConfig(guildId, partial) {
  const current = getGuildConfig(guildId) || {};
  const merged = {
    staffRoleId: current.staff_role_id || current.staffRoleId || null,
    ticketsCategoryId: current.tickets_category_id || current.ticketsCategoryId || null,
    maxOpenTickets: partial.maxOpenTickets ?? current.max_open_tickets ?? null,
    openCooldownSec: partial.openCooldownSec ?? current.open_cooldown_sec ?? null,
    autoArchiveHours: partial.autoArchiveHours ?? current.auto_archive_hours ?? null
  };
  db.prepare(`INSERT INTO guild_config (guild_id, staff_role_id, tickets_category_id, max_open_tickets, open_cooldown_sec, auto_archive_hours)
    VALUES (@guildId, @staffRoleId, @ticketsCategoryId, @maxOpenTickets, @openCooldownSec, @autoArchiveHours)
    ON CONFLICT(guild_id) DO UPDATE SET staff_role_id=excluded.staff_role_id, tickets_category_id=excluded.tickets_category_id,
      max_open_tickets=excluded.max_open_tickets, open_cooldown_sec=excluded.open_cooldown_sec, auto_archive_hours=excluded.auto_archive_hours`)
    .run({ guildId, ...merged });
}

export function getClosedTicketsOlderThan(guildId, olderThanEpochSec) {
  return db.prepare(`
    SELECT id, channel_id FROM tickets
    WHERE guild_id = ? AND status = 'closed' AND archived_at IS NULL AND closed_at IS NOT NULL AND closed_at < ?
  `).all(guildId, olderThanEpochSec);
}

export function markTicketArchived(ticketId) {
  const now = Math.floor(Date.now() / 1000);
  db.prepare('UPDATE tickets SET archived_at = ? WHERE id = ?').run(now, ticketId);
}

export function createPanel(guildId, label, categoryId, emoji = null, style = 'Success') {
  const info = db.prepare('INSERT INTO panels (guild_id, label, category_id, emoji, style, staff_role_id, max_open_tickets, open_cooldown_sec) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL)')
    .run(guildId, label, categoryId, emoji, style);
  return db.prepare('SELECT * FROM panels WHERE id = ?').get(info.lastInsertRowid);
}

export function listPanels(guildId) {
  return db.prepare('SELECT * FROM panels WHERE guild_id = ? ORDER BY id ASC').all(guildId);
}

export function getPanelById(panelId) {
  return db.prepare('SELECT * FROM panels WHERE id = ?').get(panelId);
}

export function deletePanel(guildId, panelId) {
  return db.prepare('DELETE FROM panels WHERE id = ? AND guild_id = ?').run(panelId, guildId);
}

export function setTicketPriority(ticketId, priority) {
  const allowed = new Set(['low','normal','high','urgent']);
  const value = allowed.has((priority||'').toLowerCase()) ? priority.toLowerCase() : 'normal';
  db.prepare('UPDATE tickets SET priority = ? WHERE id = ?').run(value, ticketId);
}

export function setTicketTags(ticketId, tagsArray) {
  const sanitized = Array.from(new Set((tagsArray || []).map(t => String(t).trim()).filter(Boolean)));
  const payload = sanitized.join(',');
  db.prepare('UPDATE tickets SET tags = ? WHERE id = ?').run(payload, ticketId);
}

export function getTicketById(ticketId) {
  return db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
}

export function getTicketTags(ticketId) {
  const row = getTicketById(ticketId);
  const tags = (row?.tags || '').split(',').map(t => t.trim()).filter(Boolean);
  return tags;
}

export function addTicketNote(ticketId, userId, note) {
  db.prepare('INSERT INTO ticket_notes (ticket_id, user_id, note) VALUES (?, ?, ?)').run(ticketId, userId, note);
}

export function listTicketNotes(ticketId) {
  return db.prepare('SELECT user_id, note, created_at FROM ticket_notes WHERE ticket_id = ? ORDER BY id ASC').all(ticketId);
}

export function setTicketCloseReason(ticketId, reason) {
  db.prepare('UPDATE tickets SET close_reason = ? WHERE id = ?').run(reason, ticketId);
}

export function updatePanelAdvanced(panelId, fields) {
  const panel = getPanelById(panelId);
  if (!panel) return;
  const staffRoleId = fields.staffRoleId ?? panel.staff_role_id ?? null;
  const maxOpen = fields.maxOpenTickets ?? panel.max_open_tickets ?? null;
  const cooldownSec = fields.openCooldownSec ?? panel.open_cooldown_sec ?? null;
  db.prepare('UPDATE panels SET staff_role_id = ?, max_open_tickets = ?, open_cooldown_sec = ? WHERE id = ?')
    .run(staffRoleId, maxOpen, cooldownSec, panelId);
}

export function getTicketStats(guildId) {
  const open = db.prepare("SELECT COUNT(*) c FROM tickets WHERE guild_id = ? AND status = 'open'").get(guildId)?.c || 0;
  const closed = db.prepare("SELECT COUNT(*) c FROM tickets WHERE guild_id = ? AND status = 'closed'").get(guildId)?.c || 0;
  return { open, closed };
}



