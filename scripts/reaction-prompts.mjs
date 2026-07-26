/**
 * Crucible Reaction Prompts
 * --------------------------------------------------------------------------
 * Watches combat for moments where a combatant could use a "reaction" style
 * action (an Action tagged "reaction" in the Crucible system, e.g. the
 * built-in Reactive Strike or Counterspell) and posts a chat card to that
 * actor's owner(s) and the GM with a one-click "Use it?" button.
 *
 * This module never invents new rules. Every button click ultimately calls
 * the real CrucibleAction#use() workflow, so the system's own targeting,
 * cost, and eligibility checks (canUse, tag hooks, action hooks, etc.) are
 * the final word. Before ever posting a prompt though, it runs the same two
 * checks a player would otherwise have to eyeball themselves:
 *   - action._canUse() - does the actor still have the Action Points/Focus/
 *     whatever else the action costs, and does it pass the "reaction" tag's
 *     own gates (in combat, not their turn, not Unaware, etc.)?
 *   - isTargetInRange() - is the target within the action's actual usable
 *     range right now (using the same range math, including weapon reach,
 *     that the system uses when the action is really used)?
 * A false positive just means a player sees a button that then politely
 * fails with the system's normal warning; a false negative just means
 * nobody gets prompted for that one opportunity (they can still act
 * manually from their sheet as before).
 *
 * Extensibility
 * --------------------------------------------------------------------------
 * Other modules or a world script can register additional actions against
 * either built-in trigger, or add an entirely new trigger type, via:
 *
 *   const api = game.modules.get("crucible-reaction-prompts").api;
 *   api.registerActionTrigger("someTalentActionId", "engagementLeft");
 *   api.registerTriggerType("allyDowned", { ... detector logic ... });
 *
 * See registerActionTrigger/registerTriggerType below for details.
 */

const MODULE_ID = "crucible-reaction-prompts";
const FLAG_SCOPE = MODULE_ID;

/** Toggle verbose console logging while troubleshooting a trigger that "should" have fired but didn't. */
const DEBUG = true;
function log(...args) {
  if (DEBUG) console.debug(`${MODULE_ID} |`, ...args);
}

/* -------------------------------------------- */
/*  Trigger Registry                             */
/* -------------------------------------------- */

/**
 * Maps an Action id (CrucibleAction#id) to the trigger type that should
 * watch for opportunities to use it. Built-ins are seeded below; extend
 * via registerActionTrigger() for talent-granted reactions.
 * @type {Map<string, string>}
 */
const ACTION_TRIGGERS = new Map([
  ["reactiveStrike", "engagementLeft"],
  ["counterspell", "spellCast"],
  // Talent-granted retaliation actions that require the actor to have just defended against a melee
  // attack with a specific result (see _canUsePostDefend in Crucible's own module/hooks/action.mjs).
  // Each one's own canUse hook already enforces which specific result (Dodge/Parry/Block) it needs, so
  // registering all five against the same trigger type is enough - evaluateActorReactions() lets each
  // action's real _canUse() sort out which of them, if any, actually applies.
  ["counterEvade", "meleeDefense"],     // Requires a Dodge
  ["counterRiposte", "meleeDefense"],   // Requires a Parry
  ["counterStrike", "meleeDefense"],    // Requires a Block
  ["defensiveRoll", "meleeDefense"],    // Requires a Dodge
  ["repercussiveBlock", "meleeDefense"], // Requires a Block, and the attack not yet confirmed
  ["bodyBlock", "meleeDefense"],        // Requires a Glance or Armor result, and the attack not yet confirmed

  // A Guardian-style talent: react to an ally being hit by a strike (melee or ranged) by taking the hit
  // in their place. See HOOKS.interpose in module/hooks/action.mjs.
  ["interpose", "allyStruck"],

  // A follow-up strike usable immediately after you land a killing blow in melee on your own turn - not
  // an interrupt of someone else's turn, but still exactly the kind of "hey, you can do this now" moment
  // this module exists for. See HOOKS.ruthlessMomentum in module/hooks/action.mjs.
  ["ruthlessMomentum", "meleeKill"],

  // A Guardian-style talent, the mirror image of Reactive Strike: react to an enemy moving INTO your
  // engagement radius rather than out of it. Has no canUse hook of its own in Crucible - it relies
  // entirely on the generic "reaction" tag gate - so this trigger type is the whole story.
  ["intercept", "engagementEntered"],

  // Registered against the same trigger as Counterspell, since its condition is also "an enemy you can
  // see casts a spell". Interrupting Throw's talent text additionally requires the spell to have cost 3+
  // Action - Crucible has no canUse hook enforcing that (no HOOKS.interruptingThrow exists), so this
  // module enforces it itself via EXTRA_REQUIREMENTS below rather than relying on the real action.use()
  // to catch it.
  ["interruptingThrow", "spellCast"],

  // React to any enemy action - spell, strike, whatever - that targets someone other than the caster
  // themselves, once per round (Crucible's own HOOKS.coveringFire enforces the once-per-round part; this
  // module just needs to notice the moment). Broader than the existing spellCast/meleeDefense triggers,
  // so it gets its own detector (checkEnemyTargetsOther) rather than reusing one of them.
  ["coveringFire", "enemyActsAgainstOther"]
]);

/**
 * Register an additional Action id against an existing trigger type.
 * @param {string} actionId       The Action id to watch for, e.g. "reactiveStrike".
 * @param {string} triggerType    One of the registered trigger type keys (see registerTriggerType).
 */
function registerActionTrigger(actionId, triggerType) {
  if (!TRIGGER_TYPES.has(triggerType)) {
    throw new Error(`${MODULE_ID} | Unknown trigger type "${triggerType}". `
      + `Known types: ${[...TRIGGER_TYPES.keys()].join(", ")}`);
  }
  ACTION_TRIGGERS.set(actionId, triggerType);
}

/**
 * Extra eligibility guards for specific actionIds, on top of the trigger match + the action's own
 * _canUse(). Needed only when a talent's rules text imposes a condition that Crucible has no canUse hook
 * enforcing - action._canUse() will happily pass even though the talent shouldn't apply yet. Each guard
 * receives the CrucibleAction that caused the trigger to fire (e.g. the spell that was just cast) and
 * returns true if the reaction is still plausible; the actionId's own trigger goes unposted if it returns
 * false, exactly like a failed _canUse() would.
 * @type {Map<string, (sourceAction: CrucibleAction) => boolean>}
 */
