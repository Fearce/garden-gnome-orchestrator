# Claude cloud sessions

GGO prepares repository tasks for Anthropic-hosted Claude Code sessions using
[documented prefilled session links](https://code.claude.com/docs/en/web-quickstart#pre-fill-sessions).
An optional [routine fire API](https://platform.claude.com/docs/en/api/claude-code/routines-fire)
path submits unattended work with different billing. This is an explicit lane under
**Settings > Claude cloud**. It can
also take an interrupted task through **Send to cloud** in its detail controls.
An opted-in automatic lane runs suitable Claude **subtasks** when a subscription
is exhausted. Ordinary parent tasks continue using local routing.

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
in GGO, add that account's current profile-scoped login token in **Settings >
Subscriptions**. The token must belong to that subscription; an expired token
requires replacement and shows an unknown balance until a successful read. A
setup-token alone cannot read the cloud balance. Connecting the profile token
does not change which Claude account the browser uses to start cloud tasks.
Throttled credit reads retry on the next refresh and do not require a new login.

## Automatic subtasks after a Claude cap

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
   GGO chooses cloud automatically only after an enabled subscription hits its
   actual cap; safety reserves or soft thresholds alone do not qualify.
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
   Immediately before creation, GGO rechecks opt-in, subscription enablement,
   account identity and login, cap state, and the fresh promotional balance.
   GGO records a run and session link durably.
   The child settles for review; the normal subtask barrier delivers the report
   to the spawning agent once. That agent must review and integrate any returned
   branch before claiming its own task complete. No automatic merge or deployment.

One cloud observer per subscription runs at a time. A failed admission follows
ordinary local subtask routing; a submitted but uncertain session never silently
falls back to another billed run. Timeout, interruption, network failure or restart
retains its record and link and requires checking Claude before creating another
independent subtask. Resume does not submit a duplicate. **Interrupt** stops GGO's
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

Live hosted smoke tests also exercised automatic subtask admission with a simulated
local cap in an isolated GGO database. Both subscriptions returned repository
command findings through the real run/report path, and a before/after provider
read confirmed promotional credit consumption. Production caps were not altered.
