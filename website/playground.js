/* Local System interactive tour. Every interaction uses fixed sample data.
   No network requests, filesystem access, command execution or real ChatGPT integration. */
(() => {
  "use strict";

  const prompts = {
    approval: "Clean up old build artifacts",
    preview: "Open README.md and annotate the headline",
    attach: "Review src/server.js using my code-review skill",
    tasks: "Run the test suite and summarize the results",
    tools: "Show me what the 11 Local System tools can do"
  };
  const tools = {
    bridge_context: "Find the active bridge and connected-workspace context.",
    workspace: "List, save or choose a local project workspace.",
    execute_command: "Run a command with the configured local authority.",
    apply_patch: "Review and apply a precise file change.",
    display: "Show a supported local document or artifact.",
    view_image: "Inspect a local image or screenshots.",
    manage_task: "Check progress and control a managed task.",
    request_user_input: "Request a human decision or extra information.",
    write_todos: "Update the conversation's task checklist.",
    runtime_memory: "Read or write temporary, scoped working context.",
    discover_skills: "Discover and inspect locally available skills."
  };

  const root = document.getElementById("playground");
  const thread = document.getElementById("demo-thread");
  const inspector = document.getElementById("inspector-content");
  const inspectorTitle = document.getElementById("inspector-title");
  const inspectorFooter = document.getElementById("inspector-footer");
  const promptInput = document.getElementById("demo-prompt");
  const form = document.getElementById("demo-form");
  const suggestions = document.querySelector(".demo-suggestions");
  const tabs = [...document.querySelectorAll(".demo-tab")];
  const rows = [...document.querySelectorAll("#hero-listing .terminal-row")];
  const terminalInput = document.getElementById("terminal-filter");
  const terminalEmpty = document.getElementById("terminal-empty");
  const motionReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let current = "approval";
  let taskTimer = null;
  let taskStep = 0;
  let demoAttachments = new Set();
  let activeRow = 0;
  let lastHover = false;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function message(text, kind = "assistant") {
    const container = el("div", kind === "user" ? "demo-bubble demo-user" : "demo-message");
    if (kind !== "user") container.append(el("span", "assistant-identity mono", "LOCAL SYSTEM · SCRIPTED DEMO"));
    container.append(el("p", "", text));
    thread.append(container);
    thread.scrollTop = thread.scrollHeight;
    return container;
  }
  function resetThread(request, explanation) {
    thread.replaceChildren();
    message(request, "user");
    message(explanation);
  }
  function setInspector(heading, content) {
    inspectorTitle.textContent = heading;
    inspector.innerHTML = content;
    inspectorFooter.textContent = "SAMPLE DATA · NO HOST ACCESS";
  }
  function stopTask() {
    if (taskTimer !== null) window.clearInterval(taskTimer);
    taskTimer = null;
  }
  function setActiveDemo(id, options = {}) {
    if (!prompts[id]) return;
    stopTask();
    current = id;
    demoAttachments = new Set();
    promptInput.value = prompts[id];
    tabs.forEach(tab => {
      const selected = tab.dataset.demo === id;
      tab.classList.toggle("is-selected", selected);
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
    });
    document.querySelectorAll(".demo-file").forEach(btn => btn.classList.toggle("is-active", btn.dataset.demo === id));
    suggestions.replaceChildren();
    suggestions.append(el("span", "", "TRY →"));
    const examples = {
      approval: ["Why approval?", "What changes?"],
      preview: ["Add a note", "Open README.md"],
      attach: ["Attach file", "Attach skill"],
      tasks: ["Run tests", "Show task status"],
      tools: ["List all tools", "What requires approval?"]
    };
    examples[id].forEach(label => {
      const b = el("button", "", label);
      b.type = "button";
      b.dataset.suggest = label;
      suggestions.append(b);
    });

    if (id === "approval") {
      resetThread("Clean up old build artifacts", "That command would remove files. Approval is required before this classified destructive action.");
      const card = el("div", "demo-approval");
      card.innerHTML = '<div class="demo-approval-title">Human approval required</div><code>rm -rf dist/</code><p>Sample operation. No files are deleted by this demo.</p><div class="approval-actions"><button type="button" data-decision="deny">Deny</button><button type="button" data-decision="approve">Approve example</button></div>';
      thread.append(card);
      setInspector("operation / approval", '<div class="inspector-eyebrow mono">HUMAN-IN-THE-LOOP</div><h3>Know before it runs.</h3><p>A classified destructive command pauses and waits for a decision.</p><pre class="inspector-code">rm -rf dist/</pre><div class="inspector-note">This simulation does not run shell commands. Real approval rules are not an OS sandbox.</div>');
    } else if (id === "preview") {
      resetThread("Open README.md and let me leave a note", "README.md is open in the sample workspace. Highlighted text is ready for feedback.");
      setInspector("README.md / preview", '<div class="inspector-eyebrow mono">RENDERED MARKDOWN · SAMPLE</div><div class="preview-paper"><small>README.md</small><h4>Bring your computer into ChatGPT.</h4><p><mark>Review this headline</mark> and attach contextual feedback.</p></div><form class="demo-note" id="annotation-form"><label for="annotation-input">Annotation on selected headline</label><textarea id="annotation-input" maxlength="250">Make the opening clearer and shorter.</textarea><button type="submit" class="inspector-action">Send annotation ↗</button></form>');
    } else if (id === "attach") {
      resetThread("Review a local file with a code-review skill", "Select sample files and skills on the right. Attachments will appear inside the conversation.");
      setInspector("composer / context", '<div class="inspector-eyebrow mono">PICKER · SAMPLE CONTENT</div><h3>Attach without copy/paste.</h3><p>Choose example context objects below.</p><div class="tool-catalog"><button type="button" data-attach="@@ src/server.js">@@ src/server.js</button><button type="button" data-attach="@@ README.md">@@ README.md</button><button type="button" data-attach="// code-review">// code-review</button><button type="button" data-attach="// add-tests">// add-tests</button></div><div class="inspector-note">The real extension attaches selected files and registered SKILL.md instructions through ChatGPT.</div>');
    } else if (id === "tasks") {
      resetThread("Run tests on the example project", "This sample task has not started. Send the prompt to watch the progress update.");
      setInspector("task / status", '<div class="inspector-eyebrow mono">MANAGED TASK · SIMULATED</div><h3>Watch work continue.</h3><p id="task-label">Ready to run sample tests.</p><div class="task-progress"><span id="task-progress-fill"></span></div><div class="task-history" id="task-history"><div>Awaiting prompt</div></div><button type="button" class="inspector-action" id="cancel-task" disabled>Cancel demo task</button>');
    } else {
      resetThread("Show me which Local System tools are available", "The bridge exposes a fixed set of 11 tools. Select one on the right to inspect what it does.");
      setInspector("mcp / tool contract", '<div class="inspector-eyebrow mono">11-TOOL CONTRACT</div><h3>Inspectable by design.</h3><p>These are actual public tool names; all descriptions are sample documentation.</p><div class="tool-catalog" id="tool-catalog"></div><p class="inspector-note" id="tool-description">Select a tool to see its purpose.</p>');
      const catalog = inspector.querySelector("#tool-catalog");
      Object.keys(tools).forEach(name => {
        const b = el("button", "", name);
        b.type = "button";
        b.dataset.tool = name;
        catalog.append(b);
      });
    }
    thread.scrollTop = 0;
    if (options.focus) promptInput.focus();
  }

  function inferDemo(query) {
    if (/annotat|preview|markdown|readme|image|video|pdf|screenshot/i.test(query)) return "preview";
    if (/remove|delete|clean|danger|approval|permission|risky/i.test(query)) return "approval";
    if (/test|task|progress|background|run suite|job/i.test(query)) return "tasks";
    if (/skill|attach|@@|\/\/|file|review/i.test(query)) return "attach";
    if (/tools?|mcp|contract/i.test(query)) return "tools";
    return current;
  }

  function runPrompt(query) {
    if (!query) return;
    const target = inferDemo(query);
    if (target !== current) setActiveDemo(target);
    message(query, "user");
    if (target === "approval") {
      message("This example requires approval. Choose Approve or Deny in the request card; the website cannot delete files.");
      if (!thread.querySelector(".demo-approval")) {
        const card = el("div", "demo-approval");
        card.innerHTML = '<div class="demo-approval-title">Approval required</div><code>rm -rf dist/</code><p>Simulated operation. No real command runs.</p><div class="approval-actions"><button type="button" data-decision="deny">Deny</button><button type="button" data-decision="approve">Approve example</button></div>';
        thread.append(card);
      }
    } else if (target === "preview") {
      message("The sample README is open on the right. Edit its annotation and press Send annotation to see feedback return to the chat.");
    } else if (target === "attach") {
      message(demoAttachments.size ? "Sample context selected: " + [...demoAttachments].join(", ") + ". A real installation sends selected content to ChatGPT." : "Pick a sample file and skill from the right-side panel to demonstrate composer attachments.");
    } else if (target === "tasks") {
      startTask();
    } else {
      message("Select a named tool in the inspector to inspect its purpose. This is a reference tour; no tool will execute.");
    }
    thread.scrollTop = thread.scrollHeight;
  }

  function startTask() {
    stopTask();
    taskStep = 0;
    const names = ["Resolve project workspace", "Start targeted checks", "Read test output", "Prepare summary", "Done"];
    const progress = inspector.querySelector("#task-progress-fill");
    const label = inspector.querySelector("#task-label");
    const history = inspector.querySelector("#task-history");
    const cancel = inspector.querySelector("#cancel-task");
    if (!progress || !label || !history || !cancel) return;
    history.replaceChildren();
    cancel.disabled = false;
    message("Managed task started in the sample workspace. Watch the inspector for progress.");
    const advance = () => {
      if (taskStep >= names.length) { stopTask(); return; }
      const next = names[taskStep++];
      progress.style.width = String(Math.round(100 * taskStep / names.length)) + "%";
      label.textContent = next + " · " + Math.round(100 * taskStep / names.length) + "%";
      history.append(el("div", "", next));
      if (taskStep === names.length) {
        stopTask();
        cancel.disabled = true;
        message("Simulated task complete: 12 passing checks, 0 failures. No tests were executed on your computer.");
      }
    };
    advance();
    taskTimer = window.setInterval(advance, motionReduced ? 350 : 650);
  }

  root.addEventListener("click", event => {
    const tab = event.target.closest("[data-demo]");
    if (tab && root.contains(tab)) {
      setActiveDemo(tab.dataset.demo);
      return;
    }
    const decision = event.target.closest("[data-decision]");
    if (decision) {
      const allowed = decision.dataset.decision === "approve";
      thread.querySelectorAll(".demo-approval").forEach(card => card.remove());
      message(allowed ? "Example approved. In a real setup, execution would then proceed subject to the user's permissions. This website executed nothing." : "Approval denied. The sample command was not executed.");
      inspectorFooter.textContent = allowed ? "SAMPLE APPROVAL RECORDED" : "SAMPLE REQUEST DENIED";
      return;
    }
    const suggestion = event.target.closest("[data-suggest]");
    if (suggestion) {
      promptInput.value = suggestion.dataset.suggest;
      runPrompt(promptInput.value.trim());
      return;
    }
    const attachment = event.target.closest("[data-attach]");
    if (attachment) {
      const value = attachment.dataset.attach;
      if (demoAttachments.has(value)) demoAttachments.delete(value);
      else demoAttachments.add(value);
      attachment.classList.toggle("is-selected", demoAttachments.has(value));
      message("Composer context: " + ([...demoAttachments].join(" · ") || "No samples attached") + ". Nothing was uploaded.");
      return;
    }
    const tool = event.target.closest("[data-tool]");
    if (tool) {
      inspector.querySelectorAll("[data-tool]").forEach(btn => btn.classList.toggle("is-selected", btn === tool));
      inspector.querySelector("#tool-description").textContent = tools[tool.dataset.tool];
      return;
    }
    if (event.target.closest("#cancel-task")) {
      stopTask();
      const cancel = inspector.querySelector("#cancel-task");
      if (cancel) cancel.disabled = true;
      const label = inspector.querySelector("#task-label");
      if (label) label.textContent = "Demo task cancelled";
      message("Sample task cancelled. No background process was started or stopped.");
    }
  });

  root.addEventListener("submit", event => {
    if (!event.target.matches("#annotation-form")) return;
    event.preventDefault();
    const input = inspector.querySelector("#annotation-input");
    const note = input?.value.trim();
    if (!note) return;
    message("[Annotation: README.md headline] " + note, "user");
    message("Annotation added to the sample conversation for the next review. Your local files remain unchanged.");
    input.value = "";
  });
  form.addEventListener("submit", event => {
    event.preventDefault();
    const query = promptInput.value.trim();
    if (query) runPrompt(query);
  });
  promptInput.addEventListener("keydown", event => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  document.querySelectorAll("[data-open-demo]").forEach(button => button.addEventListener("click", () => {
    setActiveDemo(button.dataset.openDemo, {focus: true});
    root.scrollIntoView({behavior: motionReduced ? "instant" : "smooth", block:"start"});
  }));
  document.querySelector(".demo-tabs").addEventListener("keydown", event => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const currentIndex = tabs.indexOf(document.activeElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 :
      (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    tabs[next].focus();
    setActiveDemo(tabs[next].dataset.demo);
  });

  // Real terminal filtering and keyboard navigation. Idle selection is purely presentational.
  let idle = null;
  function visibleRows() { return rows.filter(row => !row.hidden); }
  function highlight(row) {
    rows.forEach(candidate => {
      const selected = candidate === row;
      candidate.classList.toggle("is-active", selected);
      candidate.setAttribute("aria-selected", String(selected));
    });
    activeRow = rows.indexOf(row);
  }
  function stopIdle() { window.clearInterval(idle); idle = null; }
  function startIdle() {
    stopIdle();
    if (motionReduced || terminalInput.value || document.activeElement === terminalInput || lastHover) return;
    idle = window.setInterval(() => {
      const shown = visibleRows();
      if (!shown.length) return;
      const ix = shown.indexOf(rows[activeRow]);
      highlight(shown[(ix + 1) % shown.length]);
    }, 1700);
  }
  function selectRow(row) {
    if (!row) return;
    highlight(row);
    stopIdle();
    setActiveDemo(row.dataset.feature);
    root.scrollIntoView({behavior: motionReduced ? "instant" : "smooth", block:"start"});
    if (!terminalInput.value) startIdle();
  }
  terminalInput.addEventListener("input", () => {
    stopIdle();
    const query = terminalInput.value.trim().toLowerCase();
    rows.forEach(row => {row.hidden = !row.textContent.toLowerCase().includes(query);});
    const shown = visibleRows();
    terminalEmpty.hidden = shown.length !== 0;
    if (shown.length) highlight(shown[0]);
  });
  terminalInput.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      terminalInput.value = "";
      terminalInput.dispatchEvent(new Event("input"));
      terminalInput.blur();
      startIdle();
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const shown = visibleRows();
      if (!shown.length) return;
      const ix = shown.indexOf(rows[activeRow]);
      const delta = event.key === "ArrowDown" ? 1 : -1;
      highlight(shown[(ix + delta + shown.length) % shown.length]);
    }
    if (event.key === "Enter") {
      event.preventDefault();
      selectRow(rows[activeRow]?.hidden ? visibleRows()[0] : rows[activeRow]);
    }
  });
  terminalInput.addEventListener("focus", stopIdle);
  terminalInput.addEventListener("blur", startIdle);
  rows.forEach(row => {
    row.addEventListener("click", () => selectRow(row));
    row.addEventListener("pointerenter", () => {lastHover = true; stopIdle(); highlight(row);});
    row.addEventListener("pointerleave", () => {lastHover = false; startIdle();});
    row.addEventListener("focus", () => {stopIdle(); highlight(row);});
    row.addEventListener("blur", startIdle);
  });

  setActiveDemo("approval");
  startIdle();
})();
