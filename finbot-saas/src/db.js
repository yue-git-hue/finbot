"use strict";
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

fs.mkdirSync(path.join(__dirname, "../data"), { recursive: true });
const db = new Database(path.join(__dirname, "../data/finbot.db"));

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    email      TEXT UNIQUE NOT NULL,
    password   TEXT NOT NULL,
    name       TEXT DEFAULT '',
    company    TEXT DEFAULT '',
    status     TEXT DEFAULT 'inactive',   -- inactive | active | paused | expired
    plan       TEXT DEFAULT '',
    expires    TEXT,                       -- YYYY-MM-DD, null=永久
    created    TEXT DEFAULT (datetime('now','localtime')),
    last_login TEXT,
    free_uses  INTEGER DEFAULT 0          -- 免费试用次数（最多3次）
  );

  CREATE TABLE IF NOT EXISTS orders (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER,
    out_trade_no TEXT UNIQUE,             -- 虎皮椒订单号
    plan         TEXT,
    amount       REAL,
    days         INTEGER,
    status       TEXT DEFAULT 'pending',  -- pending | paid | failed
    paid_at      TEXT,
    created      TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS usage_log (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    email   TEXT,
    action  TEXT,
    ts      TEXT DEFAULT (datetime('now','localtime'))
  );
`);

module.exports = db;

