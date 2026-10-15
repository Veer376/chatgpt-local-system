# Long-Running ChatGPT Turns and Reliable Subagents

Status: design notes only. Build order is intentionally undecided.

## Problem

Long ChatGPT tool-using turns eventually lose tool access and are forced to return to the user. The system should hand work off before that boundary and resume in a fresh turn without losing progress or duplicating writes.

Subagents have a related reliability problem: today too much of their identity and lifecycle is coupled to temporary Chrome tabs and browser execution state.

## What we verified

### Current ChatGPT web adapter

The production `browser-owned` transport really does drive ChatGPT through Chrome:

- creates or reuses a background ChatGPT tab;
- navigates to `/c/<conversation-id>` for continuation;
- attaches CDP/debugger;
- finds and focuses the composer;
- inserts text;
- clicks the native Send button, with Enter as fallback;
- observes the conversation request and then performs canonical readback.

This works, but it has a large browser/UI failure surface and is heavier than Local System needs for the user's already-open ChatGPT thread.

### Direct ChatGPT web requests

The adapter already contains an experimental direct-request transport. Current writes involve a protected sequence around:

1. Sentinel prepare/finalize;
2. fresh per-turn challenge/protection material;
3. conversation prepare;
4. conduit/one-shot write material;
5. final conversation write;
6. canonical completion/readback.

Authenticated direct requests are therefore not just a normal `POST /conversation`. A live adapter test reached a protection boundary requiring browser-bound proof/Turnstile/PoW-style evidence and correctly stopped before mutation.

Public projects have reverse-engineered substantial parts of this private protocol and some currently expose ChatGPT-web as an API. Important examples found during research include `gpt2agent`, `Conduit`, `ChatGPT-Web2API`, and older reverse-ChatGPT projects. The practical pattern is consistent: direct REST can work, but it is tightly coupled to undocumented protection/protocol changes. Even current projects commonly retain real Chrome as the reliability fallback.

Conclusion: direct web requests are worth treating as an optional transport, not as the durable job/state layer.

## Existing subagent strengths and weakness

The current subagent implementation already has several good reliability primitives:

- request and batch IDs;
- heartbeat/progress persistence;
- result ledger;
- reconciliation when a write may already have been submitted;
- no blind replay of ambiguous writes;
- recovery after extension-worker failure;
- cleanup tracking.

The main weakness is architectural: a subagent is still too closely tied to a disposable browser worker/tab. Multiple logical workers also create multiple browser/debugger lifecycles and additional interference/failure surfaces.

## Proposed durable model

A subagent should be a durable actor, not a Chrome tab.

```text
Agent Job
  job_id
  conversation_id
  goal
  todos
  checkpoint
  current_turn
  last_heartbeat
  last_submitted_message
  next_action
  status
```

The browser becomes only one transport used by that actor.

```text
Local System daemon
      |
      v
Durable job scheduler
      |
      +--> Agent A / conversation A
      +--> Agent B / conversation B
      +--> Agent C / conversation C
      |
      v
serialized ChatGPT-web writer
      |
      v
browser transport / future direct transport / API transport
```

## Controlled long-turn handoff

Do not wait for ChatGPT's hard execution boundary.

Candidate lease:

```text
0m ---------------- 18-20m -------- 21-22m
normal work          soft warning    checkpoint + handoff
```

At the handoff boundary:

1. stop starting new work;
2. persist checkpoint and current todos;
3. let the current turn return a concise progress checkpoint;
4. Local System records that the stop was an intentional lease handoff;
5. if the goal/todos are still incomplete and no human blocker exists, submit a continuation into the same conversation;
6. the fresh ChatGPT turn resumes from the durable checkpoint.

The same mechanism should apply to the main thread and subagents.

## Exactly-once write rule

Before every ChatGPT mutation, persist a durable receipt such as:

```text
PREPARED -> SUBMITTING -> SUBMITTED -> COMPLETED
```

If a process dies after submission becomes ambiguous, never automatically resend. First reconcile against the conversation record. Only retry after proving that the prior write did not land.

This rule should be central to the architecture, not only an error-recovery feature.

## Transport direction

For the main user's thread, the strongest near-term path is the existing visible ChatGPT tab. Local System already knows the tab/thread, so no separate runtime tab is needed. The minimal browser action is simply to submit the continuation through the existing ChatGPT page after the prior turn has ended.

For subagents, prefer durable conversation IDs plus a shared/serialized ChatGPT-web writer rather than making each logical agent depend on its own long-lived browser worker.

Future transport abstraction:

```text
send_turn(job, conversation)
  - BrowserTransport      # reliable baseline
  - DirectWebTransport    # experimental/private protocol
  - OfficialAPITransport  # clean parallel worker path where suitable
```

Durable job state must remain independent of whichever transport is used.

## Still undecided

- Which piece to implement first.
- Exact handoff thresholds after real timing telemetry.
- Whether direct ChatGPT-web transport is worth promoting beyond experimental use.
- How much true parallelism to allow on one ChatGPT account versus serializing web writes.
- Whether to research ChatGPT's internal page-level send dispatcher as a middle layer between DOM clicking and fully direct HTTP.

