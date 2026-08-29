/**
 * This session's MCP capability: the object Core dispatches an admitted tool
 * call to.
 *
 * It is composed beside the session rather than implemented on it, because a
 * Channel with no tools should be able to omit tools entirely rather than
 * implement empty members. Core validated the call against the frozen catalog
 * before it arrived; what happens here is parse, run, and answer.
 *
 * The answer is a value in both directions. A tool that refuses — an argument
 * this Channel cannot use, a chat that may not be bound, a route that belongs
 * to another Team — states the refusal, and the model reads the Channel's own
 * sentence rather than a generic failure it can only retry. Core is not asked
 * to curate that: it never sees a Feishu error type, because none crosses.
 *
 * An exception still means nobody decided anything. It leaves here unchanged,
 * is logged on both sides, and reaches the model as Core's fixed sanitized
 * error.
 */
import type {
  ChannelMcpCall,
  ChannelMcpCallContext,
  ChannelMcpToolOutcome,
  ChannelSessionMcpCapability,
  DreamuxLogger,
} from '@excitedjs/dreamux-types';
import { settleJsonInvoke } from '@excitedjs/dreamux-utils';

import type { FeishuChannelSession } from './feishu-channel.js';
import { findFeishuTool } from './tools/registry.js';

export function createFeishuSessionMcp(
  session: FeishuChannelSession,
  log: DreamuxLogger,
): ChannelSessionMcpCapability {
  return {
    async invoke(
      call: ChannelMcpCall,
      context: ChannelMcpCallContext,
    ): Promise<ChannelMcpToolOutcome> {
      const scope = {
        dispatcher_id: context.dispatcher_id,
        channel_id: context.channel_id,
        caller: context.caller.kind,
        tool: call.name,
      };
      const def = findFeishuTool(call.name, context.caller.kind);
      // Unreachable through Core, which admits only names this caller's own
      // frozen catalog advertises. A direct embedder is told the same thing
      // rather than getting a silent no-op.
      if (def === undefined) {
        return {
          ok: false,
          message:
            'The Feishu channel does not offer a ' +
            `${JSON.stringify(call.name)} tool to this caller.`,
        };
      }
      try {
        const outcome = await settleJsonInvoke(async () =>
          def.handle(
            {
              caller: context.caller,
              session: session.toolSession(context.caller),
            },
            def.parse(call.arguments),
          ),
        );
        if (!outcome.ok) {
          log.info({ ...scope, reason: outcome.message },
            'feishu MCP tool refused a call');
        }
        return outcome;
      } catch (err) {
        log.error({ ...scope, err: errInfo(err) }, 'feishu MCP tool failed');
        throw err;
      }
    },
  };
}

function errInfo(err: unknown): { message: string; stack?: string } {
  if (err instanceof Error) {
    return err.stack !== undefined
      ? { message: err.message, stack: err.stack }
      : { message: err.message };
  }
  return { message: String(err) };
}
