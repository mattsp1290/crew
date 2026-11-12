# Feature comparison: Crew and eight AI-coworker products

This page compares what Crew supports with eight other products, across 40
features. Use it to pick candidate features for Crew. It records what each
product does. It does not rank the products or recommend a feature.

The comparison is a snapshot taken on 2026-11-12.

## Products

| Column | Product | Kind | Read at |
| --- | --- | --- | --- |
| Crew | This repository | Open source (MIT), headless service | `main` at `47f3c0f` |
| OpenBot | [CopilotKit/OpenBot](https://github.com/CopilotKit/OpenBot) | Open source (MIT), self-hosted workspace | `0fe182c` (2026-11-12) |
| Grok Bot | xAI Grok Bot | Hosted, beta since 2026-08-11 | xAI docs and press |
| Muse | Meta Muse | Hosted, announced 2026-09-08 | Meta posts and press |
| OpenMuse | [CopilotKit/openmuse](https://github.com/CopilotKit/openmuse) | Open source (MIT), alpha personal agent | `a4944f4` (2026-10-26) |
| Dots | OpenAI Dots | Hosted, announced 2026-09-29 | OpenAI system card and press |
| OpenDots | [CopilotKit/OpenDots](https://github.com/CopilotKit/OpenDots) | Open source (MIT), alpha single-owner template | `46eaf96` (2026-11-10) |
| Duet | Anthropic Claude Duet | Hosted, research preview since 2026-10-21 | Anthropic pages and press |
| OpenDuet | [CopilotKit/OpenDuet](https://github.com/CopilotKit/OpenDuet) | Open source (MIT), OpenBot with an added layer | `edb9126` (2026-11-10) |

How the open-source products relate to each other and to the hosted ones:

- OpenDuet contains an older copy of OpenBot (version 0.2.0, where OpenBot is
  now 1.0.1) in its `openbot/` directory and adds a morning brief, mail triage,
  tasks, and pages. Most OpenDuet answers below come from that copy. The copy
  lacks later OpenBot features such as subagents.
- OpenMuse and OpenDots are separate codebases. OpenDots builds the computer
  service and the supervisor of OpenBot from a pinned OpenBot commit.
- OpenBot, OpenMuse, OpenDots, and OpenDuet all need CopilotKit Intelligence, a
  separately licensed service, for conversation threads.
- The OpenDuet README names Claude Duet as an example of its product category
  and states that OpenDuet is not affiliated with Anthropic. The OpenMuse and
  OpenDots repositories do not name a proprietary product. This page puts
  OpenMuse next to Muse, and OpenDots next to Dots, because of the names only.

## How to read the grid

| Cell | Meaning |
| --- | --- |
| Yes | The product has the feature. |
| Part | The product has part of the feature. The notes say which part. |
| No | The source or the documentation shows that the product lacks the feature. |
| ? | The sources that were read do not say. |

How much to trust each column:

- **Crew, OpenBot, OpenMuse, OpenDots, OpenDuet.** Read from source code and
  repository documentation. Nothing was run.
- **Grok Bot.** Read from pages of `docs.x.ai`, plus press. The xAI announcement
  page refused automated reads, so the beta date comes from press.
- **Duet.** Read from three Anthropic pages on `claude.com`, plus press.
- **Dots.** Read from the Dots appendix of the OpenAI GPT-6 Astra system card,
  plus press. The OpenAI product and help pages refused automated reads, so most
  Dots cells are third-party claims.
- **Muse.** Read from two Meta newsroom posts and a Meta safety post, plus press
  and Wikipedia. The Meta product page returned no text.

A hosted product gets "No" for self-hosting when its sources describe only a
vendor cloud.

## Grid

### Agents and runtime

| # | Feature | Crew | OpenBot | Grok Bot | Muse | OpenMuse | Dots | OpenDots | Duet | OpenDuet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Built-in agents | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| 2 | Bring your own agent over a protocol | No | Yes | ? | ? | Part | ? | No | ? | Yes |
| 3 | Model choice, own key, or base-URL override | Yes | Yes | No | ? | Yes | ? | Part | No | Yes |
| 4 | Conversations that survive a restart | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| 5 | Subagents or delegation inside one agent | Part | Yes | Yes | ? | Part | Yes | No | ? | Part |
| 6 | Agent-to-agent handoff or group conversations | No | Yes | Yes | ? | No | Part | No | ? | Yes |

### Tools

| # | Feature | Crew | OpenBot | Grok Bot | Muse | OpenMuse | Dots | OpenDots | Duet | OpenDuet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 7 | A computer or browser for the agent | No | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| 8 | Shell and file access | No | Yes | Yes | Part | Yes | Part | Yes | Part | Yes |
| 9 | MCP connectors or an app catalogue | No | Yes | Yes | Yes | Part | Yes | Yes | Yes | Yes |
| 10 | Custom tools that the deployer registers | Part | Yes | Yes | Yes | No | ? | Yes | ? | Yes |
| 11 | Generative UI or rich components | No | Yes | Yes | Part | Yes | Part | Yes | Part | Yes |
| 12 | Web research | No | Yes | Yes | Part | Yes | Part | Yes | Yes | Yes |

### Governance

| # | Feature | Crew | OpenBot | Grok Bot | Muse | OpenMuse | Dots | OpenDots | Duet | OpenDuet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 13 | Human approval before an action | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| 14 | Remembered approvals or standing grants | Yes | Yes | Yes | Yes | No | Part | Part | Part | Yes |
| 15 | Policy rules that allow or deny | No | Yes | Yes | Part | No | Part | Part | Part | Yes |
| 16 | Audit trail with filters or export | Yes | Yes | Part | Part | Part | Part | Part | Part | Yes |
| 17 | Record of what started an action | Yes | Yes | Part | ? | ? | ? | Part | ? | Yes |
| 18 | What-if or dry-run of rules | No | Yes | ? | ? | No | ? | No | ? | Yes |
| 19 | A person takes over the agent's computer | No | Yes | Yes | Yes | Yes | Part | Yes | No | Yes |
| 20 | Encrypted credential vault | No | Yes | Yes | Yes | Part | Part | No | Part | Yes |
| 21 | Defenses against prompt injection | Part | Yes | Yes | Yes | Part | Yes | Part | Yes | Yes |
| 22 | Sandbox isolation of execution | Part | Yes | Part | Yes | Yes | Part | Yes | Yes | Yes |

### Work over time

| # | Feature | Crew | OpenBot | Grok Bot | Muse | OpenMuse | Dots | OpenDots | Duet | OpenDuet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 23 | Scheduled routines | Yes | Yes | Yes | Part | Part | Yes | Part | Part | Yes |
| 24 | Event triggers or goals | No | Yes | Yes | Part | Part | Yes | No | Part | Yes |
| 25 | Follow-ups that the agent schedules | No | Yes | Part | Part | Part | Part | No | Part | Yes |
| 26 | Memory across conversations | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| 27 | Skills or reusable instruction packs | No | Yes | Yes | Part | No | ? | Part | Yes | Yes |
| 28 | Learning from past work or a demonstration | No | Yes | Yes | ? | No | Part | Yes | ? | Yes |
| 29 | Proactive check-ins or suggestions | No | Yes | Yes | Yes | Yes | Yes | No | Yes | Yes |

### Surfaces

| # | Feature | Crew | OpenBot | Grok Bot | Muse | OpenMuse | Dots | OpenDots | Duet | OpenDuet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 30 | Web app | No | Yes | Part | Yes | Yes | Yes | Yes | Yes | Yes |
| 31 | Desktop app | No | Yes | Yes | Yes | No | Yes | No | No | No |
| 32 | Mobile app | No | Part | Yes | Yes | Part | Yes | Part | Yes | Part |
| 33 | Slack, Teams, SMS, or another chat surface | No | Yes | Yes | Part | No | Yes | Part | No | Yes |
| 34 | Notifications when nobody is watching | No | Yes | Yes | Part | Part | Part | No | Yes | Yes |
| 35 | Voice | No | Yes | Yes | Yes | No | Part | Yes | Part | Yes |

### Operations

| # | Feature | Crew | OpenBot | Grok Bot | Muse | OpenMuse | Dots | OpenDots | Duet | OpenDuet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 36 | Sign-in, SSO, and roles | Part | Yes | Yes | Part | Part | Part | Part | Part | Yes |
| 37 | Self-hosted deployment | Part | Yes | No | No | Yes | No | Yes | No | Yes |
| 38 | Telemetry and usage or cost metering | Part | Part | Part | Part | Part | Part | Part | Part | Part |
| 39 | Backup and restore | Yes | Part | Part | Part | Part | ? | Part | ? | No |
| 40 | Open-source license | Yes | Yes | No | No | Yes | No | Yes | No | Yes |

## What Crew has for each row

Each line states what Crew does at `47f3c0f` and where the feature stops.

### Agents and runtime

| # | Crew | Detail |
| --- | --- | --- |
| 1 | Yes | Claude, Codex, and Pi members run through their TypeScript SDKs. The engine and the profile of a member are fixed at spawn. See [member profiles](member-profiles.md). |
| 2 | No | `POST /members` accepts only a profile that the operator registered. The AG-UI route only observes a conversation and rejects tools, context, and state from a client. |
| 3 | Yes | The operator chooses the model in a profile module. [AI proxy profiles](ai-proxy-profiles.md) route Claude Messages, Codex Responses, and Pi Chat Completions through an operator proxy. An owner can only pick among the profiles that the operator registered. No request field names a model. |
| 4 | Yes | Temporal orders turns. PostgreSQL stores each conversation, its native checkpoint, and its AG-UI history. See [the design](architecture.md) and [bounded conversations](bounded-conversations.md). |
| 5 | Part | A Pi parent can call `delegate_task` to start at most two child workflows. Claude and Codex members have no subagents. |
| 6 | No | Each conversation binds one member. The audit trail documentation names member handoff as a future initiator kind. |

### Tools

| # | Crew | Detail |
| --- | --- | --- |
| 7 | No | Members have no browser and no computer. |
| 8 | No | Claude runs with no built-in tools and no operator MCP servers. Codex runs with its shell off in a read-only workspace. Only the Python documentation pilot writes files, through its Codex author. See [the persistent pilot](persistent-pilot.md). |
| 9 | No | The profile fixes the tools of a member: `record_work_item`, `choose_next_step`, and `delegate_task` for Pi, plus any tools that a trusted application registers in code. Crew has no connector catalogue. Claude and Codex each reach their one profile tool through an MCP server that Crew creates for the invocation. |
| 10 | Part | A backend application can register at most eight tools in code through the trusted context library. No HTTP route registers a tool. See [trusted application context](trusted-application-context.md). A [capability model and a tool-call ledger](member-capabilities.md) exist for Crew-run file, shell and web tools, and no engine uses them yet. |
| 11 | No | The gateway emits run, step, text, tool-call, subagent, and snapshot events. It emits no custom or component events. |
| 12 | No | Codex web search is off. No member has a search tool. |

### Governance

| # | Crew | Detail |
| --- | --- | --- |
| 13 | Yes | A `record_work_item` call opens an approval card. A `choose_next_step` call opens a question. See [the gateway guide](member-gateway.md). |
| 14 | Yes | An owner can answer a card with `allow_conversation` or `allow_always`. A grant matches the tool, not its arguments. A grant never expires by time and never applies to a routine. See [standing grants](standing-grants.md). |
| 15 | No | Crew has no deny rule and no rule language. The eligibility of a grant is fixed in code. |
| 16 | Yes | `GET /v1/audit` returns an append-only trail of 19 event types as JSON or CSV. The only filter is `conversationId`. Refused HTTP calls leave no row. No retention limit and no deletion route exist. See [the audit trail](audit-trail.md). |
| 17 | Yes | Each request admission records an initiator of kind `owner` or `routine`. The audit trail copies the initiator from the admission. |
| 18 | No | Grant matching runs only inside the transaction that records a call. |
| 19 | No | Members have no computer. |
| 20 | No | Provider keys come from environment variables and owner-only files. Native transcripts are plain text in the state directory. |
| 21 | Part | Clients cannot supply tools, context, or instructions. Crew injects project notes and member memory under a header that labels them as reference data. Crew has no classifier and no check of tool arguments. |
| 22 | Part | A Landlock and seccomp launcher confines the Claude and Codex native processes. Pi runs in the worker process. See [verification](verification.md). |

### Work over time

| # | Crew | Detail |
| --- | --- | --- |
| 23 | Yes | An owner creates a routine with a five-field UTC cron schedule. Windows are at least 15 minutes apart. An owner has at most 20 enabled routines. The tenth failure in a row disables a routine. Each firing opens a new conversation. See [scheduled routines](scheduled-routines.md). |
| 24 | No | No webhook, repository, or email event starts a request. |
| 25 | No | A member has no tool that schedules a later turn. Only an owner creates a routine. |
| 26 | Yes | An owner saves at most 32 entries of at most 1,024 bytes for each member. A conversation takes a snapshot of the entries when it opens. The model cannot write memory, and Crew has no search over memory. See [member memory](memories.md). |
| 27 | No | Pi loads no skills, no extensions, and no prompt templates. Claude loads no plugins and no setting sources. Codex runs with plugins off and refuses ambient configuration files. The instruction text of a member is fixed. |
| 28 | No | Crew does not learn from finished conversations. |
| 29 | No | A member acts only on an owner request or a routine firing. |

### Surfaces

| # | Crew | Detail |
| --- | --- | --- |
| 30 | No | Crew is a headless service. The only clients in the repository are two scripts in `clients/`. `observe.mjs` attaches an AG-UI observer, and `resolve.mjs` posts a decision. |
| 31 | No | None. |
| 32 | No | None. |
| 33 | No | None. [The first milestone](first-milestone.md) puts Slack out of scope. |
| 34 | No | A pending card and a finished routine appear only to a client that polls or holds an AG-UI stream open. Crew has no webhook and no push. |
| 35 | No | None. |

### Operations

| # | Crew | Detail |
| --- | --- | --- |
| 36 | Part | The gateway maps static bearer-token digests to owner IDs. Crew has no sign-in provider, no session, no role, and no user management. |
| 37 | Part | The repository builds a service image and an executor image and supports Temporal mTLS. It has no Kubernetes manifest and no Helm chart, and a rolling update is documented as unsafe. See [persistent deployment](persistent-deployment.md) and [the in-cluster executor](in-cluster-executor.md). |
| 38 | Part | Crew exports four trace span names over OTLP. It records no token count and no cost, and it has no spend limit. |
| 39 | Yes | An operator can take a quiesced backup of the whole installation and restore it behind a fence. The procedure stops the whole installation. See [coordinated recovery](coordinated-recovery.md). |
| 40 | Yes | MIT. |

## Notes on the other products

Each list covers the cells that need a qualifier and the features that fit no
row.

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
- **Row 38.** OpenBot records one row for each run with the model name. It
  records no token count and no cost.
- **Row 39.** The desktop app takes a `pg_dump` before an upgrade and restores
  it if the upgrade fails. Nothing takes a backup on demand. The Helm chart
  documentation states that the bundled PostgreSQL has no backups.
- **No row.** An admin can write a rule in English, and a model translates the
  sentence to CEL. An admin can also ask a question of the audit trail in
  English.

### Grok Bot

- **Row 7.** Each user gets one cloud computer. All Bots of that user share its
  files, browser sessions, and command-line credentials. Each Bot has its own
  screen.
- **Row 11.** Pages hold reports, dashboards, and trackers with tables, charts,
  and filters. Pages are still rolling out and are not on Enterprise teams.
- **Row 14.** "Always allow" saves a rule. A user has at most 20 allow rules and
  20 ask-first rules.
- **Row 15.** Users write Custom Rules. Admins write Team Rules. Enterprise
  plans add auto-review rules.
- **Row 16.** Audit logs and Action Recording are for Enterprise plans only.
- **Row 21.** Outside content is marked as untrusted data for the model. Auto
  Review counts only the user's own messages as requests.
- **Row 22.** A Firecracker microVM isolates each user. Nothing isolates the
  Bots of one user from each other.
- **Row 23.** A Bot has at most 50 routines, at least 5 minutes apart.
- **Row 24.** Triggers cover Slack, GitHub, Linear, Sentry, PagerDuty, email,
  and webhooks.
- **Row 28.** "Teach a task" records at most 10 minutes and creates a draft
  skill.
- **Row 30.** No standalone web app. The same Bots are reachable through X Chat
  on x.com.
- **Row 33.** Slack, Microsoft Teams, and X Chat.
- **Row 34.** A Bot sends a system or mobile alert when it finishes or needs
  the user.
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
- **Row 20.** Meta states that the agent uses stored credentials without seeing
  them.
- **Row 21.** Meta describes a model trained to resist injection, outside data
  labelled as untrusted, and a set of injection detectors.
- **Row 27.** Meta ships a set of skills for small businesses. Users cannot
  create a skill.
- **Row 31.** macOS only.
- **Row 33.** WhatsApp only.
- **Row 36.** A Meta account. The sources describe no SSO and no roles.
- **No row.** Spaces are sidebar pages that the agent builds from a chat
  description and keeps current. The agent has its own email address. Purchases
  use a one-time card through Link by Stripe. Press reports that Shop Pay and
  PayPal came later.

### OpenMuse

- **Row 2.** An external AG-UI agent can replace the chat agent, but that agent
  must bring its own tools.
- **Row 5.** The chat agent hands work to a durable server task with a plan.
- **Row 13.** Every email send and every calendar change needs its own stored
  approval.
- **Row 20.** Only the Google OAuth tokens are encrypted.
- **Row 23.** Only recurring watches of public pages. No general cron routine.
- **Row 36.** One owner with one shared access key.
- **No row.** A pipeline fills a PDF form from an email attachment. A tracker
  summarizes a transaction CSV. A watcher alerts on a page change or a price.

### Dots

- **Row 5.** The OpenAI system card states that a Dot often delegates work to
  subagents.
- **Row 6.** People, ChatGPT, Codex, and Dots share context in ChatGPT Space and
  hand work to each other. The sources describe no handoff between two Dots.
- **Row 13.** An auto-review system decides whether an action proceeds or needs
  approval.
- **Row 15.** Users write Custom Rules that allow, block, or require approval.
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
- **Row 16.** Each Dot keeps the latest 1,000 computer actions.
- **Row 20.** MCP tokens are stored in SQLite without encryption.
- **Row 23.** Interval schedules from the UI. No cron.
- **Row 27.** Only the skills that Automatic Learning publishes.
- **No row.** Spaces are editable pages with one conversation for each page and
  each Dot. A voice call runs a speech model beside a separate work agent.

### Duet

- **Row 7.** Duet has its own cloud virtual machine and browser. Anthropic
  states that Duet cannot yet show the user its browser.
- **Row 14.** Some steps accept a "don't ask me again" rule. Payments, transfers,
  deleted orders, and new accounts always ask.
- **Row 20.** The user types a password into an in-app form. The model never
  sees the password.
- **Row 21.** A check of each action runs outside the model. A separate
  classifier looks for sensitive information.
- **Row 23.** Duet sends a daily brief and runs routines while the user is
  away. The user sets what to hear about and how often. No source describes a
  schedule that the user defines.
- **Row 24.** Duet polls connected accounts every few hours. It does not react to
  events.
- **Row 27.** Duet inherits the skills of the Claude account.
- **No row.** Duet sends a brief each morning. Duet can buy items through Link
  or Shop Pay after the user approves. Some actions stay blocked even with
  approval, for example trading securities.

### OpenDuet

- **Rows 2 to 36.** Unless a note here says otherwise, the answer comes from the
  OpenBot code that OpenDuet contains.
- **Row 5.** The `start_task` tool runs larger work in a separate task
  conversation with the same Bot. The result does not return to the calling
  turn. The `run_subagent` tool of OpenBot is not in this copy.
- **Row 31.** The copy includes the OpenBot desktop installer, which is branded
  OpenBot and does not load the OpenDuet package.
- **Row 39.** The copy does not include the upgrade backup of the OpenBot
  desktop app.
- **Row 37.** The supported path is a start script with Docker Compose. OpenDuet
  has no image of its own.
- **No row.** A morning brief. Mail triage into "needs you" and "can wait", with
  an evaluation set of 62 labelled emails. A Tasks tab with suggestion cards. A
  "Make" tab for dashboards, slides, documents, and pages.

## Rows where Crew differs from the group

These lists are counts from the grid. They are not a priority order.

Crew has "No" and at least seven of the eight other products have "Yes" or
"Part":

- 7, a computer or browser for the agent
- 8, shell and file access
- 9, MCP connectors or an app catalogue
- 11, generative UI or rich components
- 12, web research
- 15, policy rules that allow or deny
- 19, a person takes over the agent's computer
- 20, encrypted credential vault
- 24, event triggers or goals
- 25, follow-ups that the agent schedules
- 29, proactive check-ins or suggestions
- 30, web app
- 32, mobile app
- 34, notifications when nobody is watching
- 35, voice

Crew has "Yes" and at most three of the eight other products have "Yes":

- 3, model choice, own key, or base-URL override
- 16, audit trail with filters or export
- 17, record of what started an action
- 39, backup and restore

## Sources

Repositories, read at the commits in the products table:

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

- [OpenAI GPT-6 Astra system card](https://deploymentsafety.openai.com/gpt-6-astra), Appendix B
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

1. Read each repository at its current commit and each hosted product at its
   current documentation.
2. Change the cells, the notes, and the commit or date in the products table.
3. Count the two lists in "Rows where Crew differs from the group" again.
4. When Crew gains a feature, change the Crew cell and the Crew detail line in
   the same commit as the feature.
