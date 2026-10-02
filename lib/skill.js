/**
 * The `xiaoai-speak` runtime skill: when and how the agent should speak through
 * the XiaoAI speaker.
 *
 * The body is read from `skills/xiaoai-speak/SKILL.md` at load so the packaged
 * Markdown stays the single source of truth; `resourceBase` points the agent at
 * that directory for any file the skill references.
 * @module dsh-xiaoai-bridge/skill
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Skill identifier; must match `^[a-z0-9]+(?:-[a-z0-9]+)*$`. */
export const SKILL_NAME = 'xiaoai-speak';

/** Skill directory, also handed to the agent as the skill's resource base. */
export const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const SKILL_DIR = join(PACKAGE_ROOT, 'skills', SKILL_NAME);

const SKILL_FILE = join(SKILL_DIR, 'SKILL.md');

/**
 * The trigger surface. DSH renders `description` into the skill catalog and
 * does not render `whenToUse`, so every activation cue has to live here.
 */
export const SKILL_DESCRIPTION = [
  'Speak text out loud through the user\'s XiaoAI speaker (小爱音箱).',
  'Use when the user asks to 让小爱说 / 用音箱播报 / 语音念一下 / say it out loud / announce',
  'something on the speaker, or asks for a spoken summary, reminder or notification.',
  'Also use for hands-free follow-ups from a conversation that started with the wake word.',
].join(' ');

const FALLBACK_CONTENT = [
  '# ' + SKILL_NAME,
  '',
  SKILL_DESCRIPTION,
  '',
  'Call the `xiaoai_speak` tool with the exact text to speak.',
].join('\n');

/** Skill body as shipped in the package. */
export let SKILL_CONTENT = FALLBACK_CONTENT;
try {
  const raw = readFileSync(SKILL_FILE, 'utf8').trim();
  if (raw.length > 0) SKILL_CONTENT = raw;
} catch {
  // A packaging mistake must not take the whole plugin down: the fallback body
  // still names the tool, and /health reports the skill directory.
}