const EXTRA_REQUIREMENTS = new Map([
  // Interrupting Throw's talent text: "An enemy you can see casts a Spell which costs 3 Action or
  // greater." Falls back to allowing the prompt if cost data can't be read for some reason - fail open,
  // same philosophy as isTargetInRange().
  ["interruptingThrow", sourceAction => (sourceAction?.cost?.action ?? 3) >= 3]
]);

/**
 * Register an additional actionId => extra-guard function pair (see EXTRA_REQUIREMENTS above).
 * @param {string} actionId
 * @param {(sourceAction: CrucibleAction) => boolean} guard
 */
function registerExtraRequirement(actionId, guard) {
  EXTRA_REQUIREMENTS.set(actionId, guard);
}

/**
 * Trigger type definitions. Each trigger type owns the detection logic that decides *when* to look for
 * reactors, and hands off to evaluateActorReactions() to do the actual per-actor eligibility check + prompt.
 * A custom trigger type just needs to eventually call evaluateActorReactions(reactorToken, triggerType, targetToken).
 * @type {Map<string, {label: string}>}
 */
const TRIGGER_TYPES = new Map([
  ["engagementLeft", {label: "an enemy leaves engagement"}],
  ["spellCast", {label: "an enemy casts a spell"}],
  ["meleeDefense", {label: "you just defended against a melee attack"}],
  ["allyStruck", {label: "an ally is struck by an attack"}],
  ["meleeKill", {label: "you land a killing blow in melee"}],
  ["engagementEntered", {label: "an enemy enters your engagement"}],
  ["enemyActsAgainstOther", {label: "an enemy acts against someone else"}]
]);

/**
 * Register a brand new trigger type name so registerActionTrigger() will accept it.
 * The caller is responsible for wiring up whatever Hooks are needed to detect the moment and call
 * evaluateActorReactions(reactorToken, triggerType, targetToken) when it happens.
 * @param {string} triggerType
 * @param {{label: string}} [config]
 */
function registerTriggerType(triggerType, config = {}) {
  TRIGGER_TYPES.set(triggerType, {label: config.label ?? triggerType});
}

/* -------------------------------------------- */
/*  Setup                                        */
/* -------------------------------------------- */

Hooks.once("init", () => {
  const mod = game.modules.get(MODULE_ID);
  mod.api = {registerActionTrigger, registerTriggerType, registerExtraRequirement};
});

Hooks.once("ready", () => {
  if (game.system.id !== "crucible") {
    console.warn(`${MODULE_ID} | This module is built for the Crucible system and has been disabled.`);
  }
});

/* -------------------------------------------- */
/*  Triggers: Engagement Left (Reactive Strike) &        */
/*            Engagement Entered (Intercept)             */
/* -------------------------------------------- */

/** Last known set of engaged-enemy Token ids, per reactor Token id, so departures can be diffed out. */
const lastEngagement = new Map();

Hooks.on("refreshToken", token => {
  if (game.system.id !== "crucible") return;
  if (!isAuthoritativeClient()) return;
  if (!game.combat?.started) return;
  if (!token.actor || (token.actor.type === "group")) return;
  // A left-click drag animates a temporary preview clone across the canvas as the mouse moves, and that
  // clone fires refreshToken on every frame just like a real placeable would - well before the move is
  // ever committed (or even finished being dragged; the user might drag back out again). Reacting to those
  // preview frames posts a "real" whispered prompt for a position that was never actually landed on, and
  // that premature prompt then eats the RECENT_PROMPT_WINDOW_MS debounce slot that the real, committed
  // landing needs later - see the interceptMove/waitForReactionWindow flow above, which depends on exactly
  // one authoritative prompt being posted once the (possibly truncated) move actually lands.
  if (token.isPreview) return;
  checkEngagementLeft(token);
});

function checkEngagementLeft(token) {
  const currentEnemies = token.engagement?.enemies;
  if (!currentEnemies) return;
  const currentIds = new Set([...currentEnemies].map(t => t.id));
  const previousIds = lastEngagement.get(token.id);
  log(token.name, "REAL engagement set now:", [...currentEnemies].map(t => t.name),
    "(was:", previousIds ? [...previousIds].map(id => canvas.tokens?.get(id)?.name) : "no baseline", ")");
  lastEngagement.set(token.id, currentIds);
  if (!previousIds) return; // No baseline yet for this token - nothing to diff.

  // IMPORTANT: Foundry's refreshToken hook only fires for the token that actually moved (call it the
  // "mover") - not for the other, stationary tokens whose engagement set changed only as a side effect of
  // that move. `token` here is always the mover. That means `token` is never the potential reactor: for
  // Reactive Strike/Intercept it's the STATIONARY token on the other side of the engagement change - the
  // one whose engagement set just lost or gained a member - that gets to react, targeting the mover.
  for (const enemyId of previousIds) {
    if (currentIds.has(enemyId)) continue; // Still engaged.
    const enemyToken = canvas.tokens?.get(enemyId);
    if (!enemyToken?.actor) continue;
    evaluateActorReactions(enemyToken, "engagementLeft", token);
  }

  // The mirror case, for Intercept: an enemy that wasn't in the set before now is - i.e. they just moved
  // into (or through) this token's engagement radius. Same reasoning: the stationary token who just
  // gained `token` (the mover) as a newly-engaged enemy is the one who might hold Intercept.
  for (const enemyId of currentIds) {
    if (previousIds.has(enemyId)) continue; // Was already engaged - not a new entry.
    const enemyToken = canvas.tokens?.get(enemyId);
    if (!enemyToken?.actor) continue;
    evaluateActorReactions(enemyToken, "engagementEntered", token);
  }
}

// Tokens are deleted or leave combat: drop their stale baselines so memory doesn't grow unbounded.
Hooks.on("deleteToken", tokenDoc => lastEngagement.delete(tokenDoc.id));
Hooks.on("deleteCombat", () => lastEngagement.clear());

