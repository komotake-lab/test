'use strict';

/**
 * ストレージ層。
 *
 * MySQL の接続情報が .env にあれば MySQL を使い、無い / 接続できない場合は
 * data/store.json へのファイル保存に自動フォールバックする。
 * 呼び出し側（server.js）はどちらが使われているか意識しない。
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const DATA_DIR = path.join(__dirname, 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');

const EMPTY_STATE = () => ({
  vision: { company: '', target: '', details: '' },
  items: [],
  globalMinutes: []
});

class Store {
  constructor() {
    this.mode = 'file';      // 'mysql' | 'file'
    this.pool = null;
    this.cache = EMPTY_STATE();
    this.users = [];         // file モード時のみ使用
    this.writeQueue = Promise.resolve();
  }

  get connected() {
    return this.mode === 'mysql';
  }

  // ---------- 初期化 ----------

  async init() {
    let dbConfig = null;

    try {
      dbConfig = await resolveDbConfig();
    } catch (err) {
      // シークレット取得に失敗した場合は起動を止めない（ファイル保存で継続）
      console.warn('[store] DB接続情報を取得できません:', err.message);
    }

    if (dbConfig) {
      try {
        const mysql = require('mysql2/promise');
        this.pool = mysql.createPool({
          host: dbConfig.host,
          port: dbConfig.port,
          user: dbConfig.user,
          password: dbConfig.password,
          database: dbConfig.database,
          waitForConnections: true,
          connectionLimit: Number(process.env.DB_POOL_SIZE || 10),
          charset: 'utf8mb4',
          ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: true } : undefined
        });
        const conn = await this.pool.getConnection();
        await conn.ping();
        conn.release();
        await this.ensureSchema();
        this.mode = 'mysql';
        console.log(`[store] MySQL に接続しました (${dbConfig.host}/${dbConfig.database}) [認証情報: ${dbConfig.source}]`);
      } catch (err) {
        console.warn('[store] MySQL に接続できません。ファイル保存に切り替えます:', err.message);
        if (this.pool) { try { await this.pool.end(); } catch (e) { /* noop */ } }
        this.pool = null;
        this.mode = 'file';
      }
    } else {
      console.log('[store] DB 設定が無いためファイル保存で起動します (data/store.json)');
    }

    if (this.mode === 'file') await this.loadFile();
    else await this.loadFromMysql();
  }

  async ensureSchema() {
    const schema = await fsp.readFile(path.join(__dirname, 'db', 'schema.sql'), 'utf8');
    // CREATE TABLE 文を順に流す（既存テーブルは IF NOT EXISTS でスキップ）
    const statements = schema
      .split(/;\s*$/m)
      .map(s => s.replace(/^\s*--.*$/gm, '').trim())
      .filter(s => s.length > 0 && !/^(USE|CREATE\s+DATABASE)/i.test(s));

    for (const stmt of statements) {
      await this.pool.query(stmt);
    }
  }

  // ---------- ファイルモード ----------

  async loadFile() {
    try {
      const raw = await fsp.readFile(STORE_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      this.cache = Object.assign(EMPTY_STATE(), {
        vision: parsed.vision || EMPTY_STATE().vision,
        items: Array.isArray(parsed.items) ? parsed.items : [],
        globalMinutes: Array.isArray(parsed.globalMinutes) ? parsed.globalMinutes : []
      });
      this.users = Array.isArray(parsed.users) ? parsed.users : [];
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn('[store] store.json を読めません:', err.message);
      this.cache = EMPTY_STATE();
      this.users = [];
    }
  }

  // 直列化して書き込む（同時書き込みによる破損を防ぐ）
  persistFile() {
    this.writeQueue = this.writeQueue.then(async () => {
      const payload = JSON.stringify({
        vision: this.cache.vision,
        items: this.cache.items,
        globalMinutes: this.cache.globalMinutes,
        users: this.users
      }, null, 2);

      await fsp.mkdir(DATA_DIR, { recursive: true });
      const tmp = STORE_FILE + '.tmp';
      await fsp.writeFile(tmp, payload, 'utf8');
      await fsp.rename(tmp, STORE_FILE);   // 原子的に差し替える
    }).catch(err => {
      console.error('[store] 保存に失敗しました:', err.message);
    });
    return this.writeQueue;
  }

  // ---------- MySQL モード ----------

  async loadFromMysql() {
    const state = EMPTY_STATE();

    const [visionRows] = await this.pool.query('SELECT company, target, details FROM vision WHERE id = 1');
    if (visionRows.length) state.vision = {
      company: visionRows[0].company || '',
      target: visionRows[0].target || '',
      details: visionRows[0].details || ''
    };

    const [itemRows] = await this.pool.query('SELECT payload FROM items ORDER BY created_at ASC');
    state.items = itemRows.map(r => parseJson(r.payload)).filter(Boolean);

    const [minuteRows] = await this.pool.query('SELECT payload FROM minutes ORDER BY created_at ASC');
    state.globalMinutes = minuteRows.map(r => parseJson(r.payload)).filter(Boolean);

    this.cache = state;
  }

  // ---------- 公開 API（データ） ----------

  getState() {
    return this.cache;
  }

  async saveVision(vision) {
    this.cache.vision = {
      company: String(vision?.company || ''),
      target: String(vision?.target || ''),
      details: String(vision?.details || '')
    };

    if (this.mode === 'mysql') {
      await this.pool.query(
        `INSERT INTO vision (id, company, target, details) VALUES (1, ?, ?, ?)
         ON DUPLICATE KEY UPDATE company = VALUES(company), target = VALUES(target), details = VALUES(details)`,
        [this.cache.vision.company, this.cache.vision.target, this.cache.vision.details]
      );
    } else {
      await this.persistFile();
    }
    return this.cache.vision;
  }

  async saveItem(item) {
    if (!item || !item.id) throw new Error('item.id が必要です');

    const idx = this.cache.items.findIndex(i => i.id === item.id);
    if (idx >= 0) this.cache.items[idx] = item;
    else this.cache.items.push(item);

    if (this.mode === 'mysql') {
      await this.pool.query(
        `INSERT INTO items (id, type, status, title, payload) VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE type = VALUES(type), status = VALUES(status),
                                 title = VALUES(title), payload = VALUES(payload)`,
        [item.id, item.type || '', item.status || 'active', item.title || '', JSON.stringify(item)]
      );
    } else {
      await this.persistFile();
    }
    return item;
  }

  async deleteItem(itemId) {
    this.cache.items = this.cache.items.filter(i => i.id !== itemId);
    if (this.mode === 'mysql') await this.pool.query('DELETE FROM items WHERE id = ?', [itemId]);
    else await this.persistFile();
  }

  async saveMinute(minute) {
    if (!minute || !minute.id) throw new Error('minute.id が必要です');

    const idx = this.cache.globalMinutes.findIndex(m => m.id === minute.id);
    if (idx >= 0) this.cache.globalMinutes[idx] = minute;
    else this.cache.globalMinutes.push(minute);

    if (this.mode === 'mysql') {
      await this.pool.query(
        `INSERT INTO minutes (id, title, meeting_date, related_item_id, payload) VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE title = VALUES(title), meeting_date = VALUES(meeting_date),
                                 related_item_id = VALUES(related_item_id), payload = VALUES(payload)`,
        [minute.id, minute.title || '', toMysqlDateTime(minute.date), minute.relatedWGId || null, JSON.stringify(minute)]
      );
    } else {
      await this.persistFile();
    }
    return minute;
  }

  async deleteMinute(minuteId) {
    this.cache.globalMinutes = this.cache.globalMinutes.filter(m => m.id !== minuteId);
    if (this.mode === 'mysql') await this.pool.query('DELETE FROM minutes WHERE id = ?', [minuteId]);
    else await this.persistFile();
  }

  /** CSV 復元用：全データを置き換える */
  async replaceAll(data) {
    const next = {
      vision: Object.assign(EMPTY_STATE().vision, data?.vision || {}),
      items: Array.isArray(data?.items) ? data.items.filter(i => i && i.id) : [],
      globalMinutes: Array.isArray(data?.globalMinutes) ? data.globalMinutes.filter(m => m && m.id) : []
    };
    this.cache = next;

    if (this.mode === 'mysql') {
      const conn = await this.pool.getConnection();
      try {
        await conn.beginTransaction();
        await conn.query('DELETE FROM items');
        await conn.query('DELETE FROM minutes');
        await conn.query(
          `INSERT INTO vision (id, company, target, details) VALUES (1, ?, ?, ?)
           ON DUPLICATE KEY UPDATE company = VALUES(company), target = VALUES(target), details = VALUES(details)`,
          [next.vision.company, next.vision.target, next.vision.details]
        );
        for (const item of next.items) {
          await conn.query(
            'INSERT INTO items (id, type, status, title, payload) VALUES (?, ?, ?, ?, ?)',
            [item.id, item.type || '', item.status || 'active', item.title || '', JSON.stringify(item)]
          );
        }
        for (const m of next.globalMinutes) {
          await conn.query(
            'INSERT INTO minutes (id, title, meeting_date, related_item_id, payload) VALUES (?, ?, ?, ?, ?)',
            [m.id, m.title || '', toMysqlDateTime(m.date), m.relatedWGId || null, JSON.stringify(m)]
          );
        }
        await conn.commit();
      } catch (err) {
        await conn.rollback();
        throw err;
      } finally {
        conn.release();
      }
    } else {
      await this.persistFile();
    }
    return this.cache;
  }

  // ---------- 公開 API（ユーザー） ----------

  async countUsers() {
    if (this.mode === 'mysql') {
      const [rows] = await this.pool.query('SELECT COUNT(*) AS n FROM users');
      return rows[0].n;
    }
    return this.users.length;
  }

  async findUserByUsername(username) {
    if (this.mode === 'mysql') {
      const [rows] = await this.pool.query('SELECT * FROM users WHERE username = ? LIMIT 1', [username]);
      return rows[0] || null;
    }
    return this.users.find(u => u.username === username) || null;
  }

  async findUserByEmail(email) {
    const normalized = String(email || '').toLowerCase();
    if (this.mode === 'mysql') {
      const [rows] = await this.pool.query('SELECT * FROM users WHERE LOWER(email) = ? LIMIT 1', [normalized]);
      return rows[0] || null;
    }
    return this.users.find(u => String(u.email).toLowerCase() === normalized) || null;
  }

  async createUser({ username, email, password, role = 'admin' }) {
    const passwordHash = await bcrypt.hash(password, 12);

    if (this.mode === 'mysql') {
      await this.pool.query(
        'INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, ?)',
        [username, email, passwordHash, role]
      );
      return this.findUserByUsername(username);
    }

    const user = {
      id: crypto.randomUUID(),
      username,
      email,
      password_hash: passwordHash,
      role,
      created_at: new Date().toISOString()
    };
    this.users.push(user);
    await this.persistFile();
    return user;
  }

  async updatePassword(userId, password) {
    const passwordHash = await bcrypt.hash(password, 12);

    if (this.mode === 'mysql') {
      await this.pool.query('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, userId]);
      return;
    }
    const user = this.users.find(u => u.id === userId);
    if (user) {
      user.password_hash = passwordHash;
      await this.persistFile();
    }
  }

  async verifyPassword(user, password) {
    if (!user || !user.password_hash) return false;
    return bcrypt.compare(password, user.password_hash);
  }

  async close() {
    await this.writeQueue;
    if (this.pool) await this.pool.end();
  }
}

/**
 * DB 接続情報を決める。
 *
 *  1. DB_SECRET_ID があれば AWS Secrets Manager から取得する
 *     （EC2 に IAM ロールが付いていればアクセスキーの設定は不要）
 *  2. シークレットに無い項目は .env の DB_* で補う
 *  3. どちらにも情報が無ければ null を返し、呼び出し側はファイル保存に切り替える
 *
 * 起動時に1回だけ呼ぶこと。リクエストごとに呼ぶと API 料金とレイテンシが無駄になる。
 */
async function resolveDbConfig() {
  const secret = await fetchDbSecret();

  const host     = secret.host     || process.env.DB_HOST;
  const user     = secret.username || process.env.DB_USER;
  const database = secret.dbname   || process.env.DB_NAME;

  if (!host || !user || !database) return null;

  return {
    host,
    user,
    database,
    port: Number(secret.port || process.env.DB_PORT || 3306),
    password: secret.password != null ? secret.password : (process.env.DB_PASSWORD || ''),
    source: process.env.DB_SECRET_ID ? `Secrets Manager (${process.env.DB_SECRET_ID})` : '.env'
  };
}

async function fetchDbSecret() {
  const secretId = process.env.DB_SECRET_ID;
  if (!secretId) return {};

  let sdk;
  try {
    sdk = require('@aws-sdk/client-secrets-manager');
  } catch (e) {
    throw new Error('DB_SECRET_ID が設定されていますが @aws-sdk/client-secrets-manager が未インストールです。npm install @aws-sdk/client-secrets-manager を実行してください');
  }

  const client = new sdk.SecretsManagerClient({
    region: process.env.AWS_REGION || 'ap-northeast-1'
  });

  const res = await client.send(new sdk.GetSecretValueCommand({ SecretId: secretId }));
  if (!res.SecretString) throw new Error(`シークレット ${secretId} が JSON 文字列ではありません`);

  let parsed;
  try {
    parsed = JSON.parse(res.SecretString);
  } catch (e) {
    throw new Error(`シークレット ${secretId} の JSON を解析できません`);
  }
  return parsed || {};
}

function parseJson(value) {
  if (value == null) return null;
  if (typeof value === 'object') return value;   // mysql2 は JSON 列をオブジェクトで返す
  try { return JSON.parse(value); } catch (e) { return null; }
}

// 'YYYY-MM-DDTHH:mm' (datetime-local) を MySQL DATETIME に変換する
function toMysqlDateTime(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

module.exports = { Store, EMPTY_STATE };
