# xiaoai-speak

Speak text out loud through the user's XiaoAI speaker (小爱音箱).

## When to use

**A message that arrived through the speaker is answered out loud by itself.**
When the user says the wake word and talks to the speaker, the plugin reads the
reply you write and speaks it, lightly rephrased into something that sounds
natural out loud. So the normal voice conversation needs no tool call at all:
just write the answer. The user cannot see this window — if you only think it,
they hear nothing.

Call the `xiaoai_speak` tool when the exact wording matters or when the sound is
not the reply itself:

- the user asked for a specific text to be read out ("让小爱说 ...", "用音箱念
  一下 ...", "read this back to me") and it must come out word for word
- an announcement, reminder or alert should play while your reply stays a reply
- a task finishes and the conclusion belongs on the speaker
- the user asked for sound from a desktop conversation: "say it out loud",
  "announce ... on the speaker"

Do not call it for ordinary chat replies typed into the window that nobody asked
to hear — those belong in the conversation, not on the speaker.

### Speaking without being asked

You do not have to wait for a message to arrive. A reminder coming due, a long
task finishing, or anything the user should hear right now can be spoken
directly, from a desktop session as well as a voice one: call `xiaoai_speak` and
the line goes to the speaker. Nothing needs to be prepared first — if the bridge
is not running, the plugin starts it on demand and the call waits for it.

Speak up only when the sound itself is the point: something time-sensitive, or a
result the user is waiting on rather than one they will come back to read. A
running commentary of your own progress is noise in their room.

## How to call it

Call the `xiaoai_speak` tool with the exact text to speak:

- `text` (required): what to say, written the way it should be heard. It is
  spoken verbatim: no Markdown, no code blocks, no bullet lists, no URLs read
  out character by character. Keep it short; a speaker has no scrollbar.

One call per turn: a second `xiaoai_speak` in the same turn is ignored, and a
turn that calls it speaks only what the tool was given — the reply text is not
spoken a second time after it.

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
   conversation and put only the hearable part on the speaker. In a voice turn
   that means a short, plain reply — not a report with headings and tables.