/* -------------------------------------------- */
/*  Movement Interception (block-and-retry)      */
/*  ------------------------------------------   */
/*  Reactive Strike/Intercept are only ever detected above via refreshToken, which fires AFTER a move has  */
/*  already landed - so a single multi-square drag only ever gets checked at its final resting position,  */
/*  never at the intermediate squares where a reactor's engagement radius was actually crossed. Foundry    */
/*  v14 has no generic "pause mid-animation on an arbitrary condition" hook (that's Region-only - see the  */
/*  Regions system), but it does have preMoveToken, which fires before a move commits with the path this   */
/*  update is about to commit right now (move.passed.waypoints, already expanded to one entry per grid     */
/*  cell - see TokenDocument#getCompleteMovementPath) available up front, and which can reject it outright.*/
/*  (move.pending.waypoints is a different thing - it's only the not-yet-committed remainder of a multi-leg*/
/*  *planned* route beyond a checkpoint, e.g. a queued ruler drag. For an ordinary single-destination move  */
/*  it's always empty, since nothing ever gets split into it - so it must NOT be used here.)                */
/*                                                                                                          */
/*  So instead of a true mid-stride freeze-frame, this walks that committed path looking for the earliest  */
/*  square where a hostile reactor's range condition would flip (out of range <-> in range), truncates the */
/*  move there, lets it land for real (so the normal refreshToken/checkEngagementLeft path above does the  */
/*  actual, authoritative detection against Crucible's own engagement math), waits for any prompt(s) that  */
/*  produces to be used or dismissed, then re-issues the rest of the original path. Net effect: the token  */
/*  doesn't animate through a reaction opportunity without stopping for it, even across a long drag.        */
/* -------------------------------------------- */

/** Token ids for which THIS client is currently re-issuing a move it already vetted - skip re-interception. */
const replayingMovement = new Set();

/** Chat message id -> {promise, resolve} for a posted reaction prompt, resolved once it's used/dismissed. */
const promptResolutions = new Map();

/** How long to keep watching for a reaction prompt to arrive after the truncated move settles, extended each
 *  time a new matching prompt shows up, before concluding no more are coming. */
const PROMPT_ARRIVAL_WINDOW_MS = 800;

/** Hard ceiling on how long a mover's remaining path waits on an unresolved prompt, so an inactive or slow-to-
 *  respond table can't stall combat indefinitely. */
const PROMPT_RESOLUTION_TIMEOUT_MS = 60000;

Hooks.on("preMoveToken", (document, move, options) => {
  if (game.system.id !== "crucible") return true;
  if (replayingMovement.has(document.id)) {
    log(document.name, "preMoveToken: skipping - this is our own re-issued leg");
    return true;
  }
  if (!game.combat?.started) {
    log(document.name, "preMoveToken: skipping - no combat is active");
    return true;
  }
  if (!document.actor || (document.actor.type === "group")) {
    log(document.name, "preMoveToken: skipping - no actor, or a group actor");
    return true;
  }
  // NOTE: preMoveToken has no `user` property on the movement object in v13/v14 - it only fires on the
  // client that initiated the move to begin with (per Foundry's own API docs), so no self-check is needed
  // or possible here. (Previously this guard checked move.user?.isSelf, which never existed and always
  // bailed - see commit history.)
  if (!move.passed?.waypoints?.length) {
    log(document.name, "preMoveToken: skipping - move.passed.waypoints is empty", move);
    return true;
  }

  log(document.name, `preMoveToken: scanning ${move.passed.waypoints.length} waypoint(s) for reaction crossings`);
  let crossingIndex;
  try {
    crossingIndex = findEarliestReactionCrossing(document, move);
  } catch (err) {
    console.error(`${MODULE_ID} | error scanning planned path for reaction crossings - allowing move`, err);
    return true; // a bug in our path scan should never be able to block ordinary movement
  }
  if (crossingIndex < 0) {
    log(document.name, "preMoveToken: no reaction crossing found in this path - allowing move uninterrupted");
    return true;
  }

  interceptMove(document, move, options, crossingIndex)
    .catch(err => console.error(`${MODULE_ID} | error handling intercepted movement`, err));
  return false;
});

/**
 * Walk the portion of a token's move that's actually about to be committed (move.passed.waypoints) looking
 * for the first waypoint at which some hostile reactor's registered engagementLeft/engagementEntered action
 * would flip between out-of-range and in-range relative to the mover. This is a cheap proxy for "did
 * engagement actually change" (Crucible's real engagement math is bounds- and wall-aware, via
 * Token#getEngagementRectangle/movePolygon) - it only needs to be good enough to pick roughly the right
 * square to pause at. The truncated move landing for real is what triggers the authoritative check.
 * @param {TokenDocument} document
 * @param {TokenMovementData} move
 * @returns {number} The index into move.passed.waypoints to truncate at (inclusive), or -1 if no crossing.
 */
function findEarliestReactionCrossing(document, move) {
  const moverToken = document.object;
  if (!moverToken) return -1;

  const candidates = [];
  for (const combatant of game.combat?.combatants ?? []) {
    const reactorToken = combatant.token?.object;
    if (!reactorToken || (reactorToken === moverToken) || !reactorToken.actor) continue;
    if (!areEnemies(reactorToken, moverToken)) {
      log(document.name, "crossing-scan: skipping", reactorToken.actor?.name, "- not hostile to mover");
      continue;
    }
    for (const [actionId, trigger] of ACTION_TRIGGERS) {
      if ((trigger !== "engagementLeft") && (trigger !== "engagementEntered")) continue;
      const action = reactorToken.actor.actions?.[actionId];
      if (!action) {
        log(document.name, "crossing-scan: skipping", reactorToken.actor?.name, actionId, "- actor has no such action");
        continue;
      }
      // engagementLeft/engagementEntered are keyed off the reactor's live engagement radius
      // (actor.system.movement.engagement = baseEngagement + per-weapon "engaging" bonus - see
      // actor-base.mjs), NOT the action's own range.minimum/maximum. reactiveStrike/intercept both
      // declare range:{weapon:true}, which resolves to the equipped weapon's attack reach - a distinct,
      // unrelated stat (e.g. a reach polearm can have attack range 3 while engagement is still 1). Using
      // action.range here was why the scan never saw a crossing: it kept treating the mover as "in range"
      // out to the weapon's reach, well past the point where the real engagement-radius check (used by
      // checkEngagementLeft) had already flipped.
      const engagement = reactorToken.actor.system.movement?.engagement;
      if (!engagement) {
        log(document.name, "crossing-scan: skipping", reactorToken.actor?.name, actionId,
          "- actor has no engagement radius", engagement);
        continue;
      }
      // _canUse() takes no target/position argument - it's purely the reactor's own resource/state gate
      // (Action Points, the "reaction" tag's turn-state checks, etc.), same call evaluateActorReactions
      // makes before its own isTargetInRange check. Filtering on it here avoids splitting and pausing the
      // mover's movement for a reactor who couldn't actually respond anyway (already used their reaction
      // this round, incapacitated, out of resources, not their kind of turn state, ...).
      try {
        action._canUse();
      } catch (err) {
        log(document.name, "crossing-scan: skipping", reactorToken.actor?.name, actionId,
          "- _canUse() rejected:", err?.message ?? err);
        continue;
      }
      log(document.name, "crossing-scan: candidate -", reactorToken.actor?.name, actionId,
        "engagement radius", engagement);
      candidates.push({reactorToken, action, engagement});
    }
  }
  if (!candidates.length) {
    log(document.name, "crossing-scan: no eligible reactors found - nothing to intercept for");
    return -1;
  }

  const footprintOf = wp => ({x: wp.x, y: wp.y, elevation: wp.elevation, width: wp.width, height: wp.height,
    depth: wp.depth});
  const inRange = (engagement, reactorToken, footprint) => {
    const range = crucible.api.canvas.grid.getLinearRange(reactorToken.document, footprint);
    // Crucible's real engagement math treats a range EQUAL to the radius as already outside engagement
    // (confirmed empirically: a measured range of exactly the engagement radius landed with the real
    // token.engagement.enemies set no longer containing the reactor) - so this must be a strict "<",
    // not "<=". Getting this wrong in the generous direction is exactly why the scan kept reporting
    // "still in range" at the token's actual final square while the real, authoritative check disagreed.
    const result = range < engagement;
    log(document.name, "crossing-scan: measured range", range, "vs engagement", engagement,
      "for", reactorToken.actor?.name, "at footprint", {x: footprint.x, y: footprint.y}, "->", result);
    return result;
  };

  const origin = {x: document.x, y: document.y, elevation: document.elevation, width: document.width,
    height: document.height, depth: document.depth};
  let previous = candidates.map(({reactorToken, engagement}) => inRange(engagement, reactorToken, origin));
  log(document.name, "crossing-scan: starting in-range state per candidate:", previous);

  for (let i = 0; i < move.passed.waypoints.length; i++) {
    const footprint = footprintOf(move.passed.waypoints[i]);
    for (let c = 0; c < candidates.length; c++) {
      const {reactorToken, action, engagement} = candidates[c];
      const now = inRange(engagement, reactorToken, footprint);
      if (now !== previous[c]) {
        log(document.name, "planned path crosses", reactorToken.actor?.name, "'s", action.id,
          "range at waypoint", i, "of", move.passed.waypoints.length);
        return i;
      }
      previous[c] = now;
    }
  }
  return -1;
}

