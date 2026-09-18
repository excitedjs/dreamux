/**
 * The one reader for a Channel-facing submission payload.
 *
 * `dispatcher.submit` and the Team-facing `team.submit` are the two Commands a
 * Channel-facing caller — a Channel adapter or `admin.sock` driving the same
 * surface — invokes, and both read the same four fields with the same rules.
 * Those rules live here once: the shared input-schema properties, the parse
 * into {@link DispatcherSubmitCommand}, and the projection to the generic
 * {@link TeammateSubmitInput} every Core producer states.
 *
 * Core reads none of the caller's envelope: the provenance name is fixed here
 * instead of taken from the payload — a Channel cannot name itself into another
 * producer's dedupe window — and the attributes are passed through untouched
 * for the model.
 */
import type {
  DispatcherSubmitCommand,
  JsonSchema,
} from '@excitedjs/dreamux-types';

import { ValidationError } from '../command/errors.js';
import {
  mustNonEmptyString,
  optionalString,
  type CommandPayload,
} from '../command/payload.js';
import {
  NON_EMPTY_STRING,
  OBJECT,
  STRING,
  boundedString,
} from '../command/schema.js';
import { isSafeTagName, type TeammateSubmitInput } from './teammate-service/submission.js';
import { CHANNEL_SOURCE } from './submission-sources.js';

/**
 * The maximum length of a caller-chosen `source_id`. Core deduplicates with it
 * scoped to the target entity, so it never has to be globally unique — a bound
 * this generous still admits any UUID, message id, or provider-scoped key a
 * Channel actually mints.
 */
const MAX_SOURCE_ID_LENGTH = 512;

/**
 * The shared input-schema properties of both submit Commands.
 *
 * `attrs` is declared as `OBJECT`: attribute names are open by contract and
 * this validator's `additionalProperties` is boolean-only, so no schema here
 * can state "open names, string values" — let alone start-tag safety. The parse
 * owns the precise contract, the same split `skill_sources` already uses.
 */
export const CHANNEL_SUBMISSION_PROPERTIES: Readonly<Record<string, JsonSchema>> = {
  attrs: OBJECT,
  text: NON_EMPTY_STRING,
  reminder: STRING,
  source_id: boundedString(MAX_SOURCE_ID_LENGTH),
};

/** Parse one validated payload into the shared submit Command fields. */
export function parseChannelSubmission(
  payload: CommandPayload,
): DispatcherSubmitCommand {
  const attrs = submissionAttrs(payload);
  const reminder = optionalString(payload, 'reminder');
  const sourceId = optionalString(payload, 'source_id');
  return {
    ...(attrs !== null ? { attrs } : {}),
    text: mustNonEmptyString(payload, 'text'),
    ...(reminder !== null ? { reminder } : {}),
    ...(sourceId !== null ? { source_id: sourceId } : {}),
  };
}

/**
 * Project one parsed submit Command onto the generic submission input.
 *
 * Every one of these Commands is a Channel-facing surface, whether it arrived
 * over a Channel adapter or `admin.sock`, so the turn reaches the model under
 * one provenance name. An empty `source_id` is omitted: dedupe is disabled.
 */
export function channelSubmitInput(
  command: DispatcherSubmitCommand,
): TeammateSubmitInput {
  return {
    source: CHANNEL_SOURCE,
    ...(command.attrs !== undefined ? { attrs: command.attrs } : {}),
    text: command.text,
    ...(command.reminder !== undefined ? { reminder: command.reminder } : {}),
    ...(command.source_id !== undefined && command.source_id !== ''
      ? { sourceId: command.source_id }
      : {}),
  };
}

/**
 * Read the optional display attributes.
 *
 * Attribute names are open by contract, so no declared schema can check them.
 * The rule that decides whether a name may be written into a start tag belongs
 * to the renderer that writes it and is reused here, at the caller boundary, so
 * a bad name fails as this caller's mistake before anything is resolved,
 * reserved, or started — instead of reaching the renderer, where the same name
 * is an internal defect and would surface as one. An empty object is exactly an
 * omitted one.
 *
 * The record is rebuilt with `Object.fromEntries` rather than by assignment: a
 * canonical payload carries an own `__proto__` key as ordinary data, and
 * assigning that name onto a plain object would reach the inherited setter and
 * silently drop the attribute.
 */
function submissionAttrs(
  params: CommandPayload,
): Readonly<Record<string, string>> | null {
  const value = params['attrs'];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError("param 'attrs' must be an object");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  for (const [name, entry] of entries) {
    if (!isSafeTagName(name)) {
      throw new ValidationError(
        `param 'attrs' name ${JSON.stringify(name)} is not a safe attribute name`,
      );
    }
    if (typeof entry !== 'string') {
      throw new ValidationError(`param 'attrs.${name}' must be a string`);
    }
  }
  return entries.length > 0
    ? (Object.fromEntries(entries) as Record<string, string>)
    : null;
}
