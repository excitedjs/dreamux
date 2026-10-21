# Dreamux documentation

Dreamux runs persistent AI teams on your machine and connects them to Feishu.
Start with one bot and one runtime, then add teams, workspaces, and automation
as your work grows.

## Start here

1. [Install and connect your bot](getting-started.md).
2. [Send a task and work with a Team](usage.md).
3. [Adjust configuration](configuration.md) when you need more runtimes or a
   different workspace policy.

## Guides

| Guide | Covers |
| --- | --- |
| [Getting started](getting-started.md) | Prerequisites, Feishu setup, onboarding, pairing, and the first task |
| [Everyday usage](usage.md) | Teams, collaboration spaces, follow-ups, slash commands, schedules, and workflows |
| [Configuration](configuration.md) | Complete starter config, runtime options, workspace policy, plugins, and access ownership |
| [Operations and troubleshooting](operations.md) | CLI reference, service lifecycle, logs, upgrades, recovery, and common failures |
| [Architecture and extensions](architecture.md) | Package boundaries, runtime and channel providers, MCP, and plugins |
| [Development](development.md) | Source installation, verification gates, contributions, and release branches |

These pages describe the source on the branch you are browsing. For an installed
release, check `dreamux --version` and `dreamux changelog`; prerelease and `next`
documentation can include capabilities newer than your installation.

Examples use fictional IDs and paths. Replace placeholders locally; keep
credentials and real conversation identifiers out of public issues and commits.

[Back to Dreamux](../README.md)
