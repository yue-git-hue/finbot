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
    free_uses  INTEGER DEFAULT 0,         -- 免费试用次数（最多10次）
    is_pro     INTEGER DEFAULT 0,         -- 是否强化版（0=基础版 1=强化版）
    month_uses INTEGER DEFAULT 0,         -- 本月已识别张数
    month_year TEXT    DEFAULT ''         -- 当前计费月份 YYYY-MM
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


// 兼容旧数据库：自动添加字段
try { db.exec("ALTER TABLE users ADD COLUMN free_uses INTEGER DEFAULT 0"); } catch(e) {}
try { db.exec("ALTER TABLE users ADD COLUMN is_pro INTEGER DEFAULT 0"); } catch(e) {}
try { db.exec("ALTER TABLE users ADD COLUMN month_uses INTEGER DEFAULT 0"); } catch(e) {}
try { db.exec("ALTER TABLE users ADD COLUMN month_year TEXT DEFAULT ''"); } catch(e) {}

// 审核记录表
db.exec(`
  CREATE TABLE IF NOT EXISTS records (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL,
    file_name   TEXT,
    doc_type    TEXT,
    date        TEXT,
    amount      REAL,
    tax         REAL,
    party       TEXT,
    doc_no      TEXT,
    tax_no      TEXT,
    title       TEXT,
    category    TEXT,
    memo        TEXT,
    manual_review TEXT,
    risks       TEXT,   -- JSON string
    duplicate   INTEGER DEFAULT 0,
    edited      INTEGER DEFAULT 0,
    pages       INTEGER DEFAULT 1,
    created_at  TEXT DEFAULT (datetime('now','localtime'))
  );
`);

// 验证码表
db.exec(`
  CREATE TABLE IF NOT EXISTS email_codes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    email      TEXT NOT NULL,
    code       TEXT NOT NULL,
    type       TEXT DEFAULT 'register',  -- register | reset
    used       INTEGER DEFAULT 0,
    expire_at  TEXT NOT NULL,
    ip         TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
`);

// 企业规则配置表
db.exec(`
  CREATE TABLE IF NOT EXISTS company_rules (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER UNIQUE NOT NULL,
    rules_json TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  );
`);

module.exports = db;