/**
 * Truncate a planned move to the square where a reaction becomes relevant, let it actually land (so the real
 * refreshToken-driven check above can fire authoritatively), wait for whatever prompt(s) that produces to be
 * resolved, then re-issue the remainder of the original path.
 * @param {TokenDocument} document
 * @param {TokenMovementData} move
 * @param {object} options
 * @param {number} crossingIndex
 */
async function interceptMove(document, move, options, crossingIndex) {
  const toWaypointInput = wp => ({x: wp.x, y: wp.y, elevation: wp.elevation, width: wp.width, height: wp.height,
    depth: wp.depth, shape: wp.shape, level: wp.level, action: wp.action, snapped: wp.snapped,
    explicit: wp.explicit, checkpoint: wp.checkpoint});
  const upTo = move.passed.waypoints.slice(0, crossingIndex + 1).map(toWaypointInput);
  const remaining = move.passed.waypoints.slice(crossingIndex + 1).map(toWaypointInput);
  const carryOptions = {animation: options.animation, autoRotate: move.autoRotate, showRuler: move.showRuler};

  log(document.name, `intercepting move: truncating to waypoint ${crossingIndex}`,
    `(${upTo.length} waypoint(s) landing now, ${remaining.length} held back)`);

  // Guarded only for this exact truncated leg: it deliberately ends ON the waypoint where the crossing was
  // detected, so re-scanning it unguarded could immediately re-detect that same boundary at its last waypoint
  // and truncate to itself forever, making zero forward progress. `remaining` is NOT guarded below - if the
  // rest of the path crosses a second, later reaction opportunity, preMoveToken firing again for it is exactly
  // what lets this pause a second time instead of sailing through it.
  replayingMovement.add(document.id);

  // Start listening for a reaction prompt BEFORE the truncated move lands, not after. TokenDocument#move()'s
  // promise only resolves once the move's full animation finishes, but the refreshToken -> checkEngagementLeft
  // -> evaluateActorReactions -> postReactionPrompt chain that actually posts the prompt reads the token's
  // already-committed document position, which updates (and can fire that whole chain to completion) well
  // before the animation-bound promise below resolves - especially when this client is also the authoritative
  // GM client running that check. Registering the listener only after awaiting the move can miss a prompt
  // that was created and broadcast in the meantime, since Hooks can't retroactively deliver a past event.
  const {promise: moveSettled, resolve: resolveMoveSettled} = Promise.withResolvers();
  const reactionWindow = waitForReactionWindow(document.actor, moveSettled);

  let completed;
  const legStart = performance.now();
  try {
    completed = await document.move(upTo, carryOptions);
  } finally {
    replayingMovement.delete(document.id);
    resolveMoveSettled();
  }
  log(document.name, "truncated leg landed, completed:", completed, "- now at", document.x, document.y,
    `(${Math.round(performance.now() - legStart)}ms elapsed - if this is ~0ms, the leg teleported instead of animating)`);
  if (!completed || !remaining.length) return;

  log(document.name, "holding remaining movement, waiting on reaction window...");
  const waitStart = performance.now();
  await reactionWindow;
  log(document.name, "reaction window closed - resuming remaining movement to original destination",
    `(waited ${Math.round(performance.now() - waitStart)}ms)`);

  await document.move(remaining, carryOptions);
  log(document.name, "resumed movement completed - now at", document.x, document.y);
}

/**
 * Wait for any reaction prompt(s) targeting this actor to arrive (posted by the authoritative GM client, which
 * may not be this client at all, so this only ever watches for the normal networked createChatMessage
 * broadcast rather than assuming any local handoff) and then be resolved.
 * @param {CrucibleActor} moverActor
 * @param {Promise<void>} moveSettled  Resolves once the triggering move has actually landed - nothing can be
 *   prompted before that, so the "nothing new showed up" quiet-period countdown doesn't start until then, even
 *   though this starts listening for the createChatMessage broadcast immediately.
 */
