# Change Log - @excitedjs/dreamux

This log was last generated on Thu, 04 Jun 2026 17:12:55 GMT and should not be manually modified.

## 0.5.0
Thu, 04 Jun 2026 17:12:55 GMT

### Minor changes

- Inject a one-shot <group_bots> context of a group's trusted bots on the first delivered message after /introduce (commit-after-notify, generation-safe clear); add a model-facing list_chat_bots MCP tool (backed by a read-only mcp.list_chat_bots admin method) returning a chat's known + trusted bots; and change the inbound reaction lifecycle to add-then-cancel so the message never shows a zero-reaction window during the received -> in-progress transition.

## 0.4.0
Thu, 04 Jun 2026 15:47:28 GMT

### Minor changes

- Add the Feishu event-registry seam (FeishuBot.start now takes a route object with onMessage + optional onBotMemberAdded) and the group /introduce hard contract: /introduce triggers only when the sender is allowlisted, with no @-mention of the bot required. A new chat-bots.json store separates passive bot awareness from introduced trust.

## 0.3.3
Thu, 04 Jun 2026 14:09:37 GMT

### Patches

- Fix Feishu inbound reaction emoji type values.

## 0.3.2
Thu, 04 Jun 2026 13:15:17 GMT

### Patches

- Submit accepted Feishu inbound with non-blocking turn/start delivery and three-state reactions.

## 0.3.1
Thu, 04 Jun 2026 07:44:14 GMT

### Patches

- Fix managed service startup when Node is provided by nvm.

## 0.3.0
Thu, 04 Jun 2026 05:00:52 GMT

### Minor changes

- 调整 onboard 与 dispatcher runtime，使其继承本机 Codex 状态，改用 JSON 配置并新增 uninstall 指令。

## 0.2.0
Wed, 03 Jun 2026 07:57:13 GMT

### Minor changes

- 调整 onboard 与 dispatcher runtime，使其继承本机 Codex 状态，改用 JSON 配置并新增 uninstall 指令。

## 0.1.4
Wed, 03 Jun 2026 04:29:43 GMT

### Patches

- Fix onboard Codex marketplace installation from the public dreamux repository.

## 0.1.3
Tue, 02 Jun 2026 18:55:21 GMT

### Patches

- Implement dreamux onboard: first-run wizard, dispatcher-private Codex home setup, plugin installation, service registration, and transparent file ledger output.
- Add the issue #18 dreamux serve foundation: single global bin command tree, dispatcher-private Codex homes, and serve-time Codex home checks.

## 0.1.2
Sun, 31 May 2026 07:02:52 GMT

### Patches

- Thread Feishu replies and drop bot-loop inbound messages

## 0.1.1
Sat, 30 May 2026 17:49:32 GMT

### Patches

- init

