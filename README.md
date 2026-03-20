# cci

`cci` is a Bun-based CircleCI helper that runs as a local daemon and exposes a CLI and a small web interface.

The CLI starts the daemon automatically when needed. The daemon listens on `127.0.0.1` only and stores the validated CircleCI token at `~/.circleci/token` with strict file permissions.

Port `2243` was chosen for `ccid` using the telephone keypad standard. The word was shortened to `CCID` and each letter maps to a digit: `C=2`, `C=2`, `I=4`, `D=3`.

## Features

- `cci login` reads a token from standard input, validates it, and stores it securely.
- `cci await-completion pipelines/github/<org>/<project>/<pipeline_number>` waits for a pipeline to finish.
- `cci subscribe ...` opens a WebSocket-backed JSONL event stream for one or many targets.
- `cci web` prints the local web interface URL.
- The daemon serves a web UI for project search and live event viewing.

## Targets

Specific pipeline:

```text
pipelines/github/<org>/<project>/<pipeline_number>
```

Project-wide subscription:

```text
pipelines/github/<org>/<project>
```

## Install from GitHub Releases

Download the latest release asset and install the binary:

```bash
gh release download latest --repo v2nic/cci --pattern 'cci-linux-x64.tar.gz' --dir /tmp/cci
tar -xzf /tmp/cci/cci-linux-x64.tar.gz -C /tmp/cci
install -m 0755 /tmp/cci/cci /usr/local/bin/cci
```

To install a specific version, replace `latest` with a tag such as `v0.1.0`.

## Build from source

```bash
bun install
npx playwright install chromium
bun run build
```

## Development

```bash
bun run dev -- --help
```

## Build the standalone binary

```bash
bun run build
```

This creates `./dist/cci`. The compiled binary spawns a copy of itself in daemon mode.

## Release to GitHub

Create and push a version tag:

```bash
git tag v0.1.0
git push origin v0.1.0
```

The GitHub Action in `.github/workflows/release.yml` builds `dist/cci`, packages it as `cci-linux-x64.tar.gz`, uploads the archive as an Actions artifact, and publishes it to the GitHub Release for the tag.

## Usage

Login with a token piped over standard input:

```bash
echo "$CIRCLECI_TOKEN" | ./dist/cci login
```

Interactive login:

```bash
./dist/cci login
```

Wait for a pipeline:

```bash
./dist/cci await-completion pipelines/github/mobilityhouse/example/123 --timeout 600
```

Subscribe to one or many targets:

```bash
./dist/cci subscribe pipelines/github/mobilityhouse/example/123
./dist/cci subscribe pipelines/github/mobilityhouse/example pipelines/github/mobilityhouse/another-project
```

Show the web UI URL:

```bash
./dist/cci web
```

## Tests

```bash
bun run test
bun run test:playwright
```