async function waitForReactionWindow(moverActor, moveSettled) {
  const watched = new Map(); // messageId -> resolution promise
  let settleTimer;
  let armed = false; // true once the triggering move has landed and the quiet-period countdown is live
  const {promise: arrivalWindowClosed, resolve: closeArrivalWindow} = Promise.withResolvers();
  const rearmArrivalWindow = () => {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(closeArrivalWindow, PROMPT_ARRIVAL_WINDOW_MS);
  };

  const onPrompt = message => {
    const flags = message.flags?.[FLAG_SCOPE];
    if (!flags || (flags.targetUuid !== moverActor.uuid) || flags.resolved) return;
    watched.set(message.id, registerPromptResolution(message.id));
    if (armed) rearmArrivalWindow(); // a prompt arriving pre-armed is already captured; the countdown starts below
  };
  Hooks.on("createChatMessage", onPrompt);

  await moveSettled;
  armed = true;
  rearmArrivalWindow();

  const hardTimeout = () => new Promise(resolve => setTimeout(resolve, PROMPT_RESOLUTION_TIMEOUT_MS));
  await Promise.race([arrivalWindowClosed, hardTimeout()]);
  Hooks.off("createChatMessage", onPrompt);
  clearTimeout(settleTimer);

  if (!watched.size) return;
  log("movement paused for", watched.size, "reaction prompt(s) targeting", moverActor.name);
  await Promise.race([Promise.all(watched.values()), hardTimeout()]);
}

/**
 * Get (creating if needed) a promise that resolves once the given reaction-prompt chat message is marked
 * resolved (used or dismissed) - see the "resolved" flag set in resolveMessage() below.
 * @param {string} messageId
 * @returns {Promise<void>}
 */
function registerPromptResolution(messageId) {
  let entry = promptResolutions.get(messageId);
  if (!entry) {
    const {promise, resolve} = Promise.withResolvers();
    entry = {promise, resolve};
    promptResolutions.set(messageId, entry);
  }
  return entry.promise;
}

Hooks.on("updateChatMessage", (message, changes) => {
  if (!changes.flags?.[FLAG_SCOPE]?.resolved) return;
  const entry = promptResolutions.get(message.id);
  if (!entry) return;
  entry.resolve();
  promptResolutions.delete(message.id);
});

Hooks.on("deleteChatMessage", message => promptResolutions.delete(message.id));

/* -------------------------------------------- */
/*  Triggers driven by createChatMessage:                     */
/*    Spell Cast (Counterspell, Interrupting Throw)           */
/*    Melee Defense (Counter-Riposte/Strike/Body Block/…)     */
/*    Ally Struck (Interpose)                                 */
/*    Enemy Acts Against Other (Covering Fire)                */
/*  (Melee Kill/Ruthless Momentum is driven by updateChatMessage instead - see below - since it needs the */
/*  target's post-damage state, which doesn't exist until the strike is confirmed.)                       */
/* -------------------------------------------- */

Hooks.on("createChatMessage", message => {
  if (game.system.id !== "crucible") return;
  if (!isAuthoritativeClient()) return;
  if (!game.combat?.started) return log("skipped message - no combat is currently started", message.id);

  const flags = message.flags?.crucible;
  if (!flags?.action) return; // Most messages aren't a CrucibleAction at all - not worth logging.

  let action;
  try {
    action = crucible.api.models.CrucibleAction.fromChatMessage(message);
  } catch (err) {
    return log("could not reconstruct CrucibleAction from message", message.id, err);
  }
  if (!action) return log("fromChatMessage returned no action for message", message.id);

  const actingToken = fromUuidSync(flags.actor)?.token?.object
    ?? canvas.tokens?.placeables.find(t => t.actor?.uuid === flags.actor);
  if (!actingToken) return log("could not resolve an acting token for actor", flags.actor);

  log("reconstructed action", action.id, "tags:", [...(action.tags ?? [])], "for actor", actingToken.actor?.name);

  const wasSpell = action.tags?.has("composed") || action.tags?.has("iconicSpell");
  if (wasSpell) checkSpellCast(action, actingToken);

  const wasMeleeAttack = action.tags?.has("melee");
  if (wasMeleeAttack) checkMeleeDefense(action, actingToken);

  const wasStrike = action.tags?.has("strike");
  if (wasStrike) checkAllyStruck(action, actingToken);

  // Unlike the checks above, Covering Fire's condition isn't limited to a particular action tag - any
  // action at all that targets someone other than its own actor qualifies - so this one always runs.
  checkEnemyTargetsOther(action, actingToken);
});

/**
 * Ruthless Momentum needs to know whether the struck target actually died, but Crucible doesn't apply an
 * action's resource changes (damage, and therefore incapacitation) until the message is *confirmed* -
 * see CrucibleAction#confirm()/#applyEvents() in the system. At createChatMessage time (the initial post,
 * above) the target's health hasn't been reduced yet, so e.target.isIncapacitated would always read false
 * even for a genuinely lethal blow. Watch for the confirmation update instead, which is also exactly the
 * moment Crucible's own HOOKS.ruthlessMomentum.canUse() expects (it calls getLastAction({confirmed: true, ...})).
 */
Hooks.on("updateChatMessage", (message, data) => {
  if (game.system.id !== "crucible") return;
  if (!isAuthoritativeClient()) return;
  if (!game.combat?.started) return;

  // Only care about the moment a crucible action message transitions TO confirmed (not away from it, e.g.
  // a GM reversing an action, and not unrelated flag/content updates on the message).
  if (foundry.utils.getProperty(data, "flags.crucible.confirmed") !== true) return;

  const flags = message.flags?.crucible;
  if (!flags?.action) return;

  let action;
  try {
    action = crucible.api.models.CrucibleAction.fromChatMessage(message);
  } catch (err) {
    return log("could not reconstruct CrucibleAction from confirmed message", message.id, err);
  }
  if (!action?.tags?.has("melee")) return;

  const actingToken = fromUuidSync(flags.actor)?.token?.object
    ?? canvas.tokens?.placeables.find(t => t.actor?.uuid === flags.actor);
  if (!actingToken) return log("could not resolve an acting token for actor", flags.actor);

  checkMeleeKill(action, actingToken);
});

/**
 * Every hostile combatant is a plausible Counterspell reactor (their own action's canUse ultimately
 * confirms this really was still the last action).
 * @param {CrucibleAction} action
 * @param {Token} casterToken
 */
function checkSpellCast(action, casterToken) {
  const combatants = [...(game.combat?.combatants ?? [])];
  log("spell cast detected, checking", combatants.length, "combatants for a Counterspell opportunity");
  for (const combatant of combatants) {
    const reactorToken = combatant.token?.object;
    if (!reactorToken || (reactorToken === casterToken) || !reactorToken.actor) continue;
    if (!areEnemies(reactorToken, casterToken)) {
      log(reactorToken.actor?.name, "is not hostile to the caster - skipping");
      continue;
    }
    evaluateActorReactions(reactorToken, "spellCast", casterToken, action);
  }
}

/**
 * Only actors this melee attack actually targeted (i.e. who had a chance to roll a defense) are
 * plausible reactors - each candidate action's own canUse hook confirms which specific defense result
 * (Dodge/Parry/Block) it actually needed.
 * @param {CrucibleAction} action
 * @param {Token} attackerToken
 */
