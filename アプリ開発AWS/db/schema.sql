-- WG管理システム スキーマ (MySQL 8.0 / Aurora MySQL 3.x)
--
-- 初回のみ手動で実行する場合:
--   mysql -h <host> -u <user> -p < db/schema.sql
-- server.js は起動時に CREATE TABLE 部分を自動実行するため、
-- 通常はデータベースの作成だけ済ませておけばよい。

CREATE DATABASE IF NOT EXISTS wg_system
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE wg_system;

-- 利用者
CREATE TABLE IF NOT EXISTS users (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  username      VARCHAR(80)  NOT NULL,
  email         VARCHAR(120) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,      -- bcrypt。平文は保存しない
  role          VARCHAR(20)  NOT NULL DEFAULT 'member',
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_username (username),
  UNIQUE KEY uq_users_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ビジョン（常に1行）
CREATE TABLE IF NOT EXISTS vision (
  id         TINYINT UNSIGNED NOT NULL DEFAULT 1,
  company    TEXT,
  target     TEXT,
  details    TEXT,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- WG / 検討事項 / クローズ項目
-- 検索対象になる列は取り出しつつ、WBS・課題・活動実績・添付は payload(JSON) に格納する
CREATE TABLE IF NOT EXISTS items (
  id         VARCHAR(64)  NOT NULL,
  type       VARCHAR(32)  NOT NULL DEFAULT '',      -- 'wg' | 'consideration'
  status     VARCHAR(32)  NOT NULL DEFAULT 'active',-- 'active' | 'closed'
  title      VARCHAR(255) NOT NULL DEFAULT '',
  payload    JSON         NOT NULL,
  created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_items_type_status (type, status),
  KEY idx_items_title (title)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 議事録
CREATE TABLE IF NOT EXISTS minutes (
  id              VARCHAR(64)  NOT NULL,
  title           VARCHAR(255) NOT NULL DEFAULT '',
  meeting_date    DATETIME     NULL,
  related_item_id VARCHAR(64)  NULL,
  payload         JSON         NOT NULL,
  created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_minutes_date (meeting_date),
  KEY idx_minutes_related (related_item_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
