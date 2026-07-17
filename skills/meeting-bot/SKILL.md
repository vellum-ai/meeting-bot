---
name: meeting-bot
description: Send a note-taking bot into a meeting via Recall.ai; only when the user explicitly asks.
metadata:
  emoji: "🎙️"
  vellum:
    category: "voice"
    display-name: "Meeting Bot"
---

Use this skill when the user explicitly asks the assistant to send a bot into a meeting to take notes or transcribe (e.g. "join this call", "have the bot take notes on this Zoom", usually with a meeting URL in context). The bot appears as a visible participant, so never do it proactively.

## Prerequisites

The Recall API key must be stored in the credential store. If joining fails with a 401 error, load the **meeting-bot-setup** skill to guide the user through providing their key.

## When to join

Trigger on clear, explicit user requests only, paired with a meeting URL:

- "Join this call: https://meet.google.com/abc-defg-hij"
- "Have the note-taker sit in on this Zoom."

Do NOT trigger on:

- Ambient references to meetings on the user's calendar.
- Users discussing a meeting without asking the assistant to join.

## How to join

Run the join script with the meeting URL and the current conversation ID:

```bash
bun skills/meeting-bot/scripts/join.ts --meeting-url "https://meet.google.com/abc-defg-hij" --conversation-id "<current conversation id>"
```

The script reads the plugin's resolved config, resolves the Recall API key from the credential store, creates the bot, and registers the session. Recall.ai handles joining the call and begins streaming live transcript and participant events to the plugin's realtime receiver.

The script outputs the bot id. Keep it to leave later.

## How to leave

Run the leave script when the user says the bot can go:

```bash
bun skills/meeting-bot/scripts/leave.ts --bot-id "<id>"
```

When only one bot is active, `--bot-id` can be omitted:

```bash
bun skills/meeting-bot/scripts/leave.ts
```

## Supported platforms

Recall.ai supports Google Meet, Zoom, Microsoft Teams, Webex, and more. Any meeting URL Recall accepts works here.