function checkMeleeDefense(action, attackerToken) {
  for (const targetActor of action.targets?.keys() ?? []) {
    if (targetActor === action.actor) continue;
    const reactorToken = targetActor.getActiveTokens()[0];
    if (!reactorToken) continue;
    evaluateActorReactions(reactorToken, "meleeDefense", attackerToken);
  }
}

/**
 * A single-target strike that actually hit (Glance or better) is a plausible moment for one of the
 * struck actor's allies to Interpose. Mirrors the exact check HOOKS.interpose.canUse itself performs
 * (single target, result >= GLANCE) so the pre-filter and the real gate agree.
 * @param {CrucibleAction} action
 * @param {Token} attackerToken
 */
function checkAllyStruck(action, attackerToken) {
  const eventsByTarget = action.eventsByTarget;
  if (!eventsByTarget || (eventsByTarget.size !== 1)) return; // Interpose only supports a single target.
  const [[targetActor, events]] = eventsByTarget;

  const {RESULT_TYPES} = game.system.api.dice.AttackRoll;
  const wasHit = events.roll?.some(e => e.roll?.data?.result >= RESULT_TYPES.GLANCE);
  if (!wasHit) return;

  const struckToken = targetActor.getActiveTokens()[0];
  if (!struckToken) return;

  const combatants = [...(game.combat?.combatants ?? [])];
  log("strike hit", targetActor.name, "- checking", combatants.length, "combatants for an Interpose opportunity");
  for (const combatant of combatants) {
    const allyToken = combatant.token?.object;
    if (!allyToken?.actor || (allyToken === struckToken) || (allyToken === attackerToken)) continue;
    if (!areAllies(allyToken, struckToken)) continue;
    evaluateActorReactions(allyToken, "allyStruck", struckToken);
  }
}

/**
 * Any action - spell, strike, or otherwise - that targeted at least one actor other than the one who
 * used it is a plausible Covering-Fire opportunity for every hostile combatant watching. Crucible's own
 * HOOKS.coveringFire.canUse only enforces the once-per-round limit, not which kind of action qualifies,
 * so (as with checkSpellCast) this offers the prompt broadly and lets the real canUse have the final say.
 * @param {CrucibleAction} action
 * @param {Token} actingToken
 */
function checkEnemyTargetsOther(action, actingToken) {
  const targetedOther = [...(action.targets?.keys() ?? [])].some(t => t !== action.actor);
  if (!targetedOther) return; // Self-targeted actions (e.g. Move, Defend) don't qualify.

  const combatants = [...(game.combat?.combatants ?? [])];
  log(actingToken.actor?.name, "acted against another target - checking", combatants.length,
    "combatants for a Covering Fire opportunity");
  for (const combatant of combatants) {
    const reactorToken = combatant.token?.object;
    if (!reactorToken || (reactorToken === actingToken) || !reactorToken.actor) continue;
    if (!areEnemies(reactorToken, actingToken)) continue;
    evaluateActorReactions(reactorToken, "enemyActsAgainstOther", actingToken);
  }
}

/**
 * A melee strike that incapacitated its target is a plausible moment for the attacker themselves (not
 * anyone else) to follow up with a Ruthless-Momentum-style action. Mirrors HOOKS.ruthlessMomentum.canUse.
 * @param {CrucibleAction} action
 * @param {Token} attackerToken
 */
function checkMeleeKill(action, attackerToken) {
  if (!attackerToken.actor) return;
  const killEvent = action.events?.find(e => (e.type === "strike") && e.target?.isIncapacitated);
  if (!killEvent) return;

  // Reference point for the flavor text and range check - falls back to the attacker's own token (i.e.
  // "always in range") if the defeated actor's token can't be resolved for some reason.
  const victimToken = killEvent.target.getActiveTokens()[0] ?? attackerToken;
  log(attackerToken.actor.name, "landed a killing blow - checking for a Ruthless Momentum opportunity");
  evaluateActorReactions(attackerToken, "meleeKill", victimToken);
}

/* -------------------------------------------- */
/*  Shared Eligibility + Prompting               */
/* -------------------------------------------- */

/** Debounce identical prompts that could otherwise fire twice from the same underlying event. */
const recentPrompts = new Map(); // key -> timestamp
const RECENT_PROMPT_WINDOW_MS = 5000;

/**
 * Check every action the reactor has which is registered against this trigger type, and post a prompt
 * for each one that looks usable right now.
 * @param {Token} reactorToken       The token who might get to react.
 * @param {string} triggerType       The trigger type that just fired (see TRIGGER_TYPES).
 * @param {Token} targetToken        The token whose action caused the trigger (the mover, the caster, etc.).
 * @param {CrucibleAction} [sourceAction]  The CrucibleAction that caused the trigger to fire, if any -
 *   passed through to EXTRA_REQUIREMENTS guards (e.g. so Interrupting Throw can check the spell's cost).
 */
async function evaluateActorReactions(reactorToken, triggerType, targetToken, sourceAction = null) {
  const actor = reactorToken.actor;
  if (!actor) return;

  for (const [actionId, registeredTrigger] of ACTION_TRIGGERS) {
    if (registeredTrigger !== triggerType) continue;

    const action = actor.actions?.[actionId];
    if (!action) continue; // This actor doesn't have that action at all - not worth logging, most won't.

    const extraGuard = EXTRA_REQUIREMENTS.get(actionId);
    if (extraGuard && !extraGuard(sourceAction)) {
      log(actor.name, actionId, "skipped - fails an extra requirement Crucible itself doesn't enforce");
      continue;
    }

    const key = `${reactorToken.id}:${targetToken.id}:${actionId}`;
    const now = Date.now();
    const last = recentPrompts.get(key);
    if (last && ((now - last) < RECENT_PROMPT_WINDOW_MS)) {
      log(actor.name, actionId, "skipped - already prompted for this within the debounce window");
      continue;
    }
    recentPrompts.set(key, now);

    let eligibilityError = null;
    try {
      action._canUse();
    } catch (err) {
      eligibilityError = err;
    }
    if (eligibilityError) {
      log(actor.name, actionId, "not eligible right now:", eligibilityError.message ?? eligibilityError);
      continue;
    }

    // engagementLeft/engagementEntered are driven entirely off Crucible's own live token.engagement set
    // (see checkEngagementLeft), which is already the authoritative "are they within reach" determination -
    // it's computed from actor.system.movement.engagement (baseEngagement + per-weapon "engaging" bonus -
    // see actor-base.mjs). NOTE: this is NOT the same radius as this action's own range.maximum - reactiveStrike/
    // intercept both declare range:{weapon:true}, which resolves to the equipped weapon's attack reach, a
    // distinct stat (a reach polearm can attack out to 3 while engagement is still 1). Re-running a linear
    // range check against action.range here would therefore be checking the wrong number entirely, on top of
    // re-measuring the target at its CURRENT (already landed) position - and for "engagementLeft" that
    // position is, by definition, the moment they just crossed OUTSIDE the (correct, engagement-radius) bound
    // - so the check below would almost always fail and silently swallow the one trigger it's supposed to
    // enable. Skip it for both triggers and let the real action.use() call (which runs while movement is
    // still paused at the crossing square - see interceptMove/waitForReactionWindow) be the final word.
    const skipRangeGate = (triggerType === "engagementLeft") || (triggerType === "engagementEntered");
    if (!skipRangeGate && !isTargetInRange(action, reactorToken, targetToken)) {
      log(actor.name, actionId, "target", targetToken.actor?.name, "is out of range - no prompt");
      continue;
    }

    log(actor.name, "can use", actionId, "against", targetToken.actor?.name, "- posting prompt");
    await postReactionPrompt({actor, reactorToken, action, targetToken, triggerType});
  }
}

