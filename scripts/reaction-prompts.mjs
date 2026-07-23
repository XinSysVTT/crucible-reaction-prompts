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
  ["repercussiveBlock", "meleeDefense"] // Requires a Block, and the attack not yet confirmed
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
 * Trigger type definitions. Each trigger type owns the detection logic that decides *when* to look for
 * reactors, and hands off to evaluateActorReactions() to do the actual per-actor eligibility check + prompt.
 * A custom trigger type just needs to eventually call evaluateActorReactions(reactorToken, triggerType, targetToken).
 * @type {Map<string, {label: string}>}
 */
const TRIGGER_TYPES = new Map([
  ["engagementLeft", {label: "an enemy leaves engagement"}],
  ["spellCast", {label: "an enemy casts a spell"}],
  ["meleeDefense", {label: "you just defended against a melee attack"}]
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
  mod.api = {registerActionTrigger, registerTriggerType};
});

Hooks.once("ready", () => {
  if (game.system.id !== "crucible") {
    console.warn(`${MODULE_ID} | This module is built for the Crucible system and has been disabled.`);
  }
});

/* -------------------------------------------- */
/*  Trigger: Engagement Left (Reactive Strike)   */
/* -------------------------------------------- */

/** Last known set of engaged-enemy Token ids, per reactor Token id, so departures can be diffed out. */
const lastEngagement = new Map();

Hooks.on("refreshToken", token => {
  if (game.system.id !== "crucible") return;
  if (!isAuthoritativeClient()) return;
  if (!game.combat?.started) return;
  if (!token.actor || (token.actor.type === "group")) return;
  checkEngagementLeft(token);
});

function checkEngagementLeft(token) {
  const currentEnemies = token.engagement?.enemies;
  if (!currentEnemies) return;
  const currentIds = new Set([...currentEnemies].map(t => t.id));
  const previousIds = lastEngagement.get(token.id);
  lastEngagement.set(token.id, currentIds);
  if (!previousIds) return; // No baseline yet for this token - nothing to diff.

  for (const enemyId of previousIds) {
    if (currentIds.has(enemyId)) continue; // Still engaged.
    const enemyToken = canvas.tokens?.get(enemyId);
    if (!enemyToken?.actor) continue;
    evaluateActorReactions(token, "engagementLeft", enemyToken);
  }
}

// Tokens are deleted or leave combat: drop their stale baselines so memory doesn't grow unbounded.
Hooks.on("deleteToken", tokenDoc => lastEngagement.delete(tokenDoc.id));
Hooks.on("deleteCombat", () => lastEngagement.clear());

/* -------------------------------------------- */
/*  Triggers: Spell Cast (Counterspell) &                */
/*            Melee Defense (Counter-Riposte/Strike/etc) */
/* -------------------------------------------- */

Hooks.on("createChatMessage", message => {
  if (game.system.id !== "crucible") return;
  if (!isAuthoritativeClient()) return;
  if (!game.combat?.started) return;

  const flags = message.flags?.crucible;
  if (!flags?.action) return;

  let action;
  try {
    action = crucible.api.models.CrucibleAction.fromChatMessage(message);
  } catch (err) {
    return; // Not a reconstructable action message.
  }
  if (!action) return;

  const actingToken = fromUuidSync(flags.actor)?.token?.object
    ?? canvas.tokens?.placeables.find(t => t.actor?.uuid === flags.actor);
  if (!actingToken) return;

  const wasSpell = action.tags?.has("composed") || action.tags?.has("iconicSpell");
  if (wasSpell) checkSpellCast(action, actingToken);

  const wasMeleeAttack = action.tags?.has("melee");
  if (wasMeleeAttack) checkMeleeDefense(action, actingToken);
});

/**
 * Every hostile combatant is a plausible Counterspell reactor (their own action's canUse ultimately
 * confirms this really was still the last action).
 * @param {CrucibleAction} action
 * @param {Token} casterToken
 */
