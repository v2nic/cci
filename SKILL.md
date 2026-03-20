---
name: cci
description: Local CircleCI daemon and CLI for waiting on pipelines and subscribing to pipeline events
metadata:
  author: mobilityhouse
  version: "0.1.0"
---

# CCI Skill

Use `cci` when you need to wait for CircleCI or stream pipeline events locally.

- validates and stores a CircleCI token
- supports blocking waits with timeouts
- supports streaming subscriptions over WebSocket
- exposes a local web interface for browsing projects and viewing events

## Install the released binary

Download the latest GitHub release asset and install it:

Linux:

```bash
gh release download latest --repo v2nic/cci --pattern 'cci-*.tar.gz' --dir /tmp/cci
tar -xzf /tmp/cci/cci-linux-x64.tar.gz -C /tmp/cci
install -m 0755 /tmp/cci/cci /usr/local/bin/cci
```

macOS:

```bash
gh release download latest --repo v2nic/cci --pattern 'cci-*.tar.gz' --dir /tmp/cci
tar -xzf /tmp/cci/cci-darwin-x64.tar.gz -C /tmp/cci
install -m 0755 /tmp/cci/cci /usr/local/bin/cci
```

The release assets are published separately for Linux and macOS.

To install a specific version, replace `latest` with a tag such as `v0.1.0`.

## Release to GitHub

Create and push a version tag:

```bash
git tag v0.1.0
git push origin v0.1.0
```

The GitHub Action in `.github/workflows/release.yml` builds Linux and macOS binaries, packages them as release archives, uploads the archives as Actions artifacts, and attaches them to the GitHub Release for the tag.

## Build the Bun binary

From this skill directory:

```bash
bun install
npx playwright install chromium
bun run build
```

The compiled binary is written to `./dist/cci`.

## Login

Interactive:

```bash
./dist/cci login
```

Non-interactive:

```bash
echo "$CIRCLECI_TOKEN" | ./dist/cci login
```

The daemon validates the token before storing it in `~/.circleci/token` and applies strict file permissions.

## Await pipeline completion

```bash
./dist/cci await-completion pipelines/github/<org>/<project>/<pipeline_number> --timeout 3600
```

The command exits successfully when all workflows for the pipeline finish with `success`.

## Subscribe to events

Specific pipeline:

```bash
./dist/cci subscribe pipelines/github/<org>/<project>/<pipeline_number>
```

Project-wide:

```bash
./dist/cci subscribe pipelines/github/<org>/<project>
```

Multiple subscriptions:

```bash
./dist/cci subscribe \
  pipelines/github/<org>/<project> \
  pipelines/github/<org>/<another-project>/<pipeline_number>
```

Events are written as JSONL records to standard output.

## Web interface

```bash
./dist/cci web
```

Open the printed URL in a browser. The page lets you:

- search the list of available CircleCI projects
- subscribe to one or many projects
- view a live event table with timestamp, project, pipeline number, icon, description, and CircleCI link

## Validation

Run the local checks after changes:

```bash
bun run format
bun run lint
bun run test
bun run test:playwright
```
