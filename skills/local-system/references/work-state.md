# Work state for long local tasks

Use this procedure only after `SKILL.md` routes here for substantial, interruptible, or resumable Local System work.

## Decide whether tracking is useful

Create a working record only when it will materially reduce reconstruction or execution errors. Typical signals include:

- Multiple independently verifiable stages or changes spanning several files.
- Long-running processes, builds, renders, or generations.
- Decisions or evidence accumulated from several sources.
- A likely pause, handoff, interruption, or later resumption.

Do not create a record for a straightforward bounded task when the conversation and current tool state are sufficient.

## Choose the correct location

Use a native session workspace only when the host exposes one that is distinct from Local System. If none is available, rely on conversation and tool state unless a local process must consume the record or the user requests a durable artifact.

Place a tracking file in the user's repository only when the user requests it or an existing project convention requires it. Never assume that the native session workspace and Local System share files or that session storage will survive beyond the current session.

## Choose the smallest useful artifact

Start with at most one artifact:

- `tasks.md` for the objective and completed, active, and remaining work.
- `implementation-plan.md` when dependencies, migrations, or multiple validation stages require a structured plan.
- `research-notes.md` when findings from several sources must be reconciled before acting.
- `walkthrough.md` only when a user-reviewable completion artifact was requested or is required by project convention.

Split the record only when different information has distinct consumers or lifecycles. Do not create all four files by default.

## Record operational facts

Keep only information that helps the next action:

- Objective, scope, and constraints.
- Verified workspace and relevant paths.
- Completed, active, and remaining steps.
- Decisions and the evidence that affects implementation.
- Validation performed and its result.
- Blockers, required authority, and the next actionable step.

Mark assumptions that must be reverified. Summarize relevant results instead of copying large logs or tool output.

## Update and resume

Update the record after meaningful milestones, changed decisions, validation results, blockers, and before an expected pause or handoff. Do not update it after every command.

On resumption:

1. Read the working record.
2. Reverify bridge availability, the intended workspace, relevant files, repository status, and managed processes as needed.
3. Reconcile stale assumptions or external changes with the recorded state.
4. Continue from the next verified action rather than replaying completed work.

Treat the record as context, not proof of current local state.

## Complete the work

Record the final outcome, validation evidence, and any unresolved blocker or uncertainty. Stop maintaining the record when it no longer improves execution. If state must persist beyond the session, use only an appropriate user-authorized durable mechanism or an existing project convention.