/**
 * Does the reactor currently have the target within this action's usable range?
 * Reuses the same range math (crucible.api.canvas.grid.getLinearRangeCost against the action's prepared
 * range.minimum/range.maximum, which already accounts for equipped weapon reach) that the system's own
 * single-target acquisition performs when the action is actually used - so this stays in sync with
 * whatever the action's real range is, including reach weapons, without duplicating that logic.
 * Not used for engagementLeft/engagementEntered - see the skipRangeGate comment in evaluateActorReactions.
 * @param {object} action        A prepared CrucibleAction instance.
 * @param {Token} reactorToken
 * @param {Token} targetToken
 * @returns {boolean}
 */
function isTargetInRange(action, reactorToken, targetToken) {
  const {minimum, maximum} = action.range ?? {};
  if (!minimum && !maximum) return true; // Action has no distance restriction (e.g. self-only).
  try {
    const range = crucible.api.canvas.grid.getLinearRangeCost(reactorToken, targetToken);
    log(action.id, "range check:", reactorToken.actor?.name, "->", targetToken.actor?.name,
      "measured", range, `(minimum: ${minimum ?? "none"}, maximum: ${maximum ?? "none"})`);
    if (minimum && (range < minimum)) return false;
    if (maximum && (range > maximum)) return false;
    return true;
  } catch (err) {
    log(action.id, "range check errored - failing open:", err);
    return true; // Fail open - let the real click-time validation be the final word.
  }
}

/**
 * Are two tokens on hostile dispositions to one another?
 * @param {Token} a
 * @param {Token} b
 * @returns {boolean}
 */
function areEnemies(a, b) {
  const da = a.document.disposition, db = b.document.disposition;
  const HOSTILE = CONST.TOKEN_DISPOSITIONS.HOSTILE, FRIENDLY = CONST.TOKEN_DISPOSITIONS.FRIENDLY;
  if ((da === HOSTILE) && (db !== HOSTILE)) return true;
  if ((db === HOSTILE) && (da !== HOSTILE)) return true;
  return false;
}

/**
 * Are two tokens on the same (non-neutral) disposition, i.e. plausible allies for something like
 * Interpose? Deliberately stricter than "not enemies" - a Neutral token isn't really anyone's ally.
 * @param {Token} a
 * @param {Token} b
 * @returns {boolean}
 */
function areAllies(a, b) {
  const da = a.document.disposition, db = b.document.disposition;
  const {HOSTILE, FRIENDLY} = CONST.TOKEN_DISPOSITIONS;
  return ((da === FRIENDLY) && (db === FRIENDLY)) || ((da === HOSTILE) && (db === HOSTILE));
}

/**
 * Is this the one client responsible for detecting triggers and creating prompt chat messages?
 * Prevents every connected client from independently detecting the same event and posting duplicates.
 * @returns {boolean}
 */
function isAuthoritativeClient() {
  return game.users.activeGM?.isSelf ?? false;
}

/**
 * Minimal HTML-escaping for names interpolated into chat card content.
 * @param {string} text
 * @returns {string}
 */
function escapeHTML(text) {
  return String(text ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[c]);
}

/* -------------------------------------------- */
/*  Chat Card                                    */
/* -------------------------------------------- */

/**
 * Post a "you can react" chat card to the actor's owner(s) and the GM.
 * @param {object} params
 * @param {CrucibleActor} params.actor
 * @param {Token} params.reactorToken
 * @param {CrucibleAction} params.action
 * @param {Token} params.targetToken
 * @param {string} params.triggerType
 */
async function postReactionPrompt({actor, reactorToken, action, targetToken, triggerType}) {
  const whisper = getWhisperRecipients(actor);
  if (!whisper.length) return null;

  const triggerLabel = TRIGGER_TYPES.get(triggerType)?.label ?? triggerType;
  // Reuses Crucible's own "action line-item" / "action-header" markup and classes (see
  // templates/dice/partials/action-use-header.hbs) so the prompt sits visually alongside the rest of the
  // combat log instead of looking like a bolted-on widget. The outer chat-message <li> already gets the
  // "crucible" class from CrucibleChatMessage's own render hook, which is what the system's chat.less
  // rules key off of - nothing extra is needed here to inherit that styling.
  const content = `
    <div class="crucible-reaction-prompt" data-action-id="${action.id}"
         data-reactor-uuid="${actor.uuid}" data-target-uuid="${targetToken.actor.uuid}">
      <section class="action line-item">
        <header class="action-header">
          <div class="title">
            <h4>${escapeHTML(action.name)}</h4>
          </div>
        </header>
        <p class="reaction-flavor">
          <strong>${escapeHTML(actor.name)}</strong> could use <strong>${escapeHTML(action.name)}</strong>
          because ${triggerLabel} (<strong>${escapeHTML(targetToken.actor.name)}</strong>).
        </p>
        <div class="reaction-buttons">
          <button type="button" class="reaction-use frame-brown">
            <i class="fa-solid fa-bolt"></i> Use ${escapeHTML(action.name)}
          </button>
          <button type="button" class="reaction-dismiss frame-brown">
            <i class="fa-solid fa-xmark"></i> Not now
          </button>
        </div>
      </section>
    </div>`.trim();

  return ChatMessage.create({
    content,
    whisper,
    speaker: {alias: "Reaction Available"},
    flags: {
      [FLAG_SCOPE]: {
        reactorUuid: actor.uuid,
        reactorTokenId: reactorToken.id,
        actionId: action.id,
        targetUuid: targetToken.actor.uuid,
        targetTokenId: targetToken.id,
        triggerType
      }
    }
  });
}

