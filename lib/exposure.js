/**
 * dsh-xiaoai-bridge: where `xiaoai_speak` and its skill are registered.
 *
 * A voice conversation and a desktop chat share one tool registry, so a global
 * registration would put `xiaoai_speak` in every session's tool list — including
 * the sessions that have no speaker to talk to. The host registry is layered
 * instead: a registration files into *the calling context's scope*, so calling
 * `tools.register` from an agent's own context puts the entry in that agent's
 * layer and nowhere else. The agent's layer is exactly the speaker-started
 * conversation, which is the only place the tool belongs.
 *
 * Lifecycle, as the host documents it:
 *
 * - A scope's registrations are unwound when the agent is disposed
 *   (`agent/disposed` is emitted after that unwind), so nothing here tracks
 *   registration handles for the scoped case.
 * - Registering the same name twice into the *same* layer fails. A `WeakSet` of
 *   agent contexts is what keeps a reused or resumed agent from being registered
 *   twice, and a resumed session gets a fresh context, so a new agent does
 *   register again.
 *
 * The escape hatch (`speakFromAnySession`) is the user saying "register it
 * globally after all". While it is on, `syncGlobal()` keeps both entries in the
 * global layer, which is the pre-scoping behaviour. Scoped registration still
 * happens for voice agents — it shadows an identical definition and costs
 * nothing — which is what keeps a live voice session working when the hatch is
 * switched off again.
 * @module dsh-xiaoai-bridge/exposure
 */

/** This host offers no per-scope registration seam (or lacks one of the two). */
export const SCOPE_UNAVAILABLE_CODE = 'scope-registration-unavailable';
/** The seam exists but registering into it threw. */
export const SCOPE_FAILED_CODE = 'scope-registration-failed';

/** @param {unknown} err @returns {string} a bounded message string */
function messageOf(err) {
  return String(err?.message ?? err).slice(0, 300);
}

/**
 * Read one registry service from an agent context.
 *
 * Cordis exposes services as context properties; `get()` is the other shape a
 * host may use. Either is accepted, and anything without a `register` function
 * counts as absent.
 * @param {object} agentCtx the context handed to an agent's `setup` hook
 * @param {string} name service name (`tools` or `skills`)
 * @returns {object|null} the registry, or null when this host does not have it
 */
function registryOf(agentCtx, name) {
  if (!agentCtx || typeof agentCtx !== 'object') return null;
  const direct = agentCtx[name];
  if (direct && typeof direct.register === 'function') return direct;
  const viaGet = typeof agentCtx.get === 'function' ? agentCtx.get(name) : null;
  if (viaGet && typeof viaGet.register === 'function') return viaGet;
  return null;
}

/**
 * Create the exposure manager.
 *
 * @param {object} options
 * @param {object} options.ctx plugin context (owns the global layer)
 * @param {() => object} options.getConfig live settings projection
 * @param {object} [options.logger] host logger
 * @param {object} [options.diagnostics] diagnostics store (see diagnostics.js)
 * @param {() => object} options.tool factory returning a fresh tool definition
 * @param {() => object} options.skill factory returning a fresh skill registration
 * @returns {{attach: Function, syncGlobal: Function, dispose: Function, state: Function}} exposure API
 */
