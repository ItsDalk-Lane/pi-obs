# Release Checklist

> **This checklist is upstream's, retargeted for this fork.**
>
> Upstream publishes `@agegr/pi-web` to npm and tags GitHub Releases on `agegr/pi-web`. This fork
> publishes **`pi-obs`** to npm and tags Releases on **[ItsDalk-Lane/pi-obs](https://github.com/ItsDalk-Lane/pi-obs)**.
> Every `--repo` flag below already names this repository rather than upstream, so the steps apply
> as written.
>
> **Before the first push**: this repository is still empty and no remote is configured. Add it once:
>
> ```bash
> git remote add origin https://github.com/ItsDalk-Lane/pi-obs.git
> git push -u origin main
> ```
>
> Upstream references are kept where the step genuinely targets upstream (for example the demo page
> it hosts). Those are not release targets.

This repo publishes two artifacts for each release:

- npm package: `pi-obs`
- GitHub Release: `ItsDalk-Lane/pi-obs`

Use this checklist from a clean `main` checkout.

## 1. Preflight

```bash
git remote -v
git fetch origin
git status --short --branch
git log --oneline --decorate -5
git rev-list --left-right --count main...origin/main
gh auth status
npm whoami
node -e "const p=require('./package.json'); console.log(p.version)"
lsof -nP -iTCP:30141 -sTCP:LISTEN
ls .next/server/route-cache
```

Expected:

- `git remote -v` names `https://github.com/ItsDalk-Lane/pi-obs.git` as `origin`. It may name upstream too, but upstream must never be the push target.
- `git status` is clean, or only contains changes you intentionally plan to release.
- `main` and `origin/main` are aligned (`0	0`).
- GitHub is authenticated as an account that can push and create releases.
- npm is authenticated as an account that can publish `pi-obs`.
- No dev server is listening on 30141: the production build rewrites `.next/` and breaks a running `npm run dev`. Stop it first.
- `.next/server/route-cache/` does not exist. An e2e run in `start` mode writes it (`next start` does, the build does not), and it would be published. Delete it if present.

Before bumping, confirm the next version is free (replace `<version>`):

```bash
npm view pi-obs@<version> version --registry https://registry.npmjs.org/   # expect E404
git ls-remote --tags origin v<version>                                            # expect empty
```

## 2. Publish to npm

Patch release:

```bash
npm run release
```

The release script runs:

```bash
npm version patch --no-git-tag-version && npm run build && npm publish --access public
```

`npm run release` only bumps the patch number. For a minor (or major) release, set the version yourself and run the other two steps separately:

```bash
npm version <x.y.0> --no-git-tag-version
npm run build
npm publish --access public
```

Choosing the bump: look at `git log --oneline v<previous>..HEAD`. A batch of `feat:` commits (new UI, new commands, new settings) is a minor; only fixes and small adjustments is a patch. Decide before running the script, since a published version cannot be reused.

Notes:

- This bumps `package.json` and `package-lock.json`.
- It intentionally runs a production build. Do not run `next build` during normal development; release work is the exception.
- A newly published version may take a few minutes to show up. `npm view pi-obs@<version> version` can return E404 and `npm view pi-obs version` can show the previous version even though the publish printed `+ pi-obs@<version>`. This is registry propagation, not a failed publish: do not publish again. Poll the registry until the version appears:

```bash
curl -s https://registry.npmjs.org/pi-obs/<version> | head -c 80   # JSON once it exists, "version not found" before
npm view pi-obs dist-tags --registry https://registry.npmjs.org/
npm view pi-obs versions --json --registry https://registry.npmjs.org/
```

## 3. Commit the Version Bump

Replace `<version>` with the new package version, for example `0.7.5`.

```bash
git diff -- package.json package-lock.json
git add package.json package-lock.json
git commit -m "Release v<version>"
```

## 4. Tag and Push

```bash
git tag -a v<version> -m "v<version>"
git push origin main v<version>
```

Push the release tag by name. Do not use `git push --tags`: the local checkout may hold tags fetched from contributor forks or from upstream that are not on origin, and `--tags` publishes them (upstream leaked a stray `v0.10.5`, on a commit that is on no branch, during the v0.11.0 release). If you ever need `--tags`, compare `git tag` with `git ls-remote --tags origin` first.

This repository starts empty, so the first push also establishes `main` on the remote. After it,
`main...origin/main` in step 1 becomes meaningful.

Confirm the tag does not already exist before creating it when unsure:

```bash
git ls-remote --tags origin v<version>
gh release view v<version> --repo ItsDalk-Lane/pi-obs
```

## 5. Generate Release Notes from Commits

Use the previous release tag as the base.

```bash
git log --oneline --decorate v<previous>..v<version>
git log --format='%h%x09%s%n%b' v<previous>..v<version>
git diff --stat v<previous>..v<version>
```

Write the release notes from those commits, not from memory. Include both Chinese and English sections. Keep commit hashes or PR numbers next to each item when useful.

- Check commands, flags and setting names against `README.md` and the code before writing them down.
- Thank outside contributors by name: `git log --format='%h %an | %s' v<previous>..v<version>` lists authors, and the previous release's notes show the style.
- Open with the install/upgrade command (`npm install -g pi-obs@latest`), as earlier releases did.
- Write the notes to a file outside the repo (for example `NOTES=$(mktemp)`), or pass them through stdin as shown below. A `release-notes.md` in the repo root is an untracked file in the next release's `git status`.

Suggested structure:

```markdown
## 中文

基于 `v<previous>..v<version>` 的提交整理。

### 新增

- ...

### 修复

- ...

### 改进

- ...

### 内部调整

- 发布 npm 包 `pi-obs@<version>`。

## English

Prepared from commits in `v<previous>..v<version>`.

### Added

- ...

### Fixed

- ...

### Improved

- ...

### Internal

- Published npm package `pi-obs@<version>`.
```

## 6. Create or Update the GitHub Release

Create a new release:

```bash
gh release create v<version> \
  --repo ItsDalk-Lane/pi-obs \
  --verify-tag \
  --title "v<version>" \
  --notes-file "$NOTES"
```

If the release already exists and only the notes need updating:

```bash
gh release edit v<version> \
  --repo ItsDalk-Lane/pi-obs \
  --notes-file "$NOTES"
```

You can avoid a temporary file by passing notes through stdin:

```bash
gh release edit v<version> --repo ItsDalk-Lane/pi-obs --notes-file - <<'EOF'
## 中文

...

## English

...
EOF
```

## 7. Final Verification

```bash
gh release view v<version> --repo ItsDalk-Lane/pi-obs
npm view pi-obs@<version> version --registry https://registry.npmjs.org/
npm view pi-obs dist-tags --registry https://registry.npmjs.org/
git status --short --branch
git log --oneline --decorate -3
git ls-remote --tags origin
```

Expected:

- GitHub Release exists and is not a draft unless intentionally published as one.
- npm exact version resolves and `latest` points at it (allow a few minutes, see step 2).
- `git ls-remote --tags origin` shows no tag you did not mean to publish.
- `main` is aligned with `origin/main`.
- `HEAD` points at the release commit and `v<version>` tag.

## 8. After the First Publish

One-time cleanup, only needed for the first release of `pi-obs`:

- Drop the **Status** note from the **Quick Start** section of all four READMEs
  (`README.md`, `README.zh-CN.md`, `README.ja.md`, `README.ru.md`). It exists only to explain the
  pre-publish state.
- In `docs/obsidian.md` and `docs/obsidian.zh-CN.md`, the **Publishing** section already describes
  the post-publish behavior; no change needed.
- Confirm the Obsidian plugin installs from the registry: with **Pi Web directory** empty, enable the
  plugin in a vault and check that `npm install pi-obs` succeeds into the plugin's `pi-web-app`
  folder. This is the path most users will take, and it cannot be tested before the first publish.
- `docs/obsidian.md` and the Chinese version document the icon scaling and the `postMessage`
  contract; re-verify them against the served build if the panel pages changed in this release.
