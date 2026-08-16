# Localdeck

ローカルアプリの登録、Caddyルート、稼働状態、起動・再起動・停止を1画面で管理するダッシュボードです。

## 必要環境

- macOS
- Node.js 22.13以上
- `caddy` コマンド

## セットアップ

```sh
npm install
npm start
```

起動後に <https://apps.localhost> を開きます。Caddy、管理画面、登録済みルートはまとめて起動・同期されます。
管理画面は起動元とは別セッションで動作するため、起動に使ったターミナルやCodexのタスクを閉じても停止しません。

```sh
npm run local:status
npm run local:restart
npm run local:stop
```

## アプリ管理

UIから以下を登録・編集・削除できます。

- 表示名、ID、説明
- `*.localhost` のホスト名
- `host:port` 形式のupstream
- 作業ディレクトリ
- 必要な環境変数名
- 起動・再起動・停止コマンド
- proxyへ転送するHostヘッダー

設定は `state/localdeck.sqlite` に保存され、Caddyへ自動反映されます。環境変数は名前だけを保存し、値は保存しません。
フォアグラウンドプロセス方式の標準出力・標準エラーは、アプリIDごとに `logs/apps/<app-id>.log` へ保存されます。各PJ側でログファイルやPIDファイルを用意する必要はありません。

アプリを削除しても実行中のプロセスは停止しないため、必要なら先にUIから停止してください。同じプロセスをlaunchdなど別のSupervisorと同時に管理しないでください。

## ローカルファイル

次の実行時ファイルはGit管理外です。

```text
state/localdeck.sqlite
state/*.pid
logs/apps/*.log
launchd/*.plist
```

## 開発

```sh
npm test
npm run lint
npx tsc --noEmit
```
