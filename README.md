# Localdeck

ローカルアプリの登録、Caddy route、稼働監視、起動・再起動・停止を1画面で管理するダッシュボードです。

アプリ設定は `state/localdeck.sqlite` が唯一の正本です。登録内容からCaddy設定全体を生成し、loopbackのCaddy Admin APIへ一度のリクエストで反映します。別ディレクトリのCaddyfileは使用しません。

## 起動

```sh
npm run local:start
```

このコマンドが次をまとめて行います。

1. Localdeck配下のLaunchAgentでCaddyを起動
2. 管理画面をbuildして起動
3. SQLiteの全アプリと `apps.localhost` をCaddyへ同期

起動後は次を開きます。

```text
https://apps.localhost
```

状態確認、再起動、停止もCaddyと管理画面の両方が対象です。

```sh
npm run local:status
npm run local:restart
npm run local:stop
```

ログとPID:

```text
logs/localdeck.log
logs/caddy.log
state/localdeck.pid
state/caddy.pid
```

## 旧構成からの初回移行

旧Caddy LaunchAgentを一度解除してからLocaldeckを再起動します。この環境では移行済みで、旧plistは復元可能な `com.wim.caddy.plist.disabled` として残しています。

```sh
launchctl bootout gui/$(id -u)/com.wim.caddy
npm run local:restart
```

SQLiteがまだ存在しない場合に限り、既存の `apps.config.json` を初期データとして取り込みます。以後、同ファイルは参照されず、UIでの変更はSQLiteへ保存されます。

新しいCaddy LaunchAgentの正本は `launchd/com.wim.localdeck.caddy.plist` です。`local:start` が `~/Library/LaunchAgents` へ同期し、`local:stop` はこのAgentを解除します。

移行確認後は `/Users/wim/program/ghq/github.com/wim-web/caddy` のCaddyfileと起動手順は不要です。Caddy本体と内部CAのデータは既存のユーザー環境をそのまま利用します。秘密値はLaunchAgentへ移送せず、管理画面は起動元の環境を引き継ぎます。

SymphonyもLocaldeckの `process` 方式が起動・停止を所有します。以前の `com.wim.symphony` LaunchAgentは `KeepAlive` により停止直後に再起動するため、移行済み環境では `com.wim.symphony.plist.disabled` として無効化しています。

## UIでのアプリ管理

「アプリ登録」から次を設定できます。

- 表示名、ID、説明
- `*.localhost` のホスト
- `host:port` 形式のupstream
- 作業ディレクトリ
- 必要な環境変数名
- 管理コマンド、またはフォアグラウンドプロセス
- proxyへ転送するHostヘッダー

コマンド欄は、実行ファイルと各引数を1行ずつ入力します。シェル展開は行いません。

登録・編集・削除時はSQLiteを更新した後、Caddyの全設定を再生成します。Caddyへの反映に失敗した場合は登録内容を保持して画面に警告を出し、「再同期」で再試行できます。

登録削除はCaddy routeを削除しますが、稼働中のアプリプロセスは停止しません。必要な場合は先に「停止」を実行します。

`process` 方式のアプリをlaunchdや別のsupervisorでも同時管理しないでください。外部の `KeepAlive` が有効だと、Localdeckで停止したプロセスが外部から再起動されます。

## API

```text
GET    /api/health
GET    /api/apps
POST   /api/apps
PUT    /api/apps/:id
DELETE /api/apps/:id
POST   /api/apps/:id/start
POST   /api/apps/:id/restart
POST   /api/apps/:id/stop
POST   /api/caddy/sync
```

変更系APIは専用ヘッダーと許可Originを要求します。管理サーバーとCaddy Admin APIはいずれもloopbackだけで待ち受けます。

## 開発と確認

```sh
npm test
npm run lint
npm run build:local
```

実環境確認:

```sh
npm run local:status
curl -fsS http://127.0.0.1:4545/api/apps | jq
curl -fsS http://127.0.0.1:2019/config/ | jq
```

## 安全境界

- Caddyと管理サーバーはloopbackだけで待ち受けます。
- Caddy設定はSQLiteの登録内容から全体生成し、不正時はCaddyが旧設定を維持します。
- コマンド実行にシェルを使いません。
- POST・PUT・DELETEは専用ヘッダーと許可Originを要求します。
- `process` 方式の停止前にPIDの作業ディレクトリを照合します。
- 強制終了 (`SIGKILL`) は自動実行しません。
- 環境変数は名前だけを保存し、値はSQLiteへ保存しません。
