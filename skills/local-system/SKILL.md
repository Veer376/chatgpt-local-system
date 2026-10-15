---
name: local-system
description: Always refer to this skill when working on the user's computer using Local System. **non-negotiable**
---

# Local System

Use Local System for work that must inspect, affect, or be consumed by the user's computer. This skill is the execution contract for that work. Base claims about local files, commands, processes, workspaces, and connection state on current tool evidence, and combine it with other available capabilities when useful.

## Discover Local System plugin

The skill provides guidance, the plugin exposes tools, and the bridge executes them. A loaded skill, plugin mention, or prior state does not prove availability. When tools are missing, discover the exact plugin before reporting it unavailable; only a successful tool call proves bridge reachability.

## Orient before acting

Call `bridge_context` before the first local action of every turn, including each follow-up in a thread you are already working in. It returns the selected project, project instructions and skills, platform, daily `localScratchDir`, open todo summary, and the few execution rules needed before acting. Read those values from it rather than carrying forward what an earlier turn saw.

Search `discover_skills` before assembling a capability by hand, since a skill may already own the procedure. Read the selected `SKILL.md` and every reference it names before acting on it.

## Ground the task in the correct workspace

- Open the intended project with `workspace` before project work. Prefer an exact supplied path; otherwise use a matching saved project from `workspace` action `list`. Saved projects are shortcuts, not access grants or an exhaustive directory list. If the target remains ambiguous, inspect only the smallest authorized area or ask.
- Use `execute_command` for the smallest necessary inspection of project structure, repository state, metadata, and applicable instructions. Re-check relevant state when resuming.
- Authorized project roots are the access boundary. If a target is outside them, explain the limitation and ask the user to authorize it or move or copy the required files. Continue independent in-scope work where possible.

## Choose the working context

Choose each file and command by its dependencies and ownership:

- When available, use a native temporary or session workspace for agent-owned work that does not need the user's computer.
- Use the full daily `localScratchDir` returned by `bridge_context` for temporary files and operations that need the user's computer but do not belong to a project. The bridge creates it automatically; use the returned path rather than constructing a dated path yourself.
- Use the intended project workspace only for files and commands that inspect, modify, test, build, or serve that project.

For non-project local work, pass `localScratchDir` as `cwd`; do not open or save scratch as a project. Place final artifacts at their intended authorized destination, keep agent-owned intermediates out of user projects, and never assume the native session workspace and Local System share files.

For images needed in a Local System workflow, use a tool that writes directly to an authorized local path. Do not use the your internal image-gen tool; its sandboxed output cannot be transferred reliably into Local System.

## Determine the authorized outcome

- For answer, explain, inspect, summarize, review, diagnose, or plan requests, perform relevant read-only investigation and report the result. Do not make persistent changes unless the user also requests them.
- For create, change, build, fix, configure, or implement requests, make the requested in-scope workspace changes and run relevant non-destructive validation.
- Treat deletion, irreversible overwrite, publication, deployment, messaging, purchases, credential or permission changes, and material scope expansion as separate consequential actions requiring clear authorization.
- Do not turn a narrow request into adjacent cleanup, refactoring, deployment, or account changes merely because they may be useful.

Once the direction is clear, carry it through: gather context, plan, implement, verify, and refine without waiting for further prompting. Make reasonable, reversible assumptions when evidence supports them. Ask the user when a missing choice would materially change the result, target, cost, privacy, or reversibility.

## Execute and verify

Inspect the smallest relevant current state, perform authorized work, examine results, adapt, and verify before claiming completion. Stop investigating when sufficient evidence supports the next decision or answers the request. Use a short plan only for multi-step work.

Use tools by role:

- Use `execute_command` for inspection, search, repository state, builds, tests, and other commands.
- Use `apply_patch` for ordinary text-file creation and edits.
- Read a file's contents with `execute_command`, and inspect image pixels with `view_image`. Use `show_file` only to put a file in front of the user: it displays the file and returns nothing you can read, so it never substitutes for reading one.
- A command that produces an image returns it inline, so do not follow a screenshot or a render with a separate `view_image` call. In a script you write, announce the file by printing `@@image <absolute path>` on its own line, on either stream.
- When several independent reads are required, batch them in one `execute_command` when practical, and issue independent tool calls together rather than one at a time. Read the full relevant file or section when surrounding context affects correctness.
- Use `request_user_input` only when human attention is genuinely useful or required, never for anything a tool call would establish. It can present one rich visual content block, ask one structured question, or do both; use it for decisions, review, approval, login walls, one-time codes, CAPTCHAs, OS permission dialogs, or a device the user must connect. Before requesting input, check whether a command, file, or `bridge_context` already answers the need. Ask only the single question needed to unblock the next action, continue from the response, and request input again later only if another question becomes necessary.

### Run work that outlives a single call

`execute_command` waits briefly and then hands back a running `taskId`. For anything that will not finish in that window — a server, a long build, a full test suite — raise `waitMs`, or pass `waitMs: 0` to take the task id immediately and keep working. Once a command has returned a running `taskId`, continue through `manage_task`: `status` to read progress, `send_input` to answer a prompt it is waiting on, `kill` to stop it, `list` to recover ids you lost. Never rerun the command instead; that leaves two copies running and competing for the same port, lock, or output path.

A command judged destructive pauses for the user's approval before it runs. That pause is expected, not a hang. If approval comes back denied, redirected, or timed out, follow the instruction in the result and do not reissue the same command hoping for a different answer.

Never claim that a file was changed, command succeeded, process started, test passed, or artifact exists without current tool evidence. Do not invent paths, outputs, errors, IDs, or completion.

## Track substantial work

For substantial multi-step work, use `write_todos` for current-conversation progress: keep exactly one item `in_progress`, mark items complete as they finish, and end the turn with every item completed, cancelled, or explicitly deferred. For interruptible work needing a richer record, follow [Work state for long local tasks](references/work-state.md). Skip tracking for straightforward tasks.

## Validate and recover

After a change, run the most relevant available validation, such as targeted tests, a type or lint check, an affected build, a focused smoke test, dry-run or a read-back of changed state. If validation cannot run, explain why and state the next-best check.

Read failures precisely. Correct invalid arguments, use a safe alternative when justified, and avoid repeating completed work. Ask the user only when progress requires missing information, credentials, authority, external state, or an irreversible decision.

Retry transient read-only failures at most twice. Do not blindly retry writes or other non-idempotent actions. Before retrying a timed-out generation, build, or render, check whether its expected output was already produced and rerun only when the operation is incomplete and the retry is safe.

## Communicate progress and completion

During long work, communicate meaningful progress or changes briefly. Give a recap when requested or needed for a decision.

Lead the final response with the outcome, evidence, and any remaining blocker or uncertainty.