function checkSpellCast(action, casterToken) {
  for (const combatant of (game.combat?.combatants ?? [])) {
    const reactorToken = combatant.token?.object;
    if (!reactorToken || (reactorToken === casterToken) || !reactorToken.actor) continue;
    if (!areEnemies(reactorToken, casterToken)) continue;
    evaluateActorReactions(reactorToken, "spellCast", casterToken);
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

/* -------------------------------------------- */
/*  Shared Eligibility + Prompting               */
/* -------------------------------------------- */

/** Debounce identical prompts that could otherwise fire twice from the same underlying event. */
const recentPrompts = new Map(); // key -> timestamp
const RECENT_PROMPT_WINDOW_MS = 5000;

/**
 * Check every action the reactor has which is registered against this trigger type, and post a prompt
 * for each one that looks usable right now.
 * @param {Token} reactorToken   The token who might get to react.
 * @param {string} triggerType   The trigger type that just fired (see TRIGGER_TYPES).
 * @param {Token} targetToken    The token whose action caused the trigger (the mover, the caster, etc.).
 */
async function evaluateActorReactions(reactorToken, triggerType, targetToken) {
  const actor = reactorToken.actor;
  if (!actor) return;

  for (const [actionId, registeredTrigger] of ACTION_TRIGGERS) {
    if (registeredTrigger !== triggerType) continue;

    const action = actor.actions?.[actionId];
    if (!action) continue; // This actor doesn't have that action at all.

    const key = `${reactorToken.id}:${targetToken.id}:${actionId}`;
    const now = Date.now();
    const last = recentPrompts.get(key);
    if (last && ((now - last) < RECENT_PROMPT_WINDOW_MS)) continue;
    recentPrompts.set(key, now);

    if (!actorLooksEligible(action)) continue;
    if (!isTargetInRange(action, reactorToken, targetToken)) continue;
    await postReactionPrompt({actor, reactorToken, action, targetToken, triggerType});
  }
}

/**
 * A best-effort, side-effect-free check for whether an Action is currently worth prompting about:
 * does the actor still have enough Action Points / Focus / whatever else the action costs, AND does it
 * pass the "reaction" tag's own gates (in combat, not currently their turn, not Unaware, has the
 * required ability score)? This calls the same _canUse() pre-check the system itself runs right before
 * it would open the action's configuration dialog, so it stays correct even if a talent changes an
 * action's cost dynamically (e.g. a talent that trades Action for Focus).
 *
 * Target-specific nuances that _canUse() can't see yet (e.g. a Champion's Dominance bypass, or
 * Counterspell's "must still be the last action" rule) are left to the real CrucibleAction#use()
 * workflow to enforce when the button is actually clicked - a prompt that turns out to be stale just
 * shows the system's normal warning instead of silently doing something wrong.
 * @param {object} action  A prepared CrucibleAction instance (actor.actions[id]).
 * @returns {boolean}
 */
function actorLooksEligible(action) {
  try {
    action._canUse();
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * Does the reactor currently have the target within this action's usable range?
 * Reuses the same range math (crucible.api.canvas.grid.getLinearRangeCost against the action's prepared
 * range.minimum/range.maximum, which already accounts for equipped weapon reach) that the system's own
 * single-target acquisition performs when the action is actually used - so this stays in sync with
 * whatever the action's real range is, including reach weapons, without duplicating that logic.
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
    if (minimum && (range < minimum)) return false;
    if (maximum && (range > maximum)) return false;
    return true;
  } catch (err) {
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
 * Is this the one client responsible for detecting triggers and creating prompt chat messages?
 * Prevents every connected client from independently detecting the same event and posting duplicates.
 * @returns {boolean}
 */
function isAuthoritativeClient() {
  return game.users.activeGM?.isSelf ?? false;
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
  if (!whisper.length) return;

  const triggerLabel = TRIGGER_TYPES.get(triggerType)?.label ?? triggerType;
  const content = `
    <div class="crucible-reaction-prompt" data-action-id="${action.id}"
         data-reactor-uuid="${actor.uuid}" data-target-uuid="${targetToken.actor.uuid}">
      <p class="reaction-flavor">
        <strong>${actor.name}</strong> could use <strong>${action.name}</strong>
        because ${triggerLabel} (<strong>${targetToken.actor.name}</strong>).
      </p>
      <div class="reaction-buttons">
        <button type="button" class="reaction-use">
          <i class="fa-solid fa-bolt"></i> Use ${action.name}
        </button>
        <button type="button" class="reaction-dismiss">
          <i class="fa-solid fa-xmark"></i> Not now
        </button>
      </div>
    </div>`.trim();

  await ChatMessage.create({
    content,
    whisper,
    speaker: {alias: "Reaction Available"},
    flags: {
      [FLAG_SCOPE]: {
        reactorUuid: actor.uuid,
        actionId: action.id,
        targetUuid: targetToken.actor.uuid,
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

  const {reactorUuid, actionId, targetUuid} = message.flags[FLAG_SCOPE] ?? {};
  const actor = fromUuidSync(reactorUuid);
  if (!actor) return ui.notifications.warn("That actor could no longer be found.");

  const isOwner = actor.testUserPermission(game.user, "OWNER");
  if (!isOwner && !game.user.isGM) {
    return ui.notifications.warn("You don't have permission to act for this character.");
  }

  const action = actor.actions?.[actionId];
  if (!action) return ui.notifications.warn(`${actor.name} no longer has that action available.`);

  // Target the token whose event triggered this prompt, so the action's own targeting logic just works.
  const targetActor = fromUuidSync(targetUuid);
  const targetToken = targetActor?.getActiveTokens()[0];
  if (targetToken) targetToken.setTarget(true, {releaseOthers: true, user: game.user});

  const result = await action.use({dialog: true});
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
