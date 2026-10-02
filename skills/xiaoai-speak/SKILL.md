# xiaoai-speak

Speak text out loud through the user's XiaoAI speaker (小爱音箱).

## When to use

Use this skill whenever the user wants sound to come out of the speaker rather
than text on screen:

- "让小爱说 ...", "用音箱播报一下 ...", "语音念一下 ...", "读出来"
- "say it out loud", "announce ... on the speaker", "read this back to me"
- a spoken summary, reminder, alert or notification
- **a conversation that arrived through the speaker** — the user said the wake
  word, spoke, and is now waiting to hear an answer. In that case the user
  cannot see this window: if the reply stays on screen, they hear nothing.

Do not use it for ordinary chat replies typed into the window: those belong in
the conversation, not on the speaker. Only speak when the user asked for speech,
when the message came in through the speaker, or when a task explicitly ends
with an announcement.

## How to call it

Call the `xiaoai_speak` tool with the exact text to speak:

- `text` (required): what to say. Write it the way it should be heard — no
  Markdown, no code blocks, no bullet lists, no URLs read out character by
  character. Keep it short; a speaker has no scrollbar.

The call returns as soon as playback has been handed to the speaker, so a long
sentence does not hold the turn open. There is no blocking option: the bridge's
synchronous playback path is unreliable on this device, so the plugin always
uses the asynchronous one.

## Rules

1. Speak once per intent. If the same sentence would be spoken twice, say it
   once and let the conversation carry the rest.
2. Never speak secrets, tokens, credentials or anything the user marked as
   private.
3. Approval prompts are not spoken. If a tool call needs the user to approve
   something on screen, say only that they need to confirm on the computer —
   never read the approval payload aloud.
4. If `xiaoai_speak` reports that the speaker is unavailable, say so in text and
   carry on; do not retry in a loop.
5. A spoken answer is still a normal answer: keep the full detail in the
   conversation and put only the hearable summary on the speaker.
