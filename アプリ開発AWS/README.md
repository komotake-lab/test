# WG管理システム

ワーキンググループ・検討事項・議事録を複数人でリアルタイム共有するための管理ツールです。

- フロントエンド: `index.html`（単一ファイル / ビルド不要）
- サーバー: Node.js + Express + Socket.IO (`server.js`)
- ストレージ: MySQL（Amazon RDS / Aurora MySQL）。未設定なら `data/store.json` に自動フォールバック

---

## 1. ログイン

| ユーザー名 | パスワード |
|---|---|
| `Dabo` | `Dabo` |
| `Kiku` | `Kiku` |

- **サーバーなし**（`index.html` を直接開く）: この2つでそのままログインできます（`index.html` 内のフォールバック認証）
- **サーバーあり**: 初回起動時にこの2ユーザーが DB に登録され（パスワードは bcrypt ハッシュ）、`/api/login` で認証されます

> 本番運用の前にパスワードを変更してください。サーバー運用時は `index.html` 内の `FALLBACK_USERS` と、DB 上のユーザー（`users` テーブル）の両方が対象です。

---

## 2. セットアップ

```bash
npm install
```

```bash
cp .env.example .env
```

`.env` を編集します。MySQL を使わない場合は `DB_*` を空のままで構いません（ファイル保存で動作します）。

```bash
npm start
```

ブラウザで `http://localhost:3000` を開きます。

---

## 3. ファイル構成

| ファイル | 役割 |
|---|---|
| `index.html` | 画面・アプリロジック一式（フロントエンド） |
| `server.js` | HTTP サーバー、`/api/db-status`・`/api/login`、Socket.IO リアルタイム同期 |
| `store.js` | ストレージ抽象化（MySQL ⇔ JSON ファイルの自動切替） |
| `db/schema.sql` | MySQL のテーブル定義 |
| `package.json` | 依存パッケージと起動スクリプト |
| `.env.example` | 環境変数のテンプレート |
| `.gitignore` | `.env` と `data/` をコミット対象外にする |
| `data/store.json` | DB 未設定時のデータ実体（自動生成・要バックアップ） |

---

## 4. MySQL を使う場合

データベースだけ先に作成します。

```bash
mysql -h <RDSエンドポイント> -u <ユーザー> -p < db/schema.sql
```

`.env` に接続情報を設定して起動すると、テーブルが無ければ自動作成されます。

### DBパスワードを AWS Secrets Manager で管理する

`.env` にパスワードを直接書かず、Secrets Manager から取得できます。`DB_SECRET_ID` を設定するだけで、そちらが優先されます。

**1. シークレットを作成**

```bash
aws secretsmanager create-secret --name prod/wg-system/db --secret-string '{"username":"dbuser","password":"xxxxx","host":"10.0.1.23","port":3306,"dbname":"wg_system"}'
```

**2. EC2 の IAM ロールに権限を付与**

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "secretsmanager:GetSecretValue",
      "Resource": "arn:aws:secretsmanager:ap-northeast-1:xxxxxxxxxxxx:secret:prod/wg-system/db-*"
    }
  ]
}
```

**3. `.env` に設定**

```
DB_SECRET_ID=prod/wg-system/db
AWS_REGION=ap-northeast-1
```

IAM ロールがアタッチされていれば、アクセスキーを書く必要はありません（SDK がインスタンスメタデータから一時クレデンシャルを取得します）。ローカル開発では `AWS_PROFILE` や `~/.aws/credentials` がそのまま使われます。

シークレットの取得は**起動時の1回だけ**で、以降はプールを使い回します（API 料金とレイテンシを抑えるため）。

**注意点**

- プライベートサブネットの EC2 から呼ぶ場合、NAT ゲートウェイか VPC エンドポイント（`com.amazonaws.<region>.secretsmanager`）が必要です

  ```bash
  aws ec2 create-vpc-endpoint --vpc-id vpc-xxxxxxxx --service-name com.amazonaws.ap-northeast-1.secretsmanager --vpc-endpoint-type Interface --subnet-ids subnet-xxxxxxxx --security-group-ids sg-xxxxxxxx
  ```

- **自動ローテーションには未対応です。** EC2 上の自前 DB は Secrets Manager の組み込みローテーションの対象外で、ローテーション用 Lambda を自分で用意する必要があります。加えて本アプリは起動時にしかシークレットを読まないため、パスワードが変わった場合はサーバーの再起動が必要です
- シークレットの取得に失敗した場合、サーバーは停止せずファイル保存モードで起動します（ログに理由が出ます）
- コストを抑えたいだけなら、SecureString の Parameter Store（Standard tier は無料）も選択肢です。その場合は `store.js` の `fetchDbSecret()` を差し替えてください
ログイン画面の右上バッジが **● オンライン** なら MySQL に接続できています。**● DB未接続** の場合はファイル保存で動いています（サーバーのログに理由が出ます）。

テーブル構成:

- `users` — アカウント（パスワードは bcrypt ハッシュ）
- `vision` — ビジョン（1行のみ）
- `items` — WG / 検討事項 / クローズ項目（詳細は `payload` の JSON）
- `minutes` — 議事録

---

## 5. AWS へのデプロイ（EC2 の例）

```bash
sudo dnf install -y nodejs git
git clone <このリポジトリ> /opt/wg-system && cd /opt/wg-system
npm ci --omit=dev
cp .env.example .env && vi .env
```

systemd サービスとして常駐させます。

```ini
# /etc/systemd/system/wg-system.service
[Unit]
Description=WG Management System
After=network.target

[Service]
Type=simple
User=ec2-user
WorkingDirectory=/opt/wg-system
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now wg-system
```

**チェックリスト**

- ALB / CloudFront 経由なら `.env` の `TRUST_PROXY_HOPS` を段数に合わせる（ログイン試行回数の制限が正しく効くようになります）
- ALB で HTTPS を終端する。パスワードが平文で流れる構成にしない
- Socket.IO は WebSocket を使うため、複数台構成では ALB のターゲットグループでスティッキーセッションを有効にする
- RDS のセキュリティグループは EC2 からのみ 3306 を許可する
- ファイル保存モードで運用する場合、`data/store.json` を定期バックアップする

---

## 6. データのバックアップと復元

画面右上の **📤 内容保存 / 📥 内容復元** で全データを CSV 入出力できます。

- ファイル名に出力時刻が入ります（`wg_system_backup_2026_08_10_143000.csv`）
- 復元は**完全置き換え**です。バックアップに含まれない項目は削除されます
- WBS・課題・活動実績・タグ・メンバーは CSV セル内に JSON として保存されるため、項目が欠落しません
- 旧形式（この修正より前に出力した CSV）もそのまま読み込めます
- 添付ファイルは CSV に含まれません。DB / `data/store.json` のバックアップで保全してください

---

## 7. 制限事項

- 認証は `index.html` 内のフォールバックユーザーを使う経路が残っているため、ブラウザの開発者ツールから回避できます。社内ネットワーク限定での利用を前提としてください
- 添付ファイルは 1 ファイル 5MB まで。base64 として本体データに埋め込まれるため、大量に添付するとデータサイズが膨らみます
- 同じ項目を複数人が同時に編集した場合、後から保存した内容が優先されます（楽観ロックなし）
