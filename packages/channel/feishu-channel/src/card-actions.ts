/**
 * The `dreamux_action` key space for every card this Channel sends — the one
 * file that names every reserved key, with no dependency on the card modules
 * that draw them.
 *
 * `DREAMUX_ACTION_KEY` names where a card's callback payload carries its
 * action; every button this package draws, and every extension's, stamps its
 * action name under this one key so `handleCardAction` can read it back with
 * a single lookup. The built-in table below is the set of action keys this
 * Channel answers on its own — `register()`'s conflict check and
 * `handleCardAction`'s dispatch both resolve a key against it, instead of
 * each re-listing the same keys its own way. `cards/pairing.ts` and
 * `cards/ask-user.ts` import their action names from here (not the other way
 * around) so building this table never has to run before the names it needs
 * exist.
 */

/**
 * Where a card action's kind lives in every callback payload this Channel
 * sends.
 */
export const DREAMUX_ACTION_KEY = 'dreamux_action';

export const DREAMUX_PAIRING_CARD_ACTION = 'approve_pairing';
export const DREAMUX_PAIRING_TOKEN_KEY = 'dreamux_pairing_token';

export const DREAMUX_ASK_PICK_ACTION = 'ask_user_pick';
export const DREAMUX_ASK_OTHER_ACTION = 'ask_user_other';
export const DREAMUX_ASK_SUBMIT_ACTION = 'ask_user_submit';
export const DREAMUX_ASK_CANCEL_ACTION = 'ask_user_cancel';

export type FeishuBuiltinCardAction = 'pairing' | 'ask_user';

const BUILTIN_CARD_ACTIONS = new Map<string, FeishuBuiltinCardAction>([
  [DREAMUX_PAIRING_CARD_ACTION, 'pairing'],
  [DREAMUX_ASK_PICK_ACTION, 'ask_user'],
  [DREAMUX_ASK_OTHER_ACTION, 'ask_user'],
  [DREAMUX_ASK_SUBMIT_ACTION, 'ask_user'],
  [DREAMUX_ASK_CANCEL_ACTION, 'ask_user'],
]);

/**
 * Which built-in owns `key`, if any — `undefined` for an extension's own key
 * or an unclaimed one.
 */
export function builtinCardAction(
  key: string,
): FeishuBuiltinCardAction | undefined {
  return BUILTIN_CARD_ACTIONS.get(key);
}
