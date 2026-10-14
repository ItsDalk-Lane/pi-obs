# Pi Web — Obsidian 適応フォーク

[English](./README.md) | [简体中文](./README.zh-CN.md) | [Русский](./README.ru.md)

> **本リポジトリは [agegr/pi-web](https://github.com/agegr/pi-web) のフォークであり、独立したプロジェクトではありません。**
>
> 本リポジトリ：<https://github.com/ItsDalk-Lane/pi-obs> ·
> 上流：`agegr/pi-web`、MIT ライセンス、著作権は `agegr`（[LICENSE](./LICENSE) を参照、変更なし）。
> ローカルでの変更は 1 点のみ：**Web UI を Obsidian 内でローカルデスクトッププラグインとして動作するよう適応**。
> `obsidian-plugin/` ディレクトリ、埋め込みモード（`?embed=1`）、独立パネルルート（`/panel/*`）を追加し、
> npm パッケージ名を `pi-obs` に変更しています。詳細は [Obsidian プラグインのドキュメント](./docs/obsidian.md) を参照してください。
>
> 以下のうち明記していない部分は上流と同一です。

[pi コーディングエージェント](https://github.com/earendil-works/pi) のローカルブラウザー UI です。Pi Web は pi と同じローカル設定とセッションファイルを使用し、ブラウザーから会話の検索と再開、エージェントの実行、モデルやリソースの設定、プロジェクトファイルの確認を行えます。

**Obsidian での使用方法**：[Obsidian プラグインのドキュメント](./docs/obsidian.md) を参照してください。プラグインのビルドとインストール、設定項目のすべて、埋め込みモードとパネル路由の動作を説明します。

> 以下は上流のドキュメントです。

**[インタラクティブデモを試す →](https://agegr.github.io/pi-web/)**：実際の Pi Web UI がブラウザー内だけで動作し、サンプルのセッション、ファイル、モデルを確認できます。インストールは不要です。返信はあらかじめ用意された内容で、モデルは呼び出しません。

![構造化された Markdown、ツール呼び出し、プロジェクトナビゲーションとともに pi セッションを表示する Pi Web](https://raw.githubusercontent.com/agegr/pi-web/main/docs/screenshot2.png)

## このフォークと上流の違い

使用に影響する箇所のみ：

| 項目 | 上流 | このフォーク |
| --- | --- | --- |
| npm パッケージ名 | `@agegr/pi-web` | `pi-obs` |
| ホスト | ブラウザータブ | Obsidian ビュー、またはブラウザータブ |
| 右側パネル | ページ内で描画 | 埋め込み時は Obsidian に渡し、各々独立したタブに |
| ライセンスと著作権 | MIT / `agegr` | 変更なし |

セッションファイル、モデル、設定は両側で共有され、接口の挙動は同一です。

## 機能

- **セッションワークスペース**：プロジェクトごとに会話を閲覧、再開、名前変更、エクスポート、削除し、実行状態、コンテキスト使用量、コスト、コンパクション情報を確認できます。
- **2 種類の分岐**：**New session** は以前のメッセージから独立したセッションファイルを作成し、**Edit from here** は現在のセッション内にブランチを作成します。
- **プロジェクトファイルツール**：ファイルの閲覧とアップロード、Git Diff の確認、ソース、Markdown、画像、音声、PDF、DOCX のプレビューに対応し、変更時は自動更新されます。
- **Git worktree**：同じリポジトリのセッションをまとめたまま、サイドバーからチェックアウトを切り替えられます。
- **Web での設定**：Pi Web を離れずに、Provider のログインと API Key、モデル、モデルテスト、プラグインパッケージ、スキルを管理できます。
- **英語、簡体字中国語、繁体字中国語の UI**：初回はブラウザーの言語に従い、トップバーから言語を切り替えられます。

## クイックスタート

> **状態**：`pi-obs` の公開までは、このリポジトリの clone から実行してください
> （`npm install && npm run dev`）。公開後は以下のコマンドをそのまま使えます。
> コマンド名は `pi-obs` です（`package.json` の `bin` を参照）。上流のリリースを使う場合は
> [docs/release.md](./docs/release.md) を参照してください。

Pi Web には Node.js 22.19.0 以降が必要です。`node --version` でバージョンを確認してから、次を実行します：

```bash
npx pi-obs@latest
```

サーバーの準備が整うと、CLI はブラウザーを自動的に開こうとします。開かない場合は [http://127.0.0.1:30141](http://127.0.0.1:30141) にアクセスしてください。Pi Web はデフォルトで `127.0.0.1` のみをリッスンします。

モデル Provider が未設定の場合は、**Models** パネルを開いてログインするか API Key を追加してください。

`pi-obs` コマンドをグローバルにインストールする場合：

```bash
npm install -g pi-obs@latest
pi-obs
```

コマンド：

```bash
pi-obs version          # インストール済みのバージョンを表示
pi-obs status           # 実行中のサーバーを一覧表示
pi-obs stop [--port N]  # 実行中のサーバーを停止
pi-obs open [--port N]  # 実行中のサーバーをブラウザーで開く
pi-obs update [--check] # グローバル npm インストールを更新
```

更新時は `pi-obs stop` を実行してから `pi-obs update` を実行します（同じインストールコマンドの再実行でも構いません）。アンインストールするには `npm uninstall -g pi-obs` を実行します。

## 設定

ポートとホスト名では、コマンドラインオプションが対応する環境変数より優先されます。`--no-open` と `PI_WEB_NO_OPEN=1` は、どちらを指定してもブラウザーの自動起動が無効になります。`pi-obs --help`（または `-h`）で起動オプションを表示して終了します。未知のオプションはエラーで終了します。

| オプションまたは環境変数 | 用途 | デフォルト |
| --- | --- | --- |
| `--help`、`-h` | 起動オプションを表示して終了 | — |
| `--port <port>`、`-p <port>`、または `PORT` | サーバーポート | `30141` |
| `--hostname <host>`、`-H <host>`、または `PI_WEB_HOSTNAME` | バインドするホスト名 | `127.0.0.1` |
| `--no-open` または `PI_WEB_NO_OPEN=1` | ブラウザーを自動的に開かない | 自動的に開く |
| `PI_WEB_ALLOWED_HOSTS` | 追加で許可するプロキシまたはカスタムホスト名。複数指定はカンマ区切りで完全一致 | 未設定 |
| `PI_WEB_PASSWORD` | ブラウザーのパスワードログインを有効化。API はユーザー名 `pi` の Basic Auth も利用可能 | 認証なし |

例：

```bash
pi-obs --help
pi-obs -p 8080 -H 0.0.0.0 --no-open
```

### リモートアクセス

ループバック以外のアドレスにバインドすると、高い権限の操作を実行できるエージェントがネットワークに公開されます。信頼できる LAN で使用する場合も、十分に長いランダムなパスワードを設定してください：

```bash
PI_WEB_PASSWORD='十分に長いランダムなパスワード' pi-obs --hostname 0.0.0.0
```

パスワード認証は接続を暗号化しません。平文 HTTP で Pi Web をインターネットに公開せず、信頼できるリバースプロキシによる HTTPS または信頼できる VPN を使用してください。リバースプロキシが外部ホスト名を転送する場合は、その名前を完全一致で `PI_WEB_ALLOWED_HOSTS` に追加します。この許可リストは Pi Web のバインド先を変更しません。

### HTTP プロキシ

サーバー側のモデルリクエストと API リクエストは、標準の `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY` 環境変数を使用します。

macOS または Linux：

```bash
HTTP_PROXY=http://127.0.0.1:7890 \
HTTPS_PROXY=http://127.0.0.1:7890 \
NO_PROXY=localhost,127.0.0.1 \
npx pi-obs@latest
```

Windows PowerShell：

```powershell
$env:HTTP_PROXY = "http://127.0.0.1:7890"
$env:HTTPS_PROXY = "http://127.0.0.1:7890"
$env:NO_PROXY = "localhost,127.0.0.1"
npx pi-obs@latest
```

## 注意事項

- **エージェントデータ**：Pi Web はデフォルトで `~/.pi/agent` の pi データを読み込みます。セッションファイルは `sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl` にあります。別の pi エージェントディレクトリを使用するには `PI_CODING_AGENT_DIR` を設定してください。
- **ファイルシステムへのアクセス**：Pi Web はエージェントデータディレクトリと、セッションに記録された作業ディレクトリを読み取れる必要があります。既存の pi セッションを共有する場合は、pi と同じファイルシステム環境で Pi Web を実行してください。
- **共有設定**：Models パネルは pi のモデル、設定、認証情報ストレージを使用するため、変更は両方のインターフェースに反映されます。
- **ファイルアクセスの範囲**：ファイルブラウザーは、Pi Web で選択した作業ディレクトリと、既知のプロジェクトまたはセッションルートに限定されます。汎用のファイルシステムブラウザーではありません。
- **Git worktree**：スイッチャーの表示条件、worktree の作成、削除時の動作については [Worktrees in Pi Web](./docs/worktrees.md) を参照してください。

## 開発

```bash
npm install
npm run dev
```

開発サーバーは [http://127.0.0.1:30141](http://127.0.0.1:30141) で動作します。一般的なチェックは次のコマンドで実行します：

```bash
npm test
node_modules/.bin/tsc --noEmit
npm run lint
```

通常の開発中は `next build` または `npm run build` を実行しないでください。`.next/` に書き込まれ、開発サーバーに影響する可能性があります。ビルドはリリース作業時にのみ実行してください。

コントリビューター向けガイド：[Internationalization](./docs/i18n.md) と [Release process](./docs/release.md)。

## リポジトリ構成

```text
app/             Next.js UI と API ルート
  panel/         埋め込みモード用の独立パネルページ（file / terminal / agent / history）
components/      React UI コンポーネント
hooks/           クライアントの状態と操作に関する hooks
lib/             セッション、エージェント、モデル、ファイル、Git、セキュリティのロジック
public/          静的アセットと PWA ファイル
bin/             npm CLI エントリポイントと起動オプションの解析
docs/            ユーザーおよびコントリビューター向けの個別ガイド
demo/            GitHub Pages で公開する静的デモ（demo/README.md を参照）
obsidian-plugin/ このフォークの追加：Obsidian デスクトッププラグイン（docs/obsidian.md を参照）
```

アーキテクチャの説明と詳細なファイルマップについては [AGENTS.md](./AGENTS.md) を参照してください。Obsidian 適応と上流との同期時の注意事項は [docs/obsidian.md](./docs/obsidian.md) にあります。

## ライセンス

[MIT](./LICENSE)、著作権は `agegr`、上流から変更ありません。このフォークの追加分にも同じライセンスが適用されます。
