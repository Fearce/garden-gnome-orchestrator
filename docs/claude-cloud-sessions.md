# Claude cloud sessions

GGO prepares repository tasks for Anthropic-hosted Claude Code sessions using
[documented prefilled session links](https://code.claude.com/docs/en/web-quickstart#pre-fill-sessions).
An optional [routine fire API](https://platform.claude.com/docs/en/api/claude-code/routines-fire)
path submits unattended work with different billing. This is an explicit lane under
**Settings > Claude cloud**. It can
also take an interrupted task through **Send to cloud** in its detail controls.
Normal local tasks and provider fallback do not select cloud automatically.

## Credits and suitable work

Claude's **Cloud session credits** are distinct from subscription prepaid usage and
Anthropic Console API credits. Claude applies eligible promotional credits on the
account starting an interactive cloud session. Its Usage page shows the remaining balance and expiry;
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
completion state. GGO cannot enforce a credits-only spend ceiling. Check the account's
billing controls and balance at [Claude Usage](https://claude.ai/settings/usage).
GGO neither purchases credits nor changes provider billing settings.

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
`npm run cloud-sessions-lab --prefix server` drives the real console in an isolated
desktop and phone browser with a stubbed cloud API. Live credit consumption requires
a configured routine and a real cloud session; the local gate does not prove it.
