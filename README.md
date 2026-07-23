# Crucible Reaction Prompts

A small Foundry VTT **module** (installed alongside the Crucible system, not
edited into it) that proactively tells players and the GM when a character
could use a reaction — right now it watches for:

- **Reactive Strike** — prompted the moment an enemy leaves your engagement.
- **Counterspell** — prompted the moment an enemy in the fight casts a spell.
- **Counter-Evade / Counter-Riposte / Counter-Strike / Defensive Roll /
  Repercussive Block** — talent-granted retaliation actions, prompted the
  moment you defend against a melee attack with the specific result
  (Dodge/Parry/Block) each one requires.

When either happens, everyone who owns the reacting character (plus the GM)
gets a whispered chat card:

> **Kessa the Vanguard** could use **Reactive Strike** because an enemy
> leaves engagement (**Goblin Skirmisher**).
> `[Use Reactive Strike]` `[Not now]`

Clicking **Use** targets the right token automatically and calls the action's
normal `use()` workflow — so the game's own targeting, cost, and eligibility
rules still get the final say. This module only decides *who to nudge*, not
*whether the rule allows it*.

## Install

1. Copy this folder into your Foundry `Data/modules/` directory (or zip it
   and use "Install Module" → "Manage Module" with a local manifest path).
2. Enable **Crucible Reaction Prompts** in your world's Manage Modules list.
3. It's inert outside of combat and does nothing on any system other than
   Crucible.

## How it works

- **Reactive Strike trigger**: Crucible tokens already track a live
  `token.engagement.enemies` set (used for its own flanking rules). This
  module snapshots that set for every token and, on each Foundry
  `refreshToken` hook, diffs it against the previous snapshot to notice when
  an enemy disappears from it — the moment described by Reactive Strike's own
  rules text ("when an enemy leaves your engagement").
- **Counterspell trigger**: on `createChatMessage`, it reconstructs the
  posted action via `CrucibleAction.fromChatMessage()` and checks whether it
  was a spell (the same `composed`/`iconicSpell` tag check the built-in
  Counterspell target validation already uses). If so, every hostile
  combatant gets evaluated.
- **Melee defense trigger**: on the same `createChatMessage` hook, if the
  posted action is tagged `melee`, every actor it actually targeted gets
  evaluated. Crucible's own `counterEvade`/`counterRiposte`/`counterStrike`/
  `defensiveRoll`/`repercussiveBlock` action hooks each already gate
  themselves on "the last chat action was a melee attack you defended
  against with [Dodge/Parry/Block]" — this module doesn't re-implement
  which result each one needs; it just offers the actor a prompt for every
  candidate action it knows about and lets each action's own `_canUse()`
  decide whether *this* result actually qualifies it.
- Only the active GM's client evaluates triggers and creates prompt
  messages, so multiple connected clients don't post duplicates.
- Before posting a prompt, two checks run:
  - **Affordability + tag gates** — `action._canUse()`, the same pre-check
    the system runs right before it would open the action's configuration
    dialog. Confirms the actor still has enough Action Points/Focus/whatever
    the action costs, and passes the "reaction" tag's own gates (in combat,
    not currently their turn, not Unaware, has the required ability score).
    This stays correct even when a talent changes a cost dynamically (e.g. a
    talent that trades an Action for Focus on that action specifically).
  - **Range** — `crucible.api.canvas.grid.getLinearRangeCost()` against the
    action's already-prepared `range.minimum`/`range.maximum` (which already
    accounts for equipped weapon reach, or a spell gesture's range for
    Counterspell). An actor across the battlefield never gets prompted for
    an ability they can't actually reach the target with.
  - Anything neither check can see yet (e.g. a Champion's Dominance bypass,
    or Counterspell's "must still be the last action" requirement) is left
    to the real `action.use()` call to enforce — a prompt that turns out to
    be stale just shows the system's normal warning instead of silently
    doing something wrong.

## Extending it

The module exposes a small API for adding more reactions without touching
its source:

```js
const api = game.modules.get("crucible-reaction-prompts").api;

// A talent grants a new action, "guardiansParry", that should also be
// offered whenever an enemy leaves engagement:
api.registerActionTrigger("guardiansParry", "engagementLeft");

// Define a brand new trigger type (you're responsible for wiring the Hook
// that detects it and calling evaluateActorReactions — see reaction-prompts.mjs
// for the pattern used by the two built-in triggers):
api.registerTriggerType("allyDropped", {label: "an ally drops to 0 Health"});
```

## Known limitations / things to watch if Crucible updates

- The engagement-leaving detector reads `token.engagement.enemies`, which is
  a public field on Crucible's `Token` subclass but is documented as part of
  its *internal* flanking computation, not a stable public API. If a future
  Crucible release changes that shape, `checkEngagementLeft()` is the only
  place that needs updating.
- Only actors currently in the combat tracker are considered for the
  Counterspell trigger (mirrors the "reaction" tag's own `inCombat`
  requirement).
- Prompts are whispered to *active* owners/GMs only; if nobody eligible is
  currently connected, no prompt is created (nothing to click).
