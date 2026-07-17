---
name: meeting-bot-setup
description: Guide the user through setting up the Recall.ai API key for the Meeting Bot plugin.
metadata:
  emoji: "⚙️"
  vellum:
    category: "voice"
    display-name: "Meeting Bot Setup"
---

Use this skill when the user needs to set up or fix the Recall.ai API key for the Meeting Bot plugin. This typically happens the first time they want to use the meeting bot, or when joining fails with a 401 authentication error.

## Step 1: Check if the key is already set

Before asking the user for anything, check whether a Recall API key is already stored:

```bash
assistant credentials inspect --service meeting-bot --field api_key
```

If the output shows `hasSecret: true`, the key is already configured. If the command fails or shows no secret, continue to Step 2.

## Step 2: Guide the user to get a Recall API key

Tell the user:

1. Go to https://recall.ai/dashboard and sign up or log in.
2. Navigate to the API settings / workspace settings page.
3. Generate a new workspace API key.
4. Note the region their workspace is in (us-east-1, us-west-2, eu-central-1, or ap-northeast-1). The region must match the plugin's configured region.

## Step 3: Store the API key

Once the user has their API key, store it in the credential store. Ask the user to provide the key, then store it:

```bash
assistant credentials set --service meeting-bot --field api_key "<their_key>"
```

**Never ask the user to paste the key directly in chat.** Use the credential store prompt so the key is stored securely.

## Step 4: Reload the plugin

After the key is stored, run the reload script to re-initialize the plugin so it picks up the new key and starts the realtime server:

```bash
bun skills/meeting-bot-setup/scripts/reload.ts
```

The script verifies the key is set, then disables and re-enables the plugin to trigger re-initialization.

## Step 5: Confirm

After the reload script succeeds, tell the user the Meeting Bot is ready to use. They can now ask the assistant to join meetings by providing a meeting URL.

## Region configuration

If the user's Recall workspace is in a region other than `us-east-1` (the default), the plugin's config needs to be updated. The region is set in the plugin's `config.json` under the `region` field. Supported regions: `us-east-1`, `us-west-2`, `eu-central-1`, `ap-northeast-1`.
