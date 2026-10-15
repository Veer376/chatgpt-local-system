/* global chrome, createImageBitmap, FileReader, MutationObserver, ResizeObserver, document, getComputedStyle, requestAnimationFrame */

(() => {
  "use strict";

  const WAIT_MS = 20_000;
  const HIDDEN_RETRY_MS = 1_200;
  const UNBOUND_RETRY_MS = 5_000;
  const ERROR_RETRY_MS = 2_000;
  let revision = 0;
  let activeInteraction = null;
  let host = null;
  let stopped = false;
  let loopGeneration = 0;
  let hiddenRequestId = "";
  let layoutFrame = 0;
  let countdownTimer = 0;
  let watchedThreadId = currentThreadId();
  let observedComposer = null;
  const composerResizeObserver = typeof ResizeObserver === "function"
    ? new ResizeObserver(() => scheduleInteractionLayout())
    : null;

  startWatcher();
  globalThis.addEventListener("popstate", restartWatcher);
  globalThis.addEventListener("resize", scheduleInteractionLayout, { passive: true });
  globalThis.addEventListener("local-system-project-changed", scheduleInteractionLayout);
  document.addEventListener("scroll", scheduleInteractionLayout, { capture: true, passive: true });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") restartWatcher();
  });
  new MutationObserver(() => {
    const nextThreadId = currentThreadId();
    if (nextThreadId !== watchedThreadId) {
      watchedThreadId = nextThreadId;
      restartWatcher();
      return;
    }
    // ChatGPT mutates the conversation DOM aggressively while a tool is running. Do not
    // recompute styles/geometry for every mutation: only remount when our anchor vanished.
    if (!activeInteraction) return;
    if (!host?.isConnected || !observedComposer?.isConnected) scheduleInteractionLayout();
  }).observe(document.documentElement, { childList: true, subtree: true });

  function restartWatcher() {
    watchedThreadId = currentThreadId();
    revision = 0;
    hiddenRequestId = "";
    loopGeneration += 1;
    void watch(loopGeneration);
  }

  function startWatcher() {
    loopGeneration += 1;
    void watch(loopGeneration);
  }

  async function watch(generation) {
    while (!stopped && generation === loopGeneration) {
      const threadId = currentThreadId();
      if (!threadId || document.visibilityState !== "visible") {
        clearInteraction();
        await delay(HIDDEN_RETRY_MS);
        continue;
      }
      try {
        const payload = await apiRequest("/local-ui/interactions", {
          action: "wait",
          threadId,
          revision,
          timeoutMs: WAIT_MS,
        });
        if (generation !== loopGeneration || threadId !== currentThreadId()) continue;
        revision = Number(payload?.revision) || 0;
        if (!payload?.bound) {
          clearInteraction();
          await delay(UNBOUND_RETRY_MS);
          continue;
        }
        if (payload.interaction?.id && payload.interaction.id !== hiddenRequestId) {
          setInteraction(payload.interaction);
        } else if (!payload.interaction) {
          clearInteraction();
          hiddenRequestId = "";
        }
      } catch {
        await delay(ERROR_RETRY_MS);
      }
    }
  }

  function setInteraction(interaction) {
    const changed = activeInteraction?.id !== interaction.id;
    activeInteraction = interaction;
    if (changed) {
      hiddenRequestId = "";
      if (document.visibilityState !== "visible" || !document.hasFocus()) {
        const question = String(interaction.question || "").trim();
        try {
          void chrome.runtime.sendMessage({
            source: "local-system-content",
            action: "notify",
            title: interaction.kind === "approval" ? "Local System needs approval" : "Local System needs your input",
            message: question || "The agent is waiting for you.",
            requireInteraction: true,
          });
        } catch {}
      }
    }
    ensureMounted();
    if (changed || !host?.firstElementChild) renderInteraction();
  }

  function clearInteraction() {
    activeInteraction = null;
    if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = 0;
    }
    if (observedComposer) composerResizeObserver?.unobserve(observedComposer);
    observedComposer = null;
    if (layoutFrame) {
      globalThis.cancelAnimationFrame?.(layoutFrame);
      layoutFrame = 0;
    }
    host?.remove();
    host = null;
  }

  function ensureMounted() {
    if (!activeInteraction || hiddenRequestId === activeInteraction.id) return;
    const composer = findComposer();
    if (!composer) return;
    if (!host) {
      host = document.createElement("section");
      host.className = "ls-interaction-host";
      host.setAttribute("aria-live", "polite");
    }
    // Keep the interaction outside ChatGPT's composer subtree. During an active generation
    // ChatGPT can make that subtree inert/non-interactive; a body-level fixed portal stays
    // clickable while still being visually anchored directly above the composer.
    if (host.parentElement !== document.body) document.body.append(host);
    observeComposer(composer);
    positionHost(composer);
    syncTheme(composer);
  }

  function observeComposer(composer) {
    if (observedComposer === composer) return;
    if (observedComposer) composerResizeObserver?.unobserve(observedComposer);
    observedComposer = composer;
    composerResizeObserver?.observe(composer);
  }

  function scheduleInteractionLayout() {
    if (!activeInteraction || layoutFrame) return;
    layoutFrame = requestAnimationFrame(() => {
      layoutFrame = 0;
      ensureMounted();
    });
  }

  function positionHost(composer) {
    if (!host || !composer?.isConnected) return;
    const rect = composer.getBoundingClientRect();
    const gutter = 8;
    const gap = 10;
    const viewportWidth = Math.max(document.documentElement.clientWidth, globalThis.innerWidth || 0);
    const viewportHeight = Math.max(document.documentElement.clientHeight, globalThis.innerHeight || 0);
    const left = Math.max(gutter, Math.min(rect.left, viewportWidth - gutter));
    const width = Math.max(260, Math.min(rect.width, viewportWidth - left - gutter));
    host.style.left = `${left}px`;
    host.style.width = `${width}px`;
    host.style.bottom = `${Math.max(gutter, viewportHeight - rect.top + gap)}px`;
    host.style.maxHeight = `${Math.max(180, rect.top - gap - gutter)}px`;
  }

  function renderInteraction() {
    if (!activeInteraction) return;
    ensureMounted();
    if (!host) return;
    const interaction = activeInteraction;
    const selected = new Set();
    const attachments = [];

    const card = document.createElement("div");
    card.className = "ls-interaction-card";
    card.dataset.kind = interaction.kind;

    const head = document.createElement("header");
    head.className = "ls-interaction-head";
    const icon = document.createElement("span");
    icon.className = "ls-interaction-head__icon";
    icon.textContent = interaction.kind === "approval" ? "!" : "?";
    const title = document.createElement("span");
    title.className = "ls-interaction-head__title";
    title.textContent = interaction.kind === "approval" ? "Approval" : "Question";
    const spacer = document.createElement("span");
    spacer.className = "ls-interaction-head__spacer";
    head.append(icon, title, spacer);
    const expiresAt = Number(interaction.expiresAt);
    if (Number.isFinite(expiresAt) && expiresAt > 0) {
      const timer = document.createElement("span");
      timer.className = "ls-interaction-timer";
      timer.setAttribute("aria-label", "Time remaining to answer");
      head.append(timer);
      startCountdown(timer, expiresAt);
    }
    if (interaction.kind !== "approval" && interaction.questionCount > 1) {
      const position = document.createElement("span");
      position.className = "ls-interaction-position";
      position.textContent = `${interaction.questionIndex + 1} of ${interaction.questionCount}`;
      head.append(position);
      const previous = iconButton("chevron-left", "Previous question");
      previous.disabled = true;
      const next = iconButton("chevron-right", "Submit and continue");
      next.addEventListener("click", () => submit(false));
      const nav = document.createElement("span");
      nav.className = "ls-interaction-head__nav";
      nav.append(previous, next);
      head.append(nav);
    }
    const richPresentation = interaction.content ? renderRichContent(interaction.content) : null;
    if (richPresentation) head.append(richPresentation.controls);
    const close = iconButton("close", "Dismiss here");
    close.addEventListener("click", () => {
      hiddenRequestId = interaction.id;
      host?.remove();
    });
    head.append(close);

    const body = document.createElement("div");
    body.className = "ls-interaction-body";
    if (richPresentation) body.append(richPresentation.content);
    if (!interaction.presentationOnly && !interaction.contentOnly) {
      const question = document.createElement("p");
      question.className = "ls-interaction-question";
      question.textContent = interaction.kind === "approval" && interaction.prompt
        ? interaction.prompt
        : interaction.question;
      body.append(question);
    }

    if (interaction.sections?.length) body.append(renderSections(interaction.sections));

    const options = document.createElement("div");
    options.className = "ls-interaction-options";
    for (const [index, option] of (interaction.presentationOnly || interaction.contentOnly ? [] : (interaction.options || [])).entries()) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ls-interaction-option";
      button.setAttribute("aria-pressed", "false");
      const number = document.createElement("span");
      number.className = "ls-interaction-option__number";
      number.textContent = String(index + 1);
      const text = document.createElement("span");
      text.className = "ls-interaction-option__text";
      text.textContent = option;
      button.append(number, text);
      button.addEventListener("click", () => {
        if (interaction.multiple) {
          if (selected.has(option)) selected.delete(option); else selected.add(option);
        } else {
          selected.clear();
          selected.add(option);
          if (input) input.value = "";
        }
        for (const row of options.querySelectorAll(".ls-interaction-option")) {
          row.setAttribute("aria-pressed", selected.has(row.dataset.value) ? "true" : "false");
        }
        updateSubmitState();
      });
      button.dataset.value = option;
      options.append(button);
    }
    if (!interaction.presentationOnly && !interaction.contentOnly && interaction.options?.length) body.append(options);

    let input = null;
    let attachmentList = null;
    let attachmentInput = null;
    if (!interaction.presentationOnly && interaction.allowCustom !== false) {
      const response = document.createElement("div");
      response.className = "ls-interaction-response";
      response.innerHTML = '<span class="ls-interaction-response__icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m4 20 4.5-1L19 8.5a2.1 2.1 0 0 0-3-3L5.5 16 4 20Z"/><path d="m14.5 7 3 3"/></svg></span>';
      input = document.createElement("textarea");
      input.className = "ls-interaction-input";
      input.rows = 1;
      input.placeholder = interaction.kind === "approval" ? "Or write a different instruction" : "Or write your own response";
      input.addEventListener("input", () => {
        if (!interaction.multiple && input.value.trim()) {
          selected.clear();
          for (const row of options.querySelectorAll(".ls-interaction-option")) row.setAttribute("aria-pressed", "false");
        }
        input.style.height = "34px";
        input.style.height = `${Math.min(110, Math.max(34, input.scrollHeight))}px`;
        updateSubmitState();
      });
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
          event.preventDefault();
          void submit(false);
        }
      });
      input.addEventListener("paste", (event) => {
        const images = [...(event.clipboardData?.files || [])].filter((file) => file.type.startsWith("image/"));
        if (!images.length) return;
        event.preventDefault();
        void addImageFiles(images);
      });

      const attach = document.createElement("button");
      attach.type = "button";
      attach.className = "ls-interaction-attach";
      attach.setAttribute("aria-label", "Attach image");
      attach.title = "Attach image";
      attach.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 12.5 14.5 7a3 3 0 1 1 4.2 4.2l-7.4 7.4a5 5 0 0 1-7.1-7.1l7.5-7.5"/></svg>';
      attachmentInput = document.createElement("input");
      attachmentInput.type = "file";
      attachmentInput.accept = "image/*";
      attachmentInput.multiple = true;
      attachmentInput.hidden = true;
      attach.addEventListener("click", (event) => {
        event.stopPropagation();
        attachmentInput.click();
      });
      attachmentInput.addEventListener("change", () => {
        const images = [...(attachmentInput.files || [])];
        attachmentInput.value = "";
        void addImageFiles(images);
      });
      response.append(input, attach, attachmentInput);
      response.addEventListener("click", () => input.focus({ preventScroll: true }));
      body.append(response);

      attachmentList = document.createElement("div");
      attachmentList.className = "ls-interaction-attachments";
      attachmentList.hidden = true;
      body.append(attachmentList);

      card.addEventListener("dragover", (event) => {
        if (![...(event.dataTransfer?.items || [])].some((item) => item.kind === "file" && item.type.startsWith("image/"))) return;
        event.preventDefault();
        card.classList.add("is-dragging-image");
      });
      card.addEventListener("dragleave", (event) => {
        if (event.relatedTarget && card.contains(event.relatedTarget)) return;
        card.classList.remove("is-dragging-image");
      });
      card.addEventListener("drop", (event) => {
        const images = [...(event.dataTransfer?.files || [])].filter((file) => file.type.startsWith("image/"));
        card.classList.remove("is-dragging-image");
        if (!images.length) return;
        event.preventDefault();
        void addImageFiles(images);
      });
    }

    const error = document.createElement("p");
    error.className = "ls-interaction-error";
    error.hidden = true;
    body.append(error);

    const actions = document.createElement("footer");
    actions.className = "ls-interaction-actions";
    let submitButton;
    if (interaction.kind === "approval") {
      const deny = actionButton("Deny", "danger");
      deny.addEventListener("click", () => submitOption("Deny"));
      const approve = actionButton("Approve", "primary");
      approve.addEventListener("click", () => submitOption("Approve"));
      actions.append(deny, approve);
      submitButton = approve;
    } else if (interaction.presentationOnly || interaction.contentOnly) {
      submitButton = actionButton("Continue", "primary");
      submitButton.addEventListener("click", () => submit(false));
      actions.append(submitButton);
    } else {
      const skip = actionButton("Skip");
      skip.addEventListener("click", () => submit(true));
      submitButton = actionButton(interaction.questionCount > 1 ? "Next" : "Submit", "primary");
      submitButton.addEventListener("click", () => submit(false));
      actions.append(skip, submitButton);
    }

    card.append(head, body, actions);
    host.replaceChildren(card);
    scheduleInteractionLayout();
    updateSubmitState();

    function updateSubmitState() {
      if (!submitButton || interaction.kind === "approval") return;
      if (interaction.presentationOnly || interaction.contentOnly) {
        submitButton.disabled = false;
        return;
      }
      const custom = input?.value.trim() || "";
      submitButton.disabled = selected.size === 0 && !custom && attachments.length === 0;
    }

    async function addImageFiles(files) {
      if (!attachmentList || attachments.length >= 5) return;
      error.hidden = true;
      for (const file of files.slice(0, 5 - attachments.length)) {
        if (!file?.type?.startsWith("image/")) continue;
        const pending = renderPendingAttachment(file, attachmentList);
        try {
          const prepared = await prepareImage(file);
          const payload = await apiRequest("/local-ui/interactions", {
            action: "upload",
            threadId: currentThreadId(),
            requestId: interaction.id,
            name: prepared.name,
            mimeType: prepared.mimeType,
            data: prepared.data,
          });
          if (activeInteraction?.id !== interaction.id) return;
          const attachment = payload?.attachment;
          if (!attachment?.path) throw new Error("Image upload returned no attachment");
          attachments.push(attachment);
          renderAttachment(attachment, pending, attachmentList);
        } catch (uploadError) {
          pending.remove();
          error.textContent = uploadError instanceof Error ? uploadError.message : String(uploadError);
          error.hidden = false;
        }
      }
      attachmentList.hidden = attachmentList.children.length === 0;
      updateSubmitState();
    }

    function renderPendingAttachment(file, list) {
      list.hidden = false;
      const item = document.createElement("div");
      item.className = "ls-interaction-attachment is-loading";
      item.textContent = `Preparing ${file.name || "image"}…`;
      list.append(item);
      return item;
    }

    function renderAttachment(attachment, item, list) {
      item.className = "ls-interaction-attachment";
      item.replaceChildren();
      const name = document.createElement("span");
      name.className = "ls-interaction-attachment__name";
      name.textContent = attachment.name || "image";
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "ls-interaction-attachment__remove";
      remove.setAttribute("aria-label", `Remove ${name.textContent}`);
      remove.textContent = "×";
      remove.addEventListener("click", () => {
        const index = attachments.findIndex((candidate) => candidate.path === attachment.path);
        if (index >= 0) attachments.splice(index, 1);
        item.remove();
        list.hidden = list.children.length === 0;
        updateSubmitState();
      });
      item.append(name, remove);
    }

    async function submitOption(option) {
      if (option === "Approve" || option === "Deny") {
        selected.clear();
        selected.add(option);
        if (input) input.value = "";
      }
      await submit(false);
    }

    async function submit(skip) {
      if (activeInteraction?.id !== interaction.id) return;
      error.hidden = true;
      const custom = input?.value.trim() || "";
      const values = [...selected];
      if (!interaction.presentationOnly && !interaction.contentOnly && !skip && !custom && values.length === 0 && attachments.length === 0) {
        error.textContent = "Choose an option or write a response.";
        error.hidden = false;
        return;
      }
      for (const button of card.querySelectorAll("button")) button.disabled = true;
      try {
        const answer = interaction.presentationOnly
          ? "Continue"
          : custom || values[0] || (attachments.length ? "Attached image" : interaction.contentOnly ? "Continue" : "");
        const answers = interaction.multiple
          ? [...values, ...(custom ? [custom] : [])]
          : undefined;
        const payload = await apiRequest("/local-ui/interactions", {
          action: "respond",
          threadId: currentThreadId(),
          requestId: interaction.id,
          answer,
          answers,
          attachments,
          skip,
        });
        revision = Number(payload?.revision) || revision;
        // A later questionnaire item can become active while this response request is in
        // flight. Never let the older submit completion tear down that newer card. Prefer the
        // returned snapshot when it already contains the next interaction; otherwise only clear
        // the card if the interaction being submitted is still the active one.
        if (payload?.interaction?.id && payload.interaction.id !== hiddenRequestId) {
          setInteraction(payload.interaction);
        } else if (activeInteraction?.id === interaction.id) {
          clearInteraction();
        }
      } catch (submitError) {
        error.textContent = submitError instanceof Error ? submitError.message : String(submitError);
        error.hidden = false;
        for (const button of card.querySelectorAll("button")) button.disabled = false;
        updateSubmitState();
      }
    }
  }

  function startCountdown(element, expiresAt) {
    if (countdownTimer) clearInterval(countdownTimer);
    const update = () => {
      const remainingSeconds = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1_000));
      const minutes = Math.floor(remainingSeconds / 60);
      const seconds = remainingSeconds % 60;
      element.textContent = `${minutes}:${String(seconds).padStart(2, "0")} left`;
      element.dataset.urgency = remainingSeconds <= 30
        ? "critical"
        : remainingSeconds <= 60
          ? "warning"
          : "normal";
      if (remainingSeconds === 0 && countdownTimer) {
        clearInterval(countdownTimer);
        countdownTimer = 0;
      }
    };
    update();
    countdownTimer = globalThis.setInterval(update, 1_000);
  }

  function renderRichContent(content) {
    const wrapper = document.createElement("section");
    wrapper.className = "ls-interaction-rich";
    const controls = document.createElement("span");
    controls.className = "ls-interaction-rich__zoom-controls";
    const zoomOut = document.createElement("button");
    zoomOut.className = "ls-interaction-rich__zoom";
    zoomOut.type = "button";
    zoomOut.textContent = "−";
    zoomOut.title = "Zoom out";
    const zoomLabel = document.createElement("button");
    zoomLabel.className = "ls-interaction-rich__zoom-label";
    zoomLabel.type = "button";
    zoomLabel.textContent = "100%";
    zoomLabel.title = "Reset zoom";
    const zoomIn = document.createElement("button");
    zoomIn.className = "ls-interaction-rich__zoom";
    zoomIn.type = "button";
    zoomIn.textContent = "+";
    zoomIn.title = "Zoom in";
    controls.append(zoomOut, zoomLabel, zoomIn);
    const viewport = document.createElement("div");
    viewport.className = "ls-interaction-rich__viewport";
    const stage = document.createElement("div");
    stage.className = "ls-interaction-rich__stage";
    const frame = document.createElement("iframe");
    frame.className = "ls-interaction-rich__frame";
    frame.title = "Agent presentation";
    frame.setAttribute("sandbox", "allow-same-origin");
    frame.referrerPolicy = "no-referrer";
    let zoom = 1;
    let baseHeight = 160;
    let contentResizeObserver = null;
    const applyZoom = (next) => {
      zoom = Math.max(.5, Math.min(2, Math.round(next * 10) / 10));
      stage.style.width = `${zoom * 100}%`;
      stage.style.height = `${Math.ceil(baseHeight * zoom)}px`;
      frame.style.width = `${100 / zoom}%`;
      frame.style.height = `${baseHeight}px`;
      frame.style.transform = `scale(${zoom})`;
      zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
      zoomOut.disabled = zoom <= .5;
      zoomIn.disabled = zoom >= 2;
      scheduleInteractionLayout();
    };
    const syncContentHeight = () => {
      try {
        const doc = frame.contentDocument;
        if (!doc) return;
        const measured = Math.max(
          80,
          Number(doc.documentElement?.scrollHeight) || 0,
          Number(doc.body?.scrollHeight) || 0,
          Math.ceil(doc.documentElement?.getBoundingClientRect?.().height || 0),
          Math.ceil(doc.body?.getBoundingClientRect?.().height || 0),
        );
        const nextHeight = Math.min(5000, measured);
        if (Math.abs(nextHeight - baseHeight) > 2) {
          baseHeight = nextHeight;
          applyZoom(zoom);
        }
      } catch {}
    };
    zoomOut.addEventListener("click", () => applyZoom(zoom - .1));
    zoomIn.addEventListener("click", () => applyZoom(zoom + .1));
    zoomLabel.addEventListener("click", () => applyZoom(1));
    applyZoom(1);
    frame.addEventListener("load", () => {
      syncContentHeight();
      try {
        contentResizeObserver?.disconnect();
        const doc = frame.contentDocument;
        if (!doc) return;
        contentResizeObserver = new ResizeObserver(syncContentHeight);
        if (doc.documentElement) contentResizeObserver.observe(doc.documentElement);
        if (doc.body) contentResizeObserver.observe(doc.body);
      } catch {}
    });
    const source = String(content || "");
    const trimmed = source.trim();
    if (/^<!doctype\s+html/i.test(trimmed) || /^<html\b/i.test(trimmed)) {
      frame.srcdoc = source;
    } else {
      const isDark =
        document.documentElement.classList.contains("dark") ||
        Boolean(globalThis.matchMedia && globalThis.matchMedia("(prefers-color-scheme: dark)").matches);
      const themeClass = isDark ? "dark" : "light";
      const body = renderPresentationContent(source);
      frame.srcdoc = `<!doctype html><html class="${themeClass}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; media-src data: blob:; font-src data:; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'; frame-src 'none'; connect-src 'none'"><style>:root,.light{color-scheme:light;--text:#181818;--text-soft:rgba(24,24,24,.65);--border:rgba(0,0,0,.12);--code-bg:rgba(0,0,0,.06);--code-border:rgba(0,0,0,.08);--pre-bg:rgba(0,0,0,.03);--table-th:rgba(0,0,0,.04);--quote-border:rgba(0,0,0,.35);--link:#10a37f}@media (prefers-color-scheme: dark){:root{color-scheme:dark;--text:#f3f3f3;--text-soft:rgba(243,243,243,.68);--border:rgba(255,255,255,.14);--code-bg:rgba(255,255,255,.1);--code-border:rgba(255,255,255,.12);--pre-bg:rgba(255,255,255,.05);--table-th:rgba(255,255,255,.05);--quote-border:rgba(255,255,255,.35);--link:#10a37f}}.dark{color-scheme:dark;--text:#f3f3f3;--text-soft:rgba(243,243,243,.68);--border:rgba(255,255,255,.14);--code-bg:rgba(255,255,255,.1);--code-border:rgba(255,255,255,.12);--pre-bg:rgba(255,255,255,.05);--table-th:rgba(255,255,255,.05);--quote-border:rgba(255,255,255,.35);--link:#10a37f}*{box-sizing:border-box}html,body{margin:0;min-height:0;background:transparent;color:var(--text);font:14px/1.6 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;overflow:visible}body{padding:0 0 4px;user-select:text;word-break:break-word}.plain{white-space:pre-wrap;overflow-wrap:anywhere;color:var(--text)}h1,h2,h3,h4,h5,h6{margin:1.1em 0 .4em;line-height:1.3;color:var(--text);font-weight:650}h1{font-size:1.5em;letter-spacing:-.015em}h2{font-size:1.3em;letter-spacing:-.01em}h3{font-size:1.15em}h4{font-size:1.02em}h5,h6{font-size:.92em}h1:first-child,h2:first-child,h3:first-child,h4:first-child,p:first-child{margin-top:0}p{margin:.6em 0;line-height:1.6;color:var(--text)}ul,ol{margin:.5em 0;padding-left:1.5em;color:var(--text)}li{margin:.25em 0;line-height:1.55;color:var(--text)}li>input[type="checkbox"]{margin:0 .4em .15em 0;vertical-align:middle}blockquote{margin:.75em 0;padding:.3em 0 .3em 14px;border-left:3px solid var(--quote-border);color:var(--text-soft)}blockquote>p:first-child{margin-top:0}blockquote>p:last-child{margin-bottom:0}code{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono",monospace;font-size:.88em;padding:.18em .38em;border-radius:5px;background:var(--code-bg);border:1px solid var(--code-border);color:var(--text)}pre{margin:.8em 0;padding:12px 14px;border-radius:8px;background:var(--pre-bg);border:1px solid var(--border);overflow-x:auto;white-space:pre}pre code{padding:0;background:transparent;border:none;font-size:.86em;white-space:inherit;color:var(--text)}.table-wrap{width:100%;overflow-x:auto;margin:.8em 0}table{width:100%;border-collapse:collapse;font-size:13px;color:var(--text)}th,td{padding:8px 12px;border:1px solid var(--border);text-align:left;color:var(--text)}th{background:var(--table-th);font-weight:600}hr{border:0;border-top:1px solid var(--border);margin:1.2em 0}a{color:var(--link);text-decoration:underline;text-underline-offset:2px}a:hover{opacity:.85}img,video,svg,canvas{max-width:100%;height:auto;border-radius:6px}.md-gap{height:.35em}button,input,textarea,select{font:inherit}</style></head><body>${body}</body></html>`;
    }
    void hydrateLocalPresentationMedia(frame, source);
    stage.append(frame);
    viewport.append(stage);
    wrapper.append(viewport);
    return { content: wrapper, controls };
  }

  async function hydrateLocalPresentationMedia(frame, source) {
    const references = collectLocalPresentationMedia(source);
    if (!references.length) return;

    const threadId = currentThreadId();
    if (!threadId) return;

    const replacements = new Map();
    const origins = new Set();
    await Promise.all(references.map(async (reference) => {
      try {
        const descriptor = await apiRequest("/local-ui/files/resolve", {
          threadId,
          path: localPresentationPath(reference),
        });
        const url = String(descriptor?.url || "").trim();
        if (!url) return;
        replacements.set(reference, url);
        try { origins.add(new URL(url).origin); } catch {}
      } catch {
        // Leave unresolved references untouched. The surrounding presentation should still render.
      }
    }));

    if (!frame.isConnected || replacements.size === 0) return;
    let documentSource = frame.srcdoc;
    for (const [reference, url] of replacements) {
      documentSource = replaceAllLiteral(documentSource, reference, url);
      const escapedReference = escapeHtml(reference);
      if (escapedReference !== reference) {
        documentSource = replaceAllLiteral(documentSource, escapedReference, url);
      }
    }

    if (origins.size) {
      const allowedOrigins = [...origins].join(" ");
      documentSource = documentSource
        .replace("img-src data: blob:;", `img-src data: blob: ${allowedOrigins};`)
        .replace("media-src data: blob:;", `media-src data: blob: ${allowedOrigins};`);
    }
    frame.srcdoc = documentSource;
  }

  function collectLocalPresentationMedia(source) {
    const references = new Set();
    const add = (value) => {
      const reference = String(value || "").trim();
      if (isLocalPresentationMedia(reference)) references.add(reference);
    };

    for (const match of source.matchAll(/\b(?:src|poster)\s*=\s*(["'])([^"']+)\1/gi)) add(match[2]);
    for (const match of source.matchAll(/\b(?:src|poster)\s*=\s*([^\s>"']+)/gi)) add(match[1]);
    for (const match of source.matchAll(/\bsrcset\s*=\s*(["'])([^"']+)\1/gi)) {
      for (const candidate of match[2].split(",")) add(candidate.trim().split(/\s+/)[0]);
    }
    for (const match of source.matchAll(/!\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g)) add(match[1]);
    return [...references];
  }

  function isLocalPresentationMedia(reference) {
    if (!reference || reference.startsWith("#") || reference.startsWith("//")) return false;
    if (/^[A-Za-z]:[\\/]/.test(reference)) return hasPresentationMediaExtension(reference);
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(reference)) return false;
    return hasPresentationMediaExtension(reference);
  }

  function hasPresentationMediaExtension(reference) {
    const pathOnly = reference.split(/[?#]/, 1)[0];
    return /\.(?:avif|bmp|gif|ico|jpe?g|png|svg|webp|mp3|wav|m4a|mp4|mov)$/i.test(pathOnly);
  }

  function localPresentationPath(reference) {
    const pathOnly = reference.split(/[?#]/, 1)[0];
    if (!/%[0-9a-f]{2}/i.test(pathOnly)) return pathOnly;
    try { return decodeURIComponent(pathOnly); } catch { return pathOnly; }
  }

  function replaceAllLiteral(source, search, replacement) {
    return String(source).split(search).join(replacement);
  }

  function renderPresentationContent(source) {
    if (!source || typeof source !== "string") return "";
    const trimmed = source.trim();
    if (/^<!doctype\s+html/i.test(trimmed) || /^<html\b/i.test(trimmed)) {
      return source;
    }
    const lines = source.replace(/\r\n?/g, "\n").split("\n");
    const out = [];
    let inFence = false;
    let fenceLang = "";
    let fenceLines = [];
    let listType = null;
    let inTable = false;
    let tableHeader = null;
    let tableRows = [];
    let tableAligns = [];

    const closeList = () => {
      if (!listType) return;
      out.push(`</${listType}>`);
      listType = null;
    };

    const closeFence = () => {
      const code = escapeHtml(fenceLines.join("\n"));
      const langAttr = fenceLang ? ` class="language-${escapeHtml(fenceLang)}"` : "";
      out.push(`<pre><code${langAttr}>${code}</code></pre>`);
      fenceLines = [];
      fenceLang = "";
      inFence = false;
    };

    const closeTable = () => {
      if (!inTable) return;
      let html = '<div class="table-wrap"><table>';
      if (tableHeader) {
        html += "<thead><tr>";
        tableHeader.forEach((cell, idx) => {
          const align = tableAligns[idx] ? ` style="text-align:${tableAligns[idx]}"` : "";
          html += `<th${align}>${renderInline(cell.trim())}</th>`;
        });
        html += "</tr></thead>";
      }
      if (tableRows.length) {
        html += "<tbody>";
        for (const row of tableRows) {
          html += "<tr>";
          row.forEach((cell, idx) => {
            const align = tableAligns[idx] ? ` style="text-align:${tableAligns[idx]}"` : "";
            html += `<td${align}>${renderInline(cell.trim())}</td>`;
          });
          html += "</tr>";
        }
        html += "</tbody>";
      }
      html += "</table></div>";
      out.push(html);
      inTable = false;
      tableHeader = null;
      tableRows = [];
      tableAligns = [];
    };

    const isTableSeparator = (line) => /^\s*\|?(\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?\s*$/.test(line);
    const parseTableCells = (line) => {
      let clean = line.trim();
      if (clean.startsWith("|")) clean = clean.slice(1);
      if (clean.endsWith("|")) clean = clean.slice(0, -1);
      return clean.split("|");
    };
    const parseAligns = (line) => {
      const cells = parseTableCells(line);
      return cells.map((cell) => {
        const c = cell.trim();
        const left = c.startsWith(":");
        const right = c.endsWith(":");
        if (left && right) return "center";
        if (right) return "right";
        if (left) return "left";
        return "";
      });
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      const fenceMatch = line.match(/^\s*`{3,}\s*([^`\s]*)\s*$/);
      if (fenceMatch) {
        closeList();
        closeTable();
        if (inFence) {
          closeFence();
        } else {
          inFence = true;
          fenceLang = fenceMatch[1] || "";
        }
        continue;
      }
      if (inFence) {
        fenceLines.push(line);
        continue;
      }

      if (line.includes("|")) {
        const nextLine = lines[i + 1];
        if (!inTable && nextLine && isTableSeparator(nextLine)) {
          closeList();
          inTable = true;
          tableHeader = parseTableCells(line);
          tableAligns = parseAligns(nextLine);
          tableRows = [];
          i++;
          continue;
        }
        if (inTable) {
          if (isTableSeparator(line)) continue;
          tableRows.push(parseTableCells(line));
          continue;
        }
      } else if (inTable) {
        closeTable();
      }

      const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
      const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
      if (unordered || ordered) {
        closeTable();
        const nextType = unordered ? "ul" : "ol";
        if (listType !== nextType) {
          closeList();
          listType = nextType;
          out.push(`<${listType}>`);
        }
        let itemText = (unordered || ordered)[1];
        const taskMatch = itemText.match(/^\[([ xX])\]\s*(.*)$/);
        if (taskMatch) {
          const checked = taskMatch[1].toLowerCase() === "x" ? " checked" : "";
          itemText = `<input type="checkbox" disabled${checked} /> ${taskMatch[2]}`;
        }
        out.push(`<li>${renderInline(itemText)}</li>`);
        continue;
      }
      closeList();

      if (!line.trim()) {
        closeTable();
        out.push('<div class="md-gap"></div>');
        continue;
      }

      if (/^\s*([-*_]\s*){3,}$/.test(line)) {
        closeTable();
        out.push("<hr />");
        continue;
      }

      const heading = line.match(/^(#{1,6})\s+(.+)$/);
      if (heading) {
        closeTable();
        const level = heading[1].length;
        out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
        continue;
      }

      const quote = line.match(/^\s*>\s?(.*)$/);
      if (quote) {
        closeTable();
        out.push(`<blockquote>${renderInline(quote[1])}</blockquote>`);
        continue;
      }

      if (/^\s*<(\/?(?:section|article|div|table|thead|tbody|tr|th|td|p|ul|ol|li|blockquote|pre|details|summary|h[1-6]|figure|figcaption|svg|canvas|video|audio|form|header|footer|nav|main|aside))\b/i.test(line)) {
        closeTable();
        out.push(line);
        continue;
      }

      out.push(`<p>${renderInline(line)}</p>`);
    }

    closeList();
    closeTable();
    if (inFence) closeFence();
    return out.join("\n");
  }

  function renderInline(text) {
    if (!text) return "";
    const codeTokens = [];
    let s = text.replace(/`([^`\n]+)`/g, (_, code) => {
      const idx = codeTokens.length;
      codeTokens.push(`<code>${escapeHtml(code)}</code>`);
      return `@@INLINECODE${idx}@@`;
    });

    const htmlTokens = [];
    s = s.replace(/<\/?[A-Za-z][^>]*>/g, (tag) => {
      const idx = htmlTokens.length;
      htmlTokens.push(tag);
      return `@@INLINEHTML${idx}@@`;
    });

    s = escapeHtml(s);

    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (_, alt, url, title) => {
      const t = title ? ` title="${title}"` : "";
      return `<img src="${url}" alt="${alt}"${t} loading="lazy" />`;
    });
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (_, label, url, title) => {
      const t = title ? ` title="${title}"` : "";
      return `<a href="${url}" target="_blank" rel="noopener noreferrer"${t}>${label}</a>`;
    });
    s = s.replace(/(\*{2}|_{2})([^*_\n]+)\1/g, "<strong>$2</strong>");
    s = s.replace(/(\*|_)([^*_\n]+)\1/g, "<em>$2</em>");
    s = s.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");

    s = s.replace(/@@INLINEHTML(\d+)@@/g, (_, idx) => htmlTokens[Number(idx)] || "");
    s = s.replace(/@@INLINECODE(\d+)@@/g, (_, idx) => codeTokens[Number(idx)] || "");

    return s;
  }

  function escapeHtml(value) {
    return String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  async function prepareImage(file) {
    if (!file?.type?.startsWith("image/")) throw new Error("Choose an image file.");
    const bitmap = await createImageBitmap(file);
    try {
      const maxDimension = 1600;
      const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
      let width = Math.max(1, Math.round(bitmap.width * scale));
      let height = Math.max(1, Math.round(bitmap.height * scale));
      let quality = 0.84;
      let blob = null;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d", { alpha: false });
        if (!context) throw new Error("Image preparation is unavailable.");
        context.drawImage(bitmap, 0, 0, width, height);
        blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/webp", quality));
        if (!blob) throw new Error("Could not prepare the image.");
        if (blob.size <= 1_100_000) break;
        width = Math.max(320, Math.round(width * 0.8));
        height = Math.max(320, Math.round(height * 0.8));
        quality = Math.max(0.58, quality - 0.08);
      }
      if (!blob || blob.size > 1_250_000) throw new Error("The image is too large to attach.");
      return {
        name: `${String(file.name || "image").replace(/\.[^.]+$/, "") || "image"}.webp`,
        mimeType: "image/webp",
        data: await blobToDataUrl(blob),
      };
    } finally {
      bitmap.close?.();
    }
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(reader.error || new Error("Could not read the image."));
      reader.readAsDataURL(blob);
    });
  }

  function renderSections(sections) {
    const root = document.createElement("div");
    root.className = "ls-interaction-sections";
    for (const section of sections) {
      const wrapper = document.createElement("section");
      wrapper.className = "ls-interaction-section";
      const label = document.createElement("div");
      label.className = "ls-interaction-section__label";
      label.textContent = section.label;
      const value = document.createElement("div");
      value.className = `ls-interaction-section__value${section.mono ? " mono" : ""}`;
      value.textContent = section.text;
      wrapper.append(label, value);
      root.append(wrapper);
    }
    return root;
  }

  function actionButton(label, variant = "") {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `ls-interaction-button${variant ? ` ${variant}` : ""}`;
    button.textContent = label;
    return button;
  }

  function iconButton(kind, label) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ls-interaction-icon-button";
    button.setAttribute("aria-label", label);
    const paths = {
      "chevron-left": '<path d="m15 18-6-6 6-6"/>',
      "chevron-right": '<path d="m9 18 6-6-6-6"/>',
      close: '<path d="M7 7l10 10M17 7 7 17"/>',
    };
    button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[kind] || paths.close}</svg>`;
    return button;
  }

  function syncTheme(composer) {
    if (!host || !composer) return;
    const editor = globalThis.LocalSystemSharedRuntime?.findComposerEditor?.();
    const editorStyle = editor ? getComputedStyle(editor) : getComputedStyle(composer);
    let surface = "";
    let node = editor?.parentElement || composer;
    while (node) {
      const background = getComputedStyle(node).backgroundColor;
      if (background && background !== "transparent" && background !== "rgba(0, 0, 0, 0)") {
        surface = background;
        break;
      }
      if (node === composer) break;
      node = node.parentElement;
    }
    const uiStyle = editorStyle;
    if (surface) host.style.setProperty("--ls-interaction-surface", surface);
    if (editorStyle.color) host.style.setProperty("--ls-interaction-text", editorStyle.color);
    if (uiStyle.fontSize) host.style.setProperty("--ls-interaction-ui-font", uiStyle.fontSize);
    if (editorStyle.fontSize) host.style.setProperty("--ls-interaction-main-font", editorStyle.fontSize);
  }

  async function apiRequest(path, body) {
    const deadline = Date.now() + 3_000;
    while (typeof globalThis.LocalSystemApiRequest !== "function" && Date.now() < deadline) await delay(25);
    if (typeof globalThis.LocalSystemApiRequest !== "function") throw new Error("Local System API bridge is unavailable");
    return globalThis.LocalSystemApiRequest(path, body);
  }

  function currentThreadId() {
    return globalThis.LocalSystemSharedRuntime?.currentThreadId() || "";
  }

  function findComposer() {
    return globalThis.LocalSystemSharedRuntime?.findComposer?.() || null;
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
})();
