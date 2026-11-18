# Feature comparison: Crew and eight AI-coworker products

This page compares what Crew supports with eight other products, across 40
features. Use it to pick candidate features for Crew. It records what each
product does. It does not rank the products or recommend a feature.

The comparison is a snapshot taken on 2026-11-12. The Crew column was read
again on 2026-11-13.

## Products

| Column | Product | Kind | Read at |
| --- | --- | --- | --- |
| Crew | This repository | Open source (MIT), headless service | `main` at `8fb8bf0` |
| OpenBot | [CopilotKit/OpenBot](https://github.com/CopilotKit/OpenBot) | Open source (MIT), self-hosted workspace | `0fe182c` (2026-11-12) |
| Grok Bot | xAI Grok Bot | Hosted, beta since 2026-08-11 | xAI docs and press, read 2026-11-12 |
| Muse | Meta Muse | Hosted, announced 2026-09-08 | Meta posts and press, read 2026-11-12 |
| OpenMuse | [CopilotKit/openmuse](https://github.com/CopilotKit/openmuse) | Open source (MIT), alpha personal agent | `a4944f4` (2026-10-26) |
| Dots | OpenAI Dots | Hosted, announced 2026-09-29 | OpenAI system card and press, read 2026-11-12 |
| OpenDots | [CopilotKit/OpenDots](https://github.com/CopilotKit/OpenDots) | Open source (MIT), alpha single-owner template | `46eaf96` (2026-11-10) |
| Duet | Anthropic Claude Duet | Hosted, research preview since 2026-10-21 | Anthropic pages and press, read 2026-11-12 |
| OpenDuet | [CopilotKit/OpenDuet](https://github.com/CopilotKit/OpenDuet) | Open source (MIT), OpenBot with an added layer | `edb9126` (2026-11-10) |

How the open-source products relate to each other and to the hosted ones:

- OpenDuet contains an older copy of OpenBot (version 0.2.0, where OpenBot is
  now 1.0.1) in its `openbot/` directory and adds a morning brief, mail triage,
  tasks, and pages. Most OpenDuet answers below come from that copy. The copy
  lacks later OpenBot features such as subagents.
- OpenMuse and OpenDots are separate codebases. OpenDots builds the computer
  service and the supervisor of OpenBot from OpenBot commit `b6932d3`, which its
  `compose.computers.yml` pins.
- OpenBot ships OpenDots, OpenDuet, and OpenMuse as interface skins, chosen in
  OpenBot's settings. The OpenDots and OpenDuet READMEs call those repositories
  community-maintained starters and point team deployments to OpenBot. The
  columns here describe each repository on its own, not its skin in OpenBot.
- OpenBot, OpenMuse, OpenDots, and OpenDuet all need CopilotKit Intelligence, a
  separately licensed service, for conversation threads.
- The OpenDuet README names Claude Duet as an example of its product category
  and states that OpenDuet is not affiliated with Anthropic. The OpenMuse and
  OpenDots repositories do not name a proprietary product. This page puts
  OpenMuse next to Muse, and OpenDots next to Dots, because of the names only.

## How to read the grid

| Cell | Meaning |
| --- | --- |
| Yes | The product has the feature. For Grok Bot, Muse, Dots, and Duet, this means that the cited sources describe the feature. |
| Part | The product has part of the feature. For Crew, the detail line says which part. For the other products, a note says which part, except in the cells listed below this table. |
| No | The source code or the documentation shows that the product lacks the feature. For Grok Bot, Muse, Dots, and Duet, this means that the cited sources do not describe the feature where they cover its area: a vendor page states the lack, or lists the product's options and the feature is not among them. |
| ? | The sources that were read do not say. |

Every "Part" cell of OpenBot, OpenMuse, OpenDots, and OpenDuet has a note. These
"Part" cells of the hosted products have no note: Grok Bot rows 17, 25, and 39; Muse rows 11, 12, 16, 23, 24, 25, 34, 38, and 39; Dots rows 8, 11, 12, 14,
16, 20, 22, 25, 28, 34, 35, 36, and 38; and Duet rows 8, 11, 15, 16, 25, 35, 36,
and 38. In those cells the sources show the feature with a limit that this page
does not record.

Grading rules:

- The Crew column covers the whole repository, including the Python
  documentation pilot. Row 8 is "Part" only because of the pilot.
- A hosted product gets "No" for self-hosting when its sources describe only a
  vendor cloud.
- A feature that only some paid plans include gets the grade it has on those
  plans, and the note names the plans.
- In rows 31 and 33, one surface of the row's kind is enough for "Yes", and the
  note names it.

How much to trust each column:

- **Crew, OpenBot, OpenMuse, OpenDots, OpenDuet.** Read from source code and
  repository documentation. Nothing was run.
- **Grok Bot.** Read from pages of `docs.x.ai`, plus press. The xAI announcement
  page refused automated reads, so the beta date comes from press.
- **Duet.** Read from three Anthropic pages on `claude.com` and one Anthropic
  help article on `support.claude.com`, plus press.
- **Dots.** Read from the Dots appendix of the OpenAI GPT-6 Astra system card,
  plus press. The OpenAI product and help pages refused automated reads, so most
  Dots cells are third-party claims.
- **Muse.** Read from two Meta newsroom posts and a Meta safety post, plus press
  and Wikipedia. The Meta product page returned no text.

## Grid

### Agents and runtime

| # | Feature | Crew | OpenBot | Grok Bot | Muse | OpenMuse | Dots | OpenDots | Duet | OpenDuet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Built-in agents | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| 2 | Bring your own agent over a protocol | No | Yes | ? | ? | Part | ? | No | ? | Yes |
| 3 | Model choice, own key, or base-URL override | Yes | Yes | No | ? | Yes | ? | Part | No | Yes |
| 4 | Conversations that survive a restart | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| 5 | Subagents or delegation inside one agent | Part | Yes | Yes | ? | Part | Yes | No | ? | Part |
| 6 | Agent-to-agent handoff or group conversations | Part | Yes | Yes | ? | No | Part | No | ? | Yes |

### Tools

| # | Feature | Crew | OpenBot | Grok Bot | Muse | OpenMuse | Dots | OpenDots | Duet | OpenDuet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 7 | A computer or browser for the agent | No | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| 8 | Shell and file access | Part | Yes | Yes | Part | Yes | Part | Yes | Part | Yes |
| 9 | MCP connectors or an app catalogue | No | Yes | Yes | Yes | Part | Yes | Yes | Yes | Yes |
| 10 | Custom tools that the deployer registers | Part | Yes | Yes | Yes | No | ? | Yes | ? | Yes |
| 11 | Generative UI or rich components | No | Yes | Yes | Part | Yes | Part | Yes | Part | Yes |
| 12 | Web research | No | Yes | Yes | Part | Yes | Part | Yes | Yes | Yes |

### Governance

| # | Feature | Crew | OpenBot | Grok Bot | Muse | OpenMuse | Dots | OpenDots | Duet | OpenDuet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 13 | Human approval before an action | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| 14 | Remembered approvals or standing grants | Yes | Yes | Yes | Yes | No | Part | Part | Part | Yes |
| 15 | Policy rules that allow or deny | No | Yes | Yes | Part | No | Yes | Part | Part | Yes |
| 16 | Audit trail with filters or export | Yes | Yes | Yes | Part | Part | Part | Part | Part | Yes |
| 17 | Record of what started an action | Yes | Yes | Part | ? | ? | ? | Part | ? | Yes |
| 18 | What-if or dry-run of rules | No | Yes | ? | ? | No | ? | No | ? | Yes |
| 19 | A person takes over the agent's computer | No | Yes | Yes | Yes | Yes | Part | Yes | No | Yes |
| 20 | Encrypted credential vault | No | Yes | Part | Part | Part | Part | No | Part | Yes |
| 21 | Defenses against prompt injection | Part | Yes | Yes | Yes | Part | Yes | Part | Yes | Yes |
| 22 | Sandbox isolation of execution | Part | Yes | Part | Yes | Yes | Part | Yes | Yes | Yes |

### Work over time

| # | Feature | Crew | OpenBot | Grok Bot | Muse | OpenMuse | Dots | OpenDots | Duet | OpenDuet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 23 | Scheduled routines | Yes | Yes | Yes | Part | Part | Yes | Part | Part | Yes |
| 24 | Event triggers or goals | No | Yes | Yes | Part | Part | Yes | No | Part | Yes |
| 25 | Follow-ups that the agent schedules | No | Yes | Part | Part | Part | Part | No | Part | Yes |
| 26 | Memory across conversations | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| 27 | Skills or reusable instruction packs | Part | Yes | Yes | Part | No | ? | Part | Yes | Yes |
| 28 | Learning from past work or a demonstration | No | Yes | Yes | ? | No | Part | Yes | ? | Yes |
| 29 | Proactive check-ins or suggestions | No | Yes | Yes | Yes | Yes | Yes | No | Yes | Yes |

### Surfaces

| # | Feature | Crew | OpenBot | Grok Bot | Muse | OpenMuse | Dots | OpenDots | Duet | OpenDuet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 30 | Web app | No | Yes | Part | Yes | Yes | Yes | Yes | Yes | Yes |
| 31 | Desktop app | No | Yes | Yes | Yes | No | Yes | No | No | No |
| 32 | Mobile app | No | Part | Yes | Yes | Part | Yes | Part | Yes | Part |
| 33 | Slack, Teams, SMS, or another chat surface | No | Yes | Yes | Yes | No | Yes | Yes | No | Yes |
| 34 | Notifications when nobody is watching | Yes | Yes | Yes | Part | Part | Part | No | Yes | Yes |
| 35 | Voice | No | Yes | Yes | Yes | No | Part | Yes | Part | Yes |

### Operations

| # | Feature | Crew | OpenBot | Grok Bot | Muse | OpenMuse | Dots | OpenDots | Duet | OpenDuet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 36 | Sign-in, SSO, and roles | Part | Yes | Yes | Part | Part | Part | Part | Part | Yes |
| 37 | Self-hosted deployment | Part | Yes | No | No | Yes | No | Yes | No | Yes |
| 38 | Telemetry and usage or cost metering | Yes | Part | Part | Part | Part | Part | Part | Part | Part |
| 39 | Backup and restore | Yes | Part | Part | Part | Part | ? | Part | ? | No |
| 40 | Open-source license | Yes | Yes | No | No | Yes | No | Yes | No | Yes |

## What Crew has for each row

Each line states what Crew does at `8fb8bf0` and where the feature stops. A line
that names a later pull request describes Crew after that pull request instead.

### Agents and runtime

| # | Crew | Detail |
| --- | --- | --- |
| 1 | Yes | Claude, Codex, and Pi members run through their TypeScript SDKs. The engine and the profile of a member are fixed at spawn. See [member profiles](member-profiles.md). |
| 2 | No | `POST /members` accepts only a profile that the operator registered. The AG-UI route only observes a conversation and rejects tools, context, and state from a client. |
| 3 | Yes | The operator chooses the model in a profile module. [AI proxy profiles](ai-proxy-profiles.md) route Claude Messages, Codex Responses, and Pi Chat Completions through an operator proxy. An owner can only pick among the profiles that the operator registered. No request field names a model. |
| 4 | Yes | Temporal orders turns. PostgreSQL stores each conversation, its native checkpoint, and its AG-UI history. See [the design](architecture.md) and [bounded conversations](bounded-conversations.md). |
| 5 | Part | A Pi member with a `.crew.v1` profile can call `delegate_task` to start at most two child workflows in one turn. Each child is a separate Pi session with a fixed role, `analyst` or `recorder`. Claude and Codex members have no subagents. |
| 6 | Part | An owner can hand a conversation to any of their members, including the source's own member or one with a different engine, through `POST /v1/conversations/{id}/handoffs`. The target is a fresh conversation whose first request carries the source's newest whole committed turns, at most 64 KiB, as a verbatim quoted transcript. The source is sealed, and a handoff cannot be undone. Only the owner starts a handoff: no member can hand off or delegate to another member, and each conversation still binds one member. See [conversation handoff](handoffs.md). |

### Tools

| # | Crew | Detail |
| --- | --- | --- |
| 7 | No | Members have no browser and no computer. |
| 8 | Part | Members have no shell and no file tools. Claude runs with no built-in tools and no operator MCP servers, Codex runs with its shell off in a read-only workspace, and Pi gets only its profile tools. The Python documentation pilot's Codex author has a shell and writes files in a workspace-write sandbox with no network, limited to one scratch worktree. See [the persistent pilot](persistent-pilot.md). |
| 9 | No | The profile fixes the tools of a member: `record_work_item`, `choose_next_step`, and `delegate_task` for Pi, plus any tools that a trusted application registers in code. Crew has no connector catalogue. Claude and Codex each reach their one profile tool through an MCP server that Crew creates for the invocation. |
| 10 | Part | A backend application can register at most eight tools in code through the trusted context library. No HTTP route registers a tool. See [trusted application context](trusted-application-context.md). A [capability model and a tool-call ledger](member-capabilities.md) exist for Crew-run file, shell and web tools, and no engine uses them yet. |
| 11 | No | The gateway emits run, step, text, tool-call, subagent, and snapshot events. It emits no custom or component events. |
| 12 | No | Codex web search is off. No member has a search tool. |

### Governance

| # | Crew | Detail |
| --- | --- | --- |
| 13 | Yes | A `record_work_item` call opens an approval card. A `choose_next_step` call opens a question. See [the gateway guide](member-gateway.md). An owner can give a request or a routine an approval deadline of one minute to seven days. After the deadline, Crew cancels a Claude or Pi request whose card or question is still undecided and records the expiry. A card that a Pi delegation child opens gets no deadline. A Codex card or question always expires after 45 seconds, whatever the owner sets. See [approval expiry](approval-expiry.md). |
| 14 | Yes | An owner can answer a card with `allow_conversation` or `allow_always`. A grant matches the tool, not its arguments. A grant never expires by time and never applies to a routine's request or to a handoff's first request. See [standing grants](standing-grants.md). |
| 15 | No | Crew has no deny rule and no rule language. The eligibility of a grant is fixed in code. A routine's `fail_closed` approval policy cancels the waiting request rather than denying the call. |
| 16 | Yes | `GET /v1/audit` returns an append-only trail of 33 event types as JSON or CSV. Pull request #57 adds three of them: `member.instruction_packs_attached`, `instruction_pack.created`, and `instruction_pack.deleted`. It filters by conversation, member, event type, actor kind, initiator kind, initiator ID, and time window, combined with AND. No filter reads payload fields, such as an approval's choice or the `routineId` of a routine's own rows. The four `webhook.*` types and the two `instruction_pack.*` types name no member, so a `memberId` filter never matches their rows. Refused HTTP calls leave no row, except a request that its member's usage budget refuses. No retention limit and no deletion route exist. See [the audit trail](audit-trail.md) and [audit filters](audit-filters.md). |
| 17 | Yes | Each request admission records an initiator of kind `owner`, `routine`, or `handoff`. The audit trail copies the initiator from the admission. |
| 18 | No | Grant matching runs only inside the transaction that records a call. |
| 19 | No | Members have no computer. |
| 20 | No | Provider keys come from environment variables, operator-provided private files, the operator's Codex login, or an operator credential command for proxy profiles. Crew has no credential store and encrypts none of them. Native transcripts are plain text in the state directory. Each webhook endpoint's signing secret is stored as plain text in PostgreSQL. |
| 21 | Part | An AG-UI client cannot supply tools or context. An owner can set a member's instructions once, at spawn, and attach shared instruction packs at spawn (pull request #57). Both reach the model as instructions, not as reference data, so a pack built from untrusted text reaches every member that has it. Crew injects project notes and member memory under a header that labels them as reference data. Crew has no injection classifier. It checks tool arguments only against strict schemas and binds `operation_id` to the request; it does not inspect free text such as the `note` of a work item. A handoff passes the source's replies to the target inside a user message, which [the handoff guide](handoffs.md) says is not a security boundary. |
| 22 | Part | A Landlock and seccomp launcher confines the native process of every engine (pull request #61). Claude's CLI may write only its conversation directory, and the launcher does not limit its network. Codex's binary may write only its private home and connect only to its provider and tool ports. Pi's SDK runs in a Node worker that may read only Node, Crew's code and one private directory, holds no credentials, and cannot open a socket, start a process or signal another; the host makes its model requests and runs its tools. A kernel without the Landlock version an engine needs fails the turn rather than running it unconfined. The Python documentation pilot's Codex author relies on Codex's own workspace-write sandbox, which [the in-cluster executor guide](in-cluster-executor.md) does not verify in its container. See [native confinement](verification.md#native-confinement). |

### Work over time

| # | Crew | Detail |
| --- | --- | --- |
| 23 | Yes | An owner creates a routine with a five-field UTC cron schedule. Windows are at least 15 minutes apart. An owner has at most 20 enabled routines. The tenth failure in a row disables a routine. Each firing opens a new conversation. See [scheduled routines](scheduled-routines.md). |
| 24 | No | No inbound webhook, repository, or email event starts a request. Crew's own webhooks are outbound only. |
| 25 | No | A member has no tool that schedules a later turn. Only an owner creates a routine. |
| 26 | Yes | An owner saves at most 32 active entries of at most 1,024 bytes for each member. A conversation takes a snapshot of the entries when it opens. The model cannot write memory, and Crew has no search over memory. See [member memory](memories.md). |
| 27 | Part | An owner can give a member instructions of at most 16,384 bytes at spawn, and can write reusable instruction packs and attach up to eight of them to a member at spawn (pull request #57). A pack never changes, and packs and instructions share the 16,384 bytes. Both are fixed for the life of the member and never change its tools, approvals, or limits. Both reach each native launch of its conversations before project notes and memory, except Pi delegation children and the trusted-context lane. Crew still has no skills: every pack a member has is in every launch's system context, the model cannot find or load a pack or skill on demand, a pack carries text only (no files, scripts, or tools), and a member cannot gain a pack after it is spawned. Pi loads no skills and no prompt templates, and no extensions other than Crew's own inline ones. Claude loads no plugins and no setting sources. Codex runs with plugins off and refuses ambient configuration files. See [member instructions](member-instructions.md) and [instruction packs](instruction-packs.md). |
| 28 | No | Crew does not learn from finished conversations. |
| 29 | No | A member acts only on an owner request, a handoff's first request, a routine firing, or a trusted application's request. |

### Surfaces

| # | Crew | Detail |
| --- | --- | --- |
| 30 | No | Crew is a headless service. Besides the operator CLI, the only clients in the repository are two scripts in `clients/`. `observe.mjs` attaches an AG-UI observer, and `resolve.mjs` posts a decision. The original first-milestone brief assigns the eventual phone and browser interface to Birbforge. |
| 31 | No | None. |
| 32 | No | None. The original first-milestone brief assigns the eventual phone interface to Birbforge. |
| 33 | No | None. No one can talk to a member or answer a card in Slack, Teams, SMS, or another chat. A webhook endpoint in the `slack` format (pull request #58) posts one-way notices into a Slack, Mattermost, or Discord channel through an incoming-webhook URL that the owner registers. Crew holds no chat account or app token, only that URL, and reads nothing from a chat. [The original first-milestone brief](first-milestone.md) excluded sending to Slack. |
| 34 | Yes | An owner can keep up to 10 HTTPS webhook endpoints enabled. Crew posts to them when a card or question becomes pending, a request finishes, a routine firing settles, or Crew disables a routine. Each endpoint chooses a format (pull request #58): a signed body for a receiver that the owner runs, or a short message that a Slack, Mattermost, or Discord incoming webhook or an ntfy topic shows to a person, with no service of the owner's own in between. Each holds IDs, the time, and a status or the tool name. None holds prompt or reply text. A message cannot decide a card. Crew posts only to a URL that the owner registers, and sends no email or SMS and runs no push service itself. See [outbound webhooks](webhooks.md). |
| 35 | No | None. |

### Operations

| # | Crew | Detail |
| --- | --- | --- |
| 36 | Part | The gateway maps static bearer-token digests to owner IDs. Crew has no sign-in provider, no session, no role, and no user management. |
| 37 | Part | The repository builds a service image, an executor image for the documentation pilot, and the pilot's Python API image, and supports Temporal mTLS. The gateway binds only to 127.0.0.1. The repository has no Kubernetes manifest and no Helm chart, and a rolling update is documented as unsafe. See [persistent deployment](persistent-deployment.md) and [the in-cluster executor](in-cluster-executor.md). |
| 38 | Yes | Crew exports four trace span names over OTLP. It records the token counts each engine reports for every native segment that returns a result, in the member lane and the trusted-context lane. It totals them per member and conversation through `/v1/usage`, and lets an owner give a member a daily token budget that admission enforces as a soft cap. It keeps a cost the provider billed when a Pi provider reports one, and otherwise estimates one from a price table the operator supplies, computed when the segment is recorded and reported apart from billed cost (pull request #59). Crew ships no prices, so without that table a segment has no cost. It does not meter segments that fail or are cancelled, export usage as metrics, or budget money. See [usage metering](usage-metering.md). |
| 39 | Yes | An operator can take a quiesced backup of the whole installation and restore it behind a fence. The procedure stops the whole installation. A restored installation revokes every standing grant, suspends every active memory entry, and disables every enabled webhook endpoint as it resumes. See [coordinated recovery](coordinated-recovery.md). |
| 40 | Yes | MIT. |

## Notes on the other products

Each list gives notes for cells that need a qualifier and for features that fit
no row. "How to read the grid" lists the "Part" cells that have no note.

### OpenBot

- **Row 4.** CopilotKit Intelligence stores threads. PostgreSQL stores policy,
  approvals, audit, and routines.
- **Row 6.** A Bot hands work to another Bot with the `message_bot` tool. The
  handoff needs a grant, has a depth limit of 1 by default, and has a limit of 3
  per run.
- **Row 15.** Rules are CEL expressions. Deny rules run before allow rules. A
  missing policy refuses every action, and a rule that fails to evaluate
  refuses. Rules can read the tool, the intent, the Bot, the actor, the
  initiator, the page, the element, the pressed key, the file, the command, and
  the MCP tool.
- **Row 16.** The audit table is append-only through a database trigger. Rows
  can be deleted only after a retention window that the operator sets, and the
  window is off by default. The filters cover event type, actor, initiator, Bot,
  app, tool, effect, intent, rule, and time. A CSV export returns at most 5,000
  rows.
- **Row 18.** An admin can replay a candidate policy over past actions, and can
  ask why a recorded action was allowed or refused.
- **Row 23.** Routines use five-field cron in an IANA time zone, a 15-minute
  floor, a cap of 20 enabled routines for each person, and a switch-off after
  ten failures in a row. A routine reply is posted into its channel and marks
  the channel unread. The server does not send the reply to chat, SMS, or push.
- **Row 24.** Goals start from webhooks, GitHub, Linear, Sentry, PagerDuty,
  inbound email, and Slack.
- **Row 28.** Automatic Learning and the browser recorder both depend on
  CopilotKit Intelligence.
- **Row 32.** The repository has an Expo mobile app at version 0.0.1. The
  README links iOS and Android, along with Web, Slack, and Teams, to early-access
  sign-up pages.
- **Row 33.** Slack and Microsoft Teams go through OpenTag, a separate
  CopilotKit service on the Channels SDK. Text messages go through Twilio. The
  README also links Slack and Teams to early-access sign-up pages.
- **Row 38.** OpenBot records one row for each run with the model name. It
  records no token count and no cost.
- **Row 39.** The desktop app takes a `pg_dump` before an upgrade and restores
  it if the upgrade fails. Nothing takes a backup on demand. The Helm chart
  documentation states that the bundled PostgreSQL has no backups.
- **No row.** An admin can write a rule in English, and a model translates the
  sentence to CEL. An admin can also ask a question of the audit trail in
  English.

### Grok Bot

- **Row 3.** The xAI FAQ states that Grok Bot picks the model for each task and
  has no model picker.
- **Row 7.** Each user gets one cloud computer. All Bots of that user share its
  files, browser sessions, and command-line credentials. Each Bot has its own
  screen.
- **Row 11.** Pages hold reports, dashboards, and trackers with tables, charts,
  and filters. Pages are still rolling out and are not on Enterprise teams.
- **Row 14.** "Always allow" saves a rule. A user has at most 20 allow rules and
  20 ask-first rules.
- **Row 15.** Users write Custom Rules. Admins write Team Rules. Enterprise
  plans add auto-review rules.
- **Row 16.** On the Enterprise plan only. The Audit Log can be filtered to Grok
  Bot and streamed to a SIEM. Action Recording records each tool call and the
  decision about it, and is exported through OpenTelemetry.
- **Row 20.** Bots sign in with logins from Vault, a connected password manager,
  or a Secure Form without seeing the values. The sources read do not say that
  Vault is encrypted. On the Enterprise plan, Team Secrets for team setup
  scripts are stored encrypted, and xAI states that they are not given to Bots
  directly.
- **Row 21.** Outside content is marked as untrusted data for the model. Auto
  Review counts only the user's own messages as requests.
- **Row 22.** xAI states that each user's computer is dedicated and
  hardware-isolated from other users. The Bots of one user share that computer,
  and xAI states that their screens are separate work surfaces, not separate
  security boundaries.
- **Row 23.** A Bot has at most 50 routines, at least 5 minutes apart.
- **Row 24.** Triggers cover Slack, GitHub, Linear, Sentry, PagerDuty, email,
  and webhooks.
- **Row 28.** "Teach a task" records at most 10 minutes and creates a draft
  skill.
- **Row 30.** xAI lists desktop, mobile, Slack, and X as places to work with
  Bots, and the sources describe no standalone web app. The same Bots are
  reachable through X Chat on x.com.
- **Row 33.** X Chat, in the X apps and on x.com. A Team Bot can also be
  reached in Slack, and an admin can let Team Bots join Microsoft Teams.
- **Row 34.** A Bot sends a system or mobile alert when it finishes or needs
  the user.
- **Row 36.** On team plans. SCIM provisioning is on the Enterprise plan only.
  The roles that the sources describe are team admin and the Managers of a
  Team Bot.
- **Row 38.** Usage is metered per product. On the Enterprise plan only,
  OpenTelemetry Export streams usage metrics and logs to the customer's
  collector, and members see a spend limit. xAI states that a separate spend
  cap for Grok Bot alone is not available.
- **No row.** A user can claim one email address that all of their Bots share.
  A Bot can join a video meeting
  and report back. A Bot can run commands on the user's own computer under a
  separate policy. Enterprise plans can send each model request to a customer
  security server first.

### Muse

- **Row 7.** Each user's agent runs in a separate virtual machine with a browser
  that the user can watch and take over.
- **Row 8.** Users can inspect, edit, and download the files of the virtual
  machine. No source mentions a shell.
- **Rows 9 and 10.** The app settings list a connector catalogue. Users can add
  custom connectors for services that the catalogue lacks.
- **Row 14.** A grant can be one-time, session-scoped, task-scoped,
  time-bounded, or perpetual.
- **Row 15.** A permission system named Sentinel controls which services the
  agent reaches, separates read access from write access, and returns allow,
  deny, or ask from a policy that the user sets. The sources describe no rule
  language.
- **Row 20.** Meta states that credentials a person shares go into secure
  storage, so that Muse can use them without seeing them. The sources read do
  not say that this storage is encrypted. Meta announces for later a
  Confidential VM that is encrypted with a key only the user holds.
- **Row 21.** Meta describes a model trained to resist injection, outside data
  labelled as untrusted, and a set of injection detectors.
- **Row 27.** Meta ships a set of skills for small businesses. The sources
  describe no way for a user to create a skill. Meta's safety post mentions
  developing custom skills on the agent's computer without saying who writes
  them.
- **Row 31.** macOS only.
- **Row 33.** WhatsApp only. Meta states that users can message Muse in the
  Muse app or directly in WhatsApp.
- **Row 36.** A Meta account. The sources describe no SSO and no roles.
- **No row.** Spaces are sidebar pages that the agent builds from a chat
  description and keeps current. The agent has its own email address. Purchases
  use a one-time card through Link by Stripe. Press reports that Shop Pay and
  PayPal came later.

### OpenMuse

- **Row 2.** An external AG-UI agent can replace the chat agent, but that agent
  must bring its own tools.
- **Row 5.** The chat agent hands work to a durable server task with a plan.
- **Row 9.** A searchable connector list holds Gmail, Google Calendar, the agent
  computer, and the disabled OpenBot adapter. The feature inventory lists other
  connectors as planned. The only MCP client is the built-in web search through
  Parallel's Search MCP.
- **Row 13.** Every email send and every calendar change needs its own stored
  approval.
- **Row 16.** Each reviewed action adds an activity entry with its title,
  status, and date, and the app lists the entries. The repository has no audit
  route, no filter, and no export.
- **Row 20.** Only the Google OAuth tokens are encrypted.
- **Row 21.** Prompts and tool descriptions label email, calendar text, web
  pages, files, and tool results as untrusted data. The repository has no
  injection classifier. Its security policy states that approval covers only
  the email and calendar tools, so with the optional E2B desktop a
  prompt-injected agent could send data out of the computer.
- **Row 23.** Only recurring watches of public pages. No general cron routine.
- **Row 24.** Goals hold an outcome and milestones, and a page watch alerts when
  a public page changes. The server has no webhook and no other inbound event
  trigger.
- **Row 25.** In chat, the agent can schedule a recurring check of a public page
  with `watch_page` and save a goal with `create_goal`. It has no tool that
  schedules a later turn or a reminder.
- **Row 32.** iOS and Android builds come from the shared Expo app. The build
  scripts export JavaScript bundles, not signed app binaries.
- **Row 34.** A durable in-app inbox and change alerts. Device push is listed
  as planned.
- **Row 36.** One owner with one shared access key.
- **Row 38.** The CopilotKit SDK sends runtime usage events to CopilotKit by
  default, and an operator can opt out. The repository records no token count
  and no cost.
- **Row 39.** By default the database, documents, and signing key live in
  `.openmuse/`, which the README says to back up. Chat threads live in
  CopilotKit Intelligence. The repository has no backup or restore command.
- **No row.** A pipeline fills a PDF form from an email attachment. A tracker
  summarizes a transaction CSV. A watcher alerts on a page change or a price.

### Dots

- **Row 5.** The OpenAI system card states that a Dot often delegates work to
  subagents.
- **Row 6.** People, ChatGPT, Codex, and Dots share context in ChatGPT Space and
  hand work to each other. The sources describe no handoff between two Dots.
- **Row 13.** An auto-review system decides whether an action proceeds or needs
  approval.
- **Row 15.** VentureBeat and Digit report that users write Custom Rules that
  allow, block, or require approval for an action.
- **Row 19.** A user can inspect the computer of a Dot while the Dot works. The
  sources describe no takeover control.
- **Row 23.** Recurring tasks run as automations on a schedule or an external
  event.
- **Row 33.** Slack and Microsoft Teams. The OpenAI system card also names text
  message and email. Press reports that texting is still to come.
- **No row.** Specialist Dots, in pilot, belong to an organization and have
  their own identity and credentials. ChatGPT Space holds shared pages and files.

### OpenDots

- **Row 3.** OpenAI-compatible endpoints only.
- **Row 9.** Each Dot has its own MCP servers. Composio apps are switched on for
  each Dot from one owner-wide account. An MCP server that needs OAuth is not
  supported.
- **Row 14.** An owner can turn off "Ask first" for a tool. Each approval covers
  one run.
- **Row 15.** Each Dot has on and off switches for research, memory, browser,
  file, and shell access and for each MCP tool, and each MCP tool has an "Ask
  first" switch. There is no rule language.
- **Row 16.** Each Dot keeps the latest 1,000 computer actions.
- **Row 17.** The Activity view of a Dot's computer shows who requested each
  computer action. This page found no such record for other tool calls.
- **Row 20.** MCP tokens are stored in SQLite without encryption.
- **Row 21.** Page content, tool results, and the earlier conversation in a call
  reach the model labelled as untrusted data, and an MCP tool not marked
  read-only asks first by default. The repository has no injection classifier.
- **Row 23.** Interval schedules from the UI. No cron.
- **Row 27.** Only the skills that Automatic Learning publishes.
- **Row 32.** The README says OpenDots is available on web and mobile. The
  repository has a web app with a mobile layout and no native mobile app.
- **Row 33.** Slack only, through a managed Channels SDK connection with a
  workspace and user allowlist. Approval cards appear only in the web app.
- **Row 36.** One owner. Binding the server beyond loopback requires an
  `OWNER_TOKEN` of at least 24 characters. No SSO and no roles.
- **Row 38.** The CopilotKit SDK sends usage telemetry to CopilotKit, and
  OpenDots records browser setup stages. The same settings turn both off. The
  repository records no token count and no cost.
- **Row 39.** The setup guide says to back up both the SQLite file and the
  Intelligence project. The repository has no backup or restore command.
- **No row.** Spaces are editable pages with one conversation for each page and
  each Dot. A voice call runs a speech model beside a separate work agent.

### Duet

- **Row 3.** Anthropic states that the user cannot choose a model.
- **Row 7.** Duet has its own cloud virtual machine and browser. Anthropic
  states that Duet cannot yet show the user its browser.
- **Row 14.** Some steps accept a "don't ask me again" rule. Payments, transfers,
  deleted orders, and new accounts always ask.
- **Row 20.** The user types a password into an in-app form, which Anthropic
  states encrypts it with a single-use key for that one sign-in. The model
  never sees the password.
- **Row 21.** A check of each action runs outside the model. A separate
  classifier looks for sensitive information.
- **Row 23.** Duet sends a brief each morning and checks connected accounts at
  set intervals. The user can tell it what to hear about and how often. No
  source describes a routine with a time or a recurrence that the user defines.
- **Row 24.** Anthropic states that Duet checks connected accounts every few
  hours. The sources describe no event trigger.
- **Row 27.** Duet inherits the skills of the Claude account.
- **Rows 31 and 33.** Anthropic lists apps for iOS and Android, and claude.ai.
  Slack appears only as a connector.
- **No row.** Duet sends a brief each morning. Duet can buy items through Link
  or Shop Pay after the user approves. Some actions stay blocked even with
  approval, for example trading securities.

### OpenDuet

- **Every row without its own note.** The answer comes from the OpenBot code
  that OpenDuet contains.
- **Row 5.** The `start_task` tool runs larger work in a separate task
  conversation with the same Bot. The result does not return to the calling
  turn. The `run_subagent` tool of OpenBot is not in this copy.
- **Row 18.** The copy can replay a candidate computer policy over past
  actions. It has no what-if question, no "why" for a recorded action, and no
  English question about the audit trail.
- **Row 31.** The copy includes the OpenBot desktop installer, which is branded
  OpenBot and does not load the OpenDuet package.
- **Row 37.** The supported path is a start script with Docker Compose. OpenDuet
  has no image of its own.
- **Row 39.** The copy does not include the upgrade backup of the OpenBot
  desktop app.
- **No row.** A morning brief. Mail triage into "needs you" and "can wait", with
  an evaluation set of 62 labelled emails. A Tasks tab with suggestion cards. A
  "Make" tab for dashboards, slides, documents, and pages.

## Rows where Crew differs from the group

These lists are counts from the grid. They are not a priority order, and they
do not rank the products: a row says how many products have a feature, not how
well any of them does it.

Both lists use one counting rule. Only the eight columns other than Crew are
counted. A product has a feature when its cell is "Yes" or "Part", and lacks it
when its cell is "No". A "?" counts as neither, so it is left out of both
counts. After each row are the counts of Yes, Part, No, and ? among the eight
other products. The thresholds, seven of eight and four of eight, are cut-offs
chosen for this page.

Crew lacks the feature, and at least seven of the eight other products have it:

- 7, a computer or browser for the agent (8 Yes, 0 Part, 0 No, 0 ?)
- 9, MCP connectors or an app catalogue (7 Yes, 1 Part, 0 No, 0 ?)
- 11, generative UI or rich components (5 Yes, 3 Part, 0 No, 0 ?)
- 12, web research (6 Yes, 2 Part, 0 No, 0 ?)
- 15, policy rules that allow or deny (4 Yes, 3 Part, 1 No, 0 ?)
- 19, a person takes over the agent's computer (6 Yes, 1 Part, 1 No, 0 ?)
- 20, encrypted credential vault (2 Yes, 5 Part, 1 No, 0 ?)
- 24, event triggers or goals (4 Yes, 3 Part, 1 No, 0 ?)
- 25, follow-ups that the agent schedules (2 Yes, 5 Part, 1 No, 0 ?)
- 29, proactive check-ins or suggestions (7 Yes, 0 Part, 1 No, 0 ?)
- 30, web app (7 Yes, 1 Part, 0 No, 0 ?)
- 32, mobile app (4 Yes, 4 Part, 0 No, 0 ?)
- 35, voice (5 Yes, 2 Part, 1 No, 0 ?)

Crew has the feature ("Yes" or "Part"), and at most four of the eight other
products have it:

- 3, model choice, own key, or base-URL override (3 Yes, 1 Part, 2 No, 2 ?)
- 6, agent-to-agent handoff or group conversations (3 Yes, 1 Part, 2 No, 2 ?)
- 17, record of what started an action (2 Yes, 2 Part, 0 No, 4 ?)
- 37, self-hosted deployment (4 Yes, 0 Part, 4 No, 0 ?)
- 40, open-source license (4 Yes, 0 Part, 4 No, 0 ?)

No row has Crew with a feature that fewer than four of the other products have.
In rows 3, 6, and 17, the "?" cells could each hide a product that has the
feature.

## Sources

Hosted sources were read on 2026-11-12. Repositories were read at the commits
in the products table:

- [CopilotKit/OpenBot](https://github.com/CopilotKit/OpenBot)
- [CopilotKit/openmuse](https://github.com/CopilotKit/openmuse)
- [CopilotKit/OpenDots](https://github.com/CopilotKit/OpenDots)
- [CopilotKit/OpenDuet](https://github.com/CopilotKit/OpenDuet)

Grok Bot:

- [Grok Bot overview](https://docs.x.ai/grok-bot/overview)
- [Computer and apps](https://docs.x.ai/grok-bot/computer-and-apps)
- [Approvals, security, and privacy](https://docs.x.ai/grok-bot/approvals-security-and-privacy)
- [Skills, routines, and automations](https://docs.x.ai/grok-bot/skills-routines-and-automations)
- [Teams and enterprises](https://docs.x.ai/grok-bot/teams-and-enterprises)
- [Interesting Engineering on Grok Bot](https://interestingengineering.com/ai-robotics/xai-grok-bot-computer-agent)
- [Settings and notifications](https://docs.x.ai/grok-bot/settings-and-notifications)
- [Files and results](https://docs.x.ai/grok-bot/files-and-results)
- [Chat and collaboration](https://docs.x.ai/grok-bot/chat-and-collaboration)
- [Security](https://docs.x.ai/grok-bot/security)
- [Bots](https://docs.x.ai/grok-bot/bots)
- [FAQ](https://docs.x.ai/grok-bot/faq)
- [Reworked on Grok Bot](https://www.reworked.co/collaboration-productivity/xai-launches-grok-bot-ai-agents-in-beta/)

Muse:

- [Meta newsroom, introducing Muse](https://about.fb.com/newsroom/2026/09/introducing-muse-personal-ai-agent/)
- [Meta, security and safety for AI agents](https://muse.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse)
- [Meta newsroom, Muse for small business](https://about.fb.com/news/2026/09/introducing-muse-small-business/)
- [DataCamp tutorial on Muse](https://www.datacamp.com/tutorial/meta-muse-tutorial)
- [Social Media Today on Muse for Mac](https://www.socialmediatoday.com/news/meta-expands-muse-agent-connections-launches-muse-for-mac/830852/)
- [TechCrunch on new Muse features](https://techcrunch.com/2026/09/23/everything-new-coming-to-metas-ai-agent-muse/)
- [Wikipedia, Muse (AI agent)](https://en.wikipedia.org/wiki/Muse_(AI_agent))
- [DataCamp on Muse](https://www.datacamp.com/blog/muse-agent)
- [MindStudio on Muse](https://www.mindstudio.ai/blog/meta-muse-ai-agent)
- [TechCrunch on Muse Spaces](https://techcrunch.com/2026/11/06/meta-introduces-spaces-a-new-way-to-collaborate-with-your-muse-agent/)

Dots:

- [OpenAI GPT-6 Astra system card](https://deploymentsafety.openai.com/gpt-6-astra), Dots appendix
- [VentureBeat on Dots](https://venturebeat.com/technology/openai-launches-dots-always-on-ai-agent-coworkers-and-chatgpt-space-where-they-can-collaborate-with-human-teams)
- [Digit on Dots](https://www.digit.in/features/general/openai-dots-explained-an-ai-coworker-that-never-logs-off.html)
- [Promptessor on Dots](https://promptessor.com/blog/openai-dots)
- [ToolJunction on Dots](https://www.tooljunction.io/blog/openai-dots)

Duet:

- [Introducing Claude Duet](https://claude.com/resources/articles/claude-duet)
- [Claude Duet safety, privacy, and security](https://claude.com/resources/articles/claude-duet-safety-privacy-and-security)
- [Claude Duet product page](https://claude.com/product/claude-duet)
- [Get started with Claude Duet](https://support.claude.com/en/articles/17631495-get-started-with-claude-duet)
- [SiliconANGLE on Claude Duet](https://siliconangle.com/2026/10/22/anthropic-introduces-claude-duet-a-proactive-ai-agent-for-professionals/)
- [Fello AI on Claude Duet](https://felloai.com/claude-duet/)

## Update this page

1. Read every Crew row at the newest `main` commit. Put that commit in the
   products table and in the first line of "What Crew has for each row", and
   remove the pull request names from the Crew detail lines.
2. Read each open-source repository at its newest commit. Put the commit and
   its date in the products table. Record the OpenBot version of OpenDuet's
   `openbot/` copy and the OpenBot commit that OpenDots pins in
   `compose.computers.yml`, in the list under the products table.
3. Read the cited sources of each hosted product. Put the read date in the
   products table and above the Sources list, and change the Sources list when
   a source moves or a new one is used.
4. Change the cells and the notes under the meanings and grading rules in "How
   to read the grid". Give a "Part" cell a note when the source shows which
   part, and keep the list of "Part" cells without a note in that section
   exact.
5. Recount both lists in "Rows where Crew differs from the group" from the grid,
   under the counting rule stated there, including the Yes, Part, No, and ?
   counts after each row.
6. Change the snapshot date at the top.

A pull request that changes what Crew does changes the affected Crew cells and
detail lines, and recounts both lists, in the same pull request. Each detail
line that it changes names the pull request, because the commit in the products
table stays the commit of the last full read in step 1.
