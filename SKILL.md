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

## When to join

Trigger on clear, explicit user requests only, paired with a meeting URL:

- "Join this call: https://meet.google.com/abc-defg-hij"
- "Have the note-taker sit in on this Zoom."

Do NOT trigger on:

- Ambient references to meetings on the user's calendar.
- Users discussing a meeting without asking the assistant to join.

## How to join

Call `meeting_bot_join` with the meeting URL:

```
meeting_bot_join(meeting_url: "https://meet.google.com/abc-defg-hij")
```

Recall.ai handles joining the call and begins streaming live transcript and participant events to the plugin's realtime receiver. The tool returns a bot id — keep it to leave later.

## How to leave

Call `meeting_bot_leave` when the user says the bot can go:

```
meeting_bot_leave(bot_id: "<id>")
```

When only one bot is active, `bot_id` can be omitted.

## Supported platforms

Recall.ai supports Google Meet, Zoom, Microsoft Teams, Webex, and more. Any meeting URL Recall accepts works here.
