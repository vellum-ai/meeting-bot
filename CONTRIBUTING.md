# Contributing

## Running the development version

Install the plugin straight from this GitHub repo. Passing a URL (anything
containing a slash) instead of a marketplace name does a direct install: the
repo tree is materialized verbatim, skipping marketplace curation.

```bash
assistant plugins install https://github.com/vellum-ai/meeting-bot
```

This is the command for running unpublished versions of the plugin — not just a
stopgap until it lands in the registry. Even once `meeting-bot` is published,
this same GitHub-URL install is how you test a new version (a feature branch, or
`main` ahead of the published pin) before publishing it.

The install is **untrusted** — the plugin's hooks and tools run with full
assistant access — so the CLI prints a warning naming the source. That is
expected for a dev install.

### Installing a specific branch

Put the ref in the URL's `/tree/<ref>/` segment:

```bash
assistant plugins install https://github.com/vellum-ai/meeting-bot/tree/my-feature-branch
```

A branch (or `HEAD`) ref is mutable, so a direct install is a development
convenience, not a reproducible pin.

## Setting up credentials

Two things get the plugin ready: the **Recall API key** (a secret) and the
plugin **config** (which is not secret). They are stored in different places on
purpose.

### The Recall API key (the secret)

The API key is **not** stored in config. Store it in the secure credential store
under the name `recall:api_key` (service `recall`, field `api_key`):

```bash
assistant credentials set --service recall --field api_key "recall_..."
```

At call time the plugin resolves the key from the environment, under the
variable derived from that name — `recall:api_key` → `RECALL_API_KEY` — which the
host provisions from the credential store. For a quick local dev run you can
export it yourself:

```bash
export RECALL_API_KEY="recall_..."
```

If you store the key under a different name, set `apiKeyCredential` in the config
(below) to that `service:field` name; otherwise leave it unset and the default
`recall:api_key` is used.

### The config (not secret)

The `init` hook needs `publicWsUrl` — the public URL Recall dials back into —
before the realtime server can start. See
[Configuration](README.md#configuration) for the full field list. Config reaches
the plugin as `InitContext.config`, resolved from
`<workspace>/plugins/meeting-bot/config.json`. There are two ways to get it
there.

#### Before installing

The plugin directory doesn't exist until you install, but you can pre-seed the
config in the workspace's global `config.json` under a `plugins.meeting-bot`
block:

```jsonc
// <workspace>/config.json — no API key here; it lives in the credential store
{
  "plugins": {
    "meeting-bot": {
      "publicWsUrl": "wss://your-tunnel.example.com",
      "region": "us-east-1"
    }
  }
}
```

Then install. On the plugin's first `init`, that block is migrated into
`<workspace>/plugins/meeting-bot/config.json` automatically, so your setup keeps
working without further manual steps.

#### After installing

Write the config file directly into the installed plugin directory:

```bash
cat > "$VELLUM_WORKSPACE_DIR/plugins/meeting-bot/config.json" <<'JSON'
{
  "publicWsUrl": "wss://your-tunnel.example.com",
  "region": "us-east-1"
}
JSON
```

Note the shapes differ: the global-config form nests the fields under
`plugins.meeting-bot`, while the per-plugin `config.json` **is** the config
object directly (no wrapping key). Neither form contains the API key.

> **Local dev tip:** Recall needs a stable public URL to dial back into, so put
> a static `ngrok` tunnel in front of `listenHost:listenPort` and point
> `publicWsUrl` at the tunnel's `wss://` address. See Recall's "Local
> Development Setup" guide.

## Picking up changes

Re-run the install with `--force` to overwrite an existing install with the
latest source:

```bash
assistant plugins install https://github.com/vellum-ai/meeting-bot --force
```

Preserved entries (`config.json`, `data/`) survive the reinstall, so your
credentials are not wiped when you upgrade.