/**
 * Determine who should see a given actor's reaction prompts: their active owning player(s), or the GM
 * if nobody is actively controlling that actor.
 * @param {CrucibleActor} actor
 * @returns {string[]} An array of User ids suitable for ChatMessage#whisper.
 */
function getWhisperRecipients(actor) {
  const owners = game.users.filter(u => u.active && !u.isGM && actor.testUserPermission(u, "OWNER"));
  const gms = game.users.filter(u => u.active && u.isGM);
  const recipients = new Set([...owners, ...gms].map(u => u.id));
  return [...recipients];
}

/* -------------------------------------------- */
/*  Chat Card Interactivity                      */
/* -------------------------------------------- */

Hooks.on("renderChatMessageHTML", (message, html) => {
  const root = html instanceof HTMLElement ? html : html[0];
  const prompt = root?.querySelector?.(".crucible-reaction-prompt");
  if (!prompt) return;

  // CrucibleChatMessage#onRenderHTML only adds its "crucible"/"themed theme-dark" card classes when
  // message.flags.crucible is non-empty. Our prompt intentionally stores its own state under a separate
  // flag scope (crucible-reaction-prompts) rather than faking flags.crucible.action - faking that could
  // trip auto-confirm, VFX replay, or the Confirm/Reverse context menu, none of which make sense for a
  // prompt that isn't itself a used action. So apply the same two classes by hand instead.
  root.classList.add("crucible");
  root.querySelector(".message-content")?.classList.add("themed", "theme-dark");

  prompt.querySelector(".reaction-use")?.addEventListener("click", () => onUseReaction(message, prompt));
  prompt.querySelector(".reaction-dismiss")?.addEventListener("click", () => onDismissReaction(message, prompt));

  if (message.getFlag(FLAG_SCOPE, "resolved")) lockPromptUI(prompt, message.getFlag(FLAG_SCOPE, "resolution"));
});

/**
 * Handle a click of the "Use" button on a reaction prompt.
 * @param {ChatMessage} message
 * @param {HTMLElement} promptEl
 */
async function onUseReaction(message, promptEl) {
  if (message.getFlag(FLAG_SCOPE, "resolved")) return;

  const {reactorUuid, reactorTokenId, actionId, targetUuid, targetTokenId} = message.flags[FLAG_SCOPE] ?? {};
  const actor = fromUuidSync(reactorUuid);
  if (!actor) return ui.notifications.warn("That actor could no longer be found.");

  const isOwner = actor.testUserPermission(game.user, "OWNER");
  if (!isOwner && !game.user.isGM) {
    return ui.notifications.warn("You don't have permission to act for this character.");
  }

  if (!actor.actions?.[actionId]) return ui.notifications.warn(`${actor.name} no longer has that action available.`);

  // Control the SPECIFIC token that triggered this prompt before acting, not just whichever token the actor
  // happens to resolve to internally. This matters most for a linked actor with more than one token placed on
  // the scene (e.g. two placements of the same NPC) - actor.useAction() has no token context of its own to go
  // on, so without an explicit control() here it's free to resolve to whichever token comes first internally,
  // which may be a stray/duplicate token far from this fight entirely. Opening the sheet directly from the
  // correct token doesn't have this ambiguity, which is why that path already worked correctly.
  const reactorToken = reactorTokenId && canvas.tokens?.get(reactorTokenId);
  if (reactorToken && !reactorToken.controlled) reactorToken.control({releaseOthers: true});

  // Target the SPECIFIC token that triggered this prompt, not just "the first active token for this actor" -
  // if more than one token happens to share an actor setup (e.g. two similarly-configured unlinked NPCs both
  // named "tester"), re-deriving the token from the actor at click-time is ambiguous and can silently grab the
  // wrong one, measuring range against a token that was never actually involved in this reaction. canvas.tokens
  // is keyed by Token id, which is unique regardless of how many tokens share similar actor data - falls back to
  // the old actor-based lookup only if that exact token document is gone (e.g. deleted mid-combat).
  const targetToken = (targetTokenId && canvas.tokens?.get(targetTokenId))
    ?? fromUuidSync(targetUuid)?.getActiveTokens()[0];
  if (targetToken) targetToken.setTarget(true, {releaseOthers: true, user: game.user});

  // actor.useAction() is the same public entry point the character sheet itself calls (see
  // base-actor-sheet.mjs) - it resolves the correct token and calls the real CrucibleAction#use()
  // workflow, so the resulting chat message is a completely normal, revertible Crucible action card
  // (Confirm/Reverse show up automatically via right-click, driven by the message's own flags).
  let result;
  try {
    result = await actor.useAction(actionId);
  } catch (err) {
    console.error(`${MODULE_ID} |`, err);
    return ui.notifications.warn(err.message ?? `${actor.name} could not use ${actionId} right now.`);
  }
  await resolveMessage(message, promptEl, result ? "used" : "cancelled");
}

/**
 * Handle a click of the "Not now" button on a reaction prompt.
 * @param {ChatMessage} message
 * @param {HTMLElement} promptEl
 */
async function onDismissReaction(message, promptEl) {
  if (message.getFlag(FLAG_SCOPE, "resolved")) return;
  await resolveMessage(message, promptEl, "dismissed");
}

/**
 * Persist that a prompt has been resolved (so other viewers of the same whispered message see it lock too)
 * and update this client's UI immediately.
 * @param {ChatMessage} message
 * @param {HTMLElement} promptEl
 * @param {"used"|"dismissed"|"cancelled"} resolution
 */
async function resolveMessage(message, promptEl, resolution) {
  if (resolution === "cancelled") return; // The user opened the dialog and closed it - leave the prompt live.
  lockPromptUI(promptEl, resolution);
  const canUpdate = game.user.isGM || message.isAuthor;
  if (canUpdate) {
    await message.setFlag(FLAG_SCOPE, "resolved", true);
    await message.setFlag(FLAG_SCOPE, "resolution", resolution);
  }
}

/**
 * Replace the buttons with a static status line once a prompt has been handled.
 * @param {HTMLElement} promptEl
 * @param {string} resolution
 */
function lockPromptUI(promptEl, resolution) {
  const buttons = promptEl.querySelector(".reaction-buttons");
  if (!buttons) return;
  const label = resolution === "used" ? "Used" : "Declined";
  buttons.outerHTML = `<p class="reaction-resolved">${label}</p>`;
}
