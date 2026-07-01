# Contributing

## Running the development version

`meeting-bot` is not in the plugin marketplace yet, so you install it straight
from this GitHub repo. Anything containing a slash is treated as a URL install,
which materializes the repo tree verbatim and skips marketplace curation.

```bash
assistant plugins install https://github.com/vellum-ai/meeting-bot
```

That installs the current default branch (`main`). The install is **untrusted**
— the plugin's hooks and tools run with full assistant access — so the CLI
prints a warning naming the source. That is expected for a dev install.

### Installing a specific branch

Put the ref in the URL's `/tree/<ref>/` segment:

```bash
assistant plugins install https://github.com/vellum-ai/meeting-bot/tree/my-feature-branch
```

A branch (or `HEAD`) ref is mutable, so a direct install is a development
convenience, not a reproducible pin.

### After installing

The plugin needs its config (Recall.ai `apiKey`, public `publicWsUrl`, …) before
the realtime server can start — see [Configuration](README.md#configuration).
To pick up changes, re-run the install command with `--force`:

```bash
assistant plugins install https://github.com/vellum-ai/meeting-bot --force
```
