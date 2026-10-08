# Claude cloud sessions

GGO prepares repository tasks for Anthropic-hosted Claude Code sessions using
[documented prefilled session links](https://code.claude.com/docs/en/web-quickstart#pre-fill-sessions).
An optional [routine fire API](https://platform.claude.com/docs/en/api/claude-code/routines-fire)
path submits unattended work with different billing. This is an explicit lane under
**Settings > Claude cloud**. It can
also take an interrupted task through **Send to cloud** in its detail controls.
An opted-in lane runs suitable Claude **subtasks** when a subscription is exhausted,
or before a cap when the agent explicitly requests cloud execution. Ordinary parent
tasks continue using local routing.

## Credits and suitable work

Claude's **Cloud session credits** are distinct from subscription prepaid usage and
Anthropic Console API credits. Claude applies eligible promotional credits on the
account starting an eligible web, desktop, CLI or mobile cloud session. Its Usage page shows the remaining balance and expiry;
after exhaustion or expiry, regular plan usage applies. Moving work to this lane can
use the promotional balance rather than the local subscription allowance while that
balance lasts. It does not reduce the tokens the cloud task itself uses.
**Projects and routines are excluded from the promotion**, including API-triggered
routines. They spend regular subscription usage, even while cloud session credits remain.
See [Anthropic's promotion terms](https://support.claude.com/en/articles/17152539-cloud-sessions-bonus-credit-promotion).

Good candidates are documentation, repository review, unit tests, and code changes
that can be verified in a Linux checkout. Keep desktop automation, local database
investigation, device access, local services, and deployment on the local lane.
The operator must confirm that the brief needs only the attached repository and cloud
environment. This is an explicit suitability decision, not an inference model call.

Routine tokens allow submission only: they cannot read balances, transcripts, or
completion state. Subscription usage chips show promotional cloud dollars from the
same profile-token usage read used for banked resets. The profile's organization
must match the subscription's identity; otherwise the chip shows `cloud ?`, never
a guessed zero. The tooltip gives allowance, expiry and read time; expired, locked
and stale balances are distinguished. Cloud dollars are never local quota or
prepaid credit fallback. GGO cannot enforce a credits-only spend ceiling. Check the account's
billing controls and balance at [Claude Usage](https://claude.ai/settings/usage).
GGO neither purchases credits nor changes provider billing settings.

Each subscription has its own grant. If it is not already applied, sign into that
account at [Claude's claim page](https://claude.ai/code/claim-credit/104); eligibility
and claim deadlines are listed in the promotion terms above. To show its balance
in GGO, use **Sign in with Claude** for that subscription in **Settings >
Subscriptions**: open the link, choose that subscription's Claude account, approve,
and paste the code Claude shows. This is GGO's own login session (Claude Code's
manual-code OAuth flow); GGO stores its refresh token and renews the access token
before it expires, so it never touches the CLI's login. A sign-in to a different
account than the subscription runs on is refused. If Claude refuses a renewal, the
login is dropped and the chip asks for a new sign-in. A setup-token alone cannot
read the cloud balance, and a pasted `claudeAiOauth.accessToken`
(`ACCOUNT_<n>_PROFILE_TOKEN`) still works but stops once Claude revokes it,
usually within hours. The sign-in does not change which Claude account the browser
uses to start cloud tasks. Throttled credit reads retry on the next refresh and do
not require a new login; a revoked token is reported as such even though the usage
endpoint answers it with HTTP 429.

## Explicit cloud subtasks

When asked to use cloud credits, agents must set **both** `cloudWork` and
`cloudOnly: true`. A normal Claude subtask runs locally; `cloudWork` alone only
permits automatic cloud fallback after a cap. A cloud-only request uses an enabled,
opted-in subscription with verified promotional credits even before its cap.

For CLI agents, emit one standalone line:

```text
SUBTASK: {"provider":"claude","title":"Review parser","brief":"Read src/parser.ts at the pushed commit and report bounds-checking issues with file references. No edits.","cloudWork":"review","cloudOnly":true}
```

Bus agents call `spawn_subagent` with the same JSON. Use `cloudWork: "change"`
for tested changes on a separate pushed branch. A successful spawn says **Claude
cloud**; the child then records its hosted session link. Check these before reporting
that work was offloaded. Cloud-only admission failures name the prerequisite and
start no local sub-agent. Never remove `cloudOnly` to work around a refusal when the
owner requested cloud execution.

Both paths require an allowed GitHub repository and exact pushed HEAD. Explicit
cloud requests can ignore unrelated pending local files because only the remote
commit is cloned; the brief must not depend on those files. Automatic cap fallback
retains its clean-checkout requirement. All account identity, grant freshness,
opt-in, overage-off, uncertain-session and launch-boundary checks still apply.

## Automatic cloud routing

The **Claude cloud lane** switch pauses new launches without clearing the selected
subscriptions or repositories. **Prefer cloud credits** admits declared eligible
subtasks before a local subscription cap; otherwise automatic routing waits for a
cap. Goal implementors can delegate the same standalone work. Parent tasks retain
local orchestration, review, QA and integration; arbitrary task text is never treated
as proof that a task can run without this machine.

**Stop cloud launches on (UTC)** stops admission at midnight at the start of that
date. A provider grant that expires earlier always wins. Both checks run again at
session creation. A stop date or switch does not terminate an already running VM;
use its Claude session link. Account/repository opt-ins still default empty in a new
installation; the operator's enabled policy belongs in the local database.

Change results record the generated output branch and verify its remote ref before
reporting successful completion. The parent receives that ref and commit for review,
testing and integration through `git-transaction.cjs` and `git-integrate.cjs`.
A missing branch is a review error. The provider's session cost is stored separately
as an estimate, not asserted to equal the debit from promotional funds. Exact cloud
model requests are passed unchanged or refused if absent from the available roster.

1. Open **Settings > Claude cloud > Automatic cloud subtasks**. Enable the
   subscriptions whose promotional credits you want to use, list the allowed
   GitHub repositories (`owner/repository`, one per line), and save. Opt-in is
   stored locally and defaults off. Each account still needs its matching
   profile-scoped login under **Settings > Subscriptions** and GitHub/cloud
   onboarding in Claude. Automatic sessions use this login, independent of the browser.
2. Keep **usage credits** off in Claude for each opted-in account. GGO verifies
   this read-only before every launch; it never changes billing settings. This
   prevents paid overage after promotional funds expire or run out. Remaining
   regular plan usage may still apply; there is no provider credits-only stop switch.
3. Agents declare standalone suitable work using `cloudWork: "review"` (read-only
   findings) or `cloudWork: "change"` (changes on a separate branch) in a Claude
   subtask. This declaration means no parent transcript, local services, private
   files, credentials, attachments, deployments or unfinished local changes are
   needed. The same field works in `spawn_subagent` and the CLI `SUBTASK` bridge.
   Without **Prefer cloud credits**, GGO chooses cloud automatically only after an
   enabled subscription hits its actual cap; safety reserves or soft thresholds
   alone do not qualify.
4. Before starting, GGO refreshes the matching account's balance and billing
   status, refuses zero/expired/locked/stale/unreadable grants, and verifies that
   the repository is allowed, clean and pushed. It prepares a shallow temporary
   checkout at that exact pushed commit. The original checkout, local credentials,
   attachments and memory are not uploaded. A subtask that caps mid-run can switch
   if its original standalone brief and the current pushed state still qualify.
5. GGO creates a normal hosted session through the OAuth session protocol used
   by Claude Code 2.1.292 and waits for its authenticated worker result event.
   The remote clones the exact verified commit, using the account's active Default
   Anthropic cloud environment (or its first active hosted environment). Review
   tasks disable shell and editing tools; change tasks get a separate push branch.
   Every session uses auto permission mode, a 40-turn limit and an estimated
   budget ceiling of the smaller of $5 or the admitted promotional balance.
   Immediately before creation, GGO rechecks the lane switch and stop date, opt-in,
   subscription enablement, account identity and login, cap state when required,
   and the fresh promotional balance.
   GGO records a run and session link durably.
   The child settles for review; the normal subtask barrier delivers the report
   to the spawning agent once. That agent must review and integrate any returned
   branch before claiming its own task complete. No automatic merge or deployment.

One cloud observer per subscription runs at a time. An automatic fallback admission
failure explains why and follows ordinary local subtask routing; an explicit
`cloudOnly` request refuses instead. A submitted but uncertain session never silently
falls back to another billed run. Timeout, interruption, network failure or restart
retains its record and link and requires checking Claude before creating another
independent subtask. Cloud children have **Open cloud session** in place of local Resume/Retry/review
controls. These actions are also refused server-side; review the returned work in
the parent task. Resume does not submit a duplicate. **Interrupt** stops GGO's
observer, and cancelling a parent cancels its child observation, but the remote VM
can keep running. Use the Claude session link to steer or stop it. GGO does not
forward owner messages into a cloud session; it directs you to that link.
An uncertain job also holds further automatic work on its subscription. After
checking the remote outcome and stopping unfinished work, click **I checked this
cloud session** to release that account for independent new subtasks. Its original
record remains, so acknowledging it does not permit a duplicate of the same task.
A launch that stops before GGO sends the session-create request (opt-in revoked,
interrupted, no active cloud environment, or a failed environment read) cannot have
started remote work. GGO records it as already checked, so it does not hold the account.

The installed CLI 2.1.292 rejects new-session `-p --cloud` and requires an interactive
terminal for creation. GGO therefore uses its observed OAuth session protocol;
this is an undocumented provider interface, and a provider change can require an
adapter update. There is no API-key fallback. The provider applies the promotional
grant; the launcher is a cloud session, never a routine, project or remote-control run.

## Start an eligible cloud session

1. In **Settings > Claude cloud**, keep the default **Cloud session** dispatch method.
   A routine or token is not required. For a paused local task, use **Send to cloud**;
   its title and brief are prefilled.
2. Enter the GitHub `owner/repository`, title and brief, and confirm cloud suitability.
3. Click **Open credit-eligible cloud session**. GGO opens the official Claude Code
   form with the repository and task prefilled. Sign into the account holding the
   credits, verify the repository, branch, model and cloud environment, then start
   the task in Claude. Opening the form alone does not start work.
4. For briefs whose encoded URL exceeds 8,000 characters, use **Copy cloud brief**,
   open the form, and paste the brief before starting. The brief in a prefilled URL
   may remain in browser history; avoid including sensitive information.
5. Monitor and review in Claude. GGO does not receive a session ID or track submission
   for this browser handoff. The original local task stays paused; opening the form
   again can create another independent session, so check Claude before repeating.

Only the edited brief and repository selection are sent. Local transcripts, memory,
attachments and credentials are not included. GitHub must already be connected to
Claude; select the branch containing any prerequisite commits you pushed.

## Connect a routine (regular usage)

1. Sign into the Claude account whose regular usage should fund the runs and open
   [Claude routines](https://claude.ai/code/routines).
2. Create a routine, attach one GitHub repository, and configure its cloud environment
   and base branch. Repository access must be connected in Claude. Select the model
   in the routine itself; GGO does not change it.
3. Copy the saved instructions shown in GGO's connection panel into the routine.
   They explicitly authorize execution of the `routine-fire-payload` brief; without
   that instruction Claude treats the submitted text as untrusted context. The
   instructions request a new branch and pull request, with no merging or deployment.
4. Add an **API** trigger, save the routine, and generate its token. No recurring
   schedule is required. Paste the fire URL or `trig_` ID and bearer token into GGO.
5. Give the connection an account label and the matching `owner/repository`. One
   connection represents one routine and repository; multiple connections can use
   different accounts. Tokens stay in the local, ignored database and never appear
   in API responses. Saving or editing a connection does not start a job.

The public API does not create routines or generate tokens. Those operations require
Claude's authenticated web UI. Follow
[Anthropic's setup guide](https://code.claude.com/docs/en/routines#add-an-api-trigger).
Routine model, environment, repositories and connectors remain configured there.
Changing GGO's repository label does not change the routine's attached repository.

## Dispatch and review

For direct API dispatch, choose **Routine API** (not eligible for promotional credits).
Enter a title and brief, select the routine, confirm cloud suitability, and click
**Start in Claude cloud**. Each submission creates an independent session and survives
GGO shutdown. GGO retains the newest 100 submission records, including the account
label, repository, timestamp and session link. **Submitted** proves only that Claude
accepted a session; it does not mean the task finished.

To offload a local task, interrupt it first. Only a paused task with no active agent
can be sent; model-pinned tasks and special read/subtask lanes use a separate new
cloud brief instead. The server checks the task's GitHub origin against the chosen
connection and rejects a repository mismatch. It sends the editable brief only, not
the local transcript, memory, attachments, credentials or checkout. Cloud starts from
the routine's configured branch, so push any prerequisite commits first. The original
task remains paused. Reopening **Send to cloud** shows its saved submission link.

Open the Claude session to watch progress, send follow-ups, answer questions or stop
it. Review its branch or pull request before integrating or resuming local work.
GGO does not auto-merge results, stream cloud output into the task feed, declare jobs
complete, or stop a cloud session when the original local task is cancelled.

A timeout, server error, malformed success response, or GGO restart during a request
leaves an **uncertain** record. The provider may have accepted the task already:
check Claude's session list before retrying. GGO never retries these automatically.
An existing nonfailed submission blocks another offload of the same local task.
Cloud API authentication and hourly limits are independent of GGO's local account
routing; a submission failure never silently starts a local or API-billed agent.

## Verification

`npm run test:cloud-sessions --prefix server` uses a fake provider to exercise
authentication, endpoint validation, token redaction, dispatch, duplicate protection,
restart recovery and ambiguous failures without spending credits.
`npm run test:cloud-subtasks --prefix server` exercises real task dispatch,
cap-triggered and mid-run admission, refreshed identity/billing checks, result
delivery and parent review, interruption and duplicate protection with fake session/git leaves.
It also exercises the real session adapter with fake HTTP responses: exact-commit
creation, hosted environment selection, separate push branches, worker-only completion,
budget failure and a lost create response that must never be retried.
`npm run cloud-sessions-lab --prefix server` drives the real console in an isolated
desktop and phone browser with a stubbed cloud API. Live promotional credit
consumption requires an eligible hosted cloud session and a before/after
provider balance read; the local gate does not prove it. Routines cannot prove
promotional credit consumption because they are excluded from the promotion.

A deploy does not enable the automatic lane; its opt-in lives in the local database.
To check it headlessly after logging in, read `automatic` from `GET /api/cloud-sessions`
(`enabled`, `preferCloud`, `stopAt`, `accountIds`, `repositories`, per-account
`enabled`/`ready`, `jobs`). `ready` accounts for policy, verified credits and any cap
requirement. `PUT /api/cloud-sessions/automatic` with
`{"accountIds": [...], "repositories": ["owner/repository"]}` replaces the whole policy.

The account and repository lists are replaced; omitted switch, preference and stop
date fields retain their prior values. `stopAt` is a UTC Unix timestamp in milliseconds
or `null` to remove the operator deadline.

## Research checked 2026-10-08

- [Claude's cloud documentation](https://code.claude.com/docs/en/claude-code-on-the-web)
  documents `--cloud` creation and `-p --cloud <session-id>` follow-up messages.
  Follow-ups queue a message and return a session link, not the completed task.
  Remote Control runs on the local machine and is a different execution path.
- [The CLI reference](https://code.claude.com/docs/en/cli-reference) and local
  `claude --help` agree on `--cloud` and `--teleport`. The checked native CLI was
  2.1.280; the installed Agent SDK was 0.3.293. These may differ from the CLI build
  used to establish the existing adapter protocol.
- [The Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)
  describes a process hosted by the application. Its local session APIs are not
  a documented launcher for promotional Claude Code cloud sessions.
- [The routine API](https://platform.claude.com/docs/en/api/claude-code/routines-fire)
  uses routine-specific credentials and regular subscription usage.
  [Promotion terms](https://support.claude.com/en/articles/17152539-cloud-sessions-bonus-credit-promotion)
  exclude projects and routines. Cloud credits are distinct from Console API credits;
  read the actual grant expiry rather than assuming a campaign-wide date.
- [Anthropic's changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)
  records ongoing cloud/session fixes. GGO's observed OAuth create/poll protocol is
  not a stable public API; real hosted verification remains necessary after changes.

Live hosted smoke tests also exercised automatic subtask admission with a simulated
local cap in an isolated GGO database. Both subscriptions returned repository
command findings through the real run/report path, and a before/after provider
read confirmed promotional credit consumption. Production caps were not altered.