export function createExposure({ ctx, getConfig, logger, diagnostics, tool, skill }) {
  /** Agent contexts already registered, so one layer is never written twice. */
  const attached = new WeakSet();
  /** Disposers of the global registration, or null when it is not open. */
  let globalDisposers = null;
  /** How many agent scopes were registered, for `/health`. */
  let scopedCount = 0;
  /** Only the first "this host cannot scope" is worth a row. */
  let unavailableNoted = false;

  function config() {
    try {
      return getConfig() ?? {};
    } catch {
      return {};
    }
  }

  /** The user's explicit escape hatch: only `true` opens it. */
  function globalWanted() {
    return config().speakFromAnySession === true;
  }

  function note(code, detail) {
    try {
      diagnostics?.note?.({ code, detail, level: 'warn' });
    } catch {
      // A diagnostic path that can break the thing it describes is worse than none.
    }
  }

  function globalRegistry(name) {
    const direct = ctx[name];
    if (direct && typeof direct.register === 'function') return direct;
    const viaGet = typeof ctx.get === 'function' ? ctx.get(name) : null;
    if (viaGet && typeof viaGet.register === 'function') return viaGet;
    return null;
  }

  /**
   * Register both entries into one agent's scope.
   *
   * Called for every speaker session, and never for anything else: the agent
   * context *is* the boundary the user asked for. A host without the seam gets
   * no registration at all plus one diagnostic — silently falling back to the
   * global layer is the bug this module exists to remove.
   * @param {object} agentCtx the agent's own context
   */
  function registerScoped(agentCtx) {
    const tools = registryOf(agentCtx, 'tools');
    const skills = registryOf(agentCtx, 'skills');
    if (!tools || !skills) {
      // With the hatch open the global layer already carries both entries, so
      // there is nothing missing and nothing to report.
      if (globalDisposers === null && !unavailableNoted) {
        unavailableNoted = true;
        const missing = [!tools && 'tools', !skills && 'skills'].filter(Boolean).join('+');
        logger?.warn?.(
          `dsh-xiaoai-bridge: this host cannot scope a registration (no ${missing}): `
          + 'xiaoai_speak stays unavailable, because it is not registered globally',
        );
        note(SCOPE_UNAVAILABLE_CODE, `no ${missing} in the agent scope`);
      }
      return;
    }
    try {
      // Two layers must not share one definition object: the host may keep what
      // it is given, and a scope's entry is unwound independently.
      tools.register(tool());
      skills.register(skill());
      scopedCount += 1;
      logger?.info?.('dsh-xiaoai-bridge: xiaoai_speak registered in one speaker session scope');
    } catch (err) {
      note(SCOPE_FAILED_CODE, messageOf(err));
    }
  }

  function openGlobal() {
    if (globalDisposers !== null) return;
    const tools = globalRegistry('tools');
    const skills = globalRegistry('skills');
    if (!tools || !skills) {
      note(SCOPE_UNAVAILABLE_CODE, 'no tools/skills service on the plugin context');
      return;
    }
    try {
      const disposers = [tools.register(tool()), skills.register(skill())];
      globalDisposers = disposers;
      logger?.info?.(
        'dsh-xiaoai-bridge: speakFromAnySession is on; xiaoai_speak is registered for every session',
      );
    } catch (err) {
      globalDisposers = null;
      note(SCOPE_FAILED_CODE, messageOf(err));
    }
  }

  function closeGlobal() {
    if (globalDisposers === null) return;
    const disposers = globalDisposers;
    globalDisposers = null;
    for (const dispose of disposers) {
      try {
        dispose?.();
      } catch (err) {
        logger?.warn?.(`dsh-xiaoai-bridge: unregistering the global speak tool failed: ${messageOf(err)}`);
      }
    }
    logger?.info?.('dsh-xiaoai-bridge: speakFromAnySession is off; xiaoai_speak left the global registry');
  }

  /**
   * Follow the escape-hatch setting.
   *
   * Reads the live projection on every call, so it is safe to run on any
   * settings write and cheap when nothing changed. Nothing else has to be
   * re-registered: the scoped entries do not depend on this setting.
   */
  function syncGlobal() {
    if (globalWanted()) openGlobal();
    else closeGlobal();
  }

  /**
   * Hand one agent's context to the scoped registration.
   *
   * Idempotent per context object, and never throws: it runs inside the host's
   * agent setup, where an exception would abort the session.
   * @param {object} agentCtx the agent's own context
   */
  function attach(agentCtx) {
    if (!agentCtx || typeof agentCtx !== 'object') return;
    if (attached.has(agentCtx)) return;
    attached.add(agentCtx);
    try {
      registerScoped(agentCtx);
    } catch (err) {
      note(SCOPE_FAILED_CODE, messageOf(err));
    }
  }

  /** Drop the global registration; the host unwinds scoped ones with their agent. */
  function dispose() {
    closeGlobal();
  }

  /** @returns {{mode: string, scoped: number, scopeSeam: boolean}} what the status card needs */
  function state() {
    const mode = globalDisposers !== null ? 'global' : (unavailableNoted ? 'unavailable' : 'scoped');
    return { mode, scoped: scopedCount, scopeSeam: !unavailableNoted };
  }

  return { attach, syncGlobal, dispose, state };
}
