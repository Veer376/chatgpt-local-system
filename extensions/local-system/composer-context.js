/* global document, getComputedStyle, requestAnimationFrame */

(() => {
  "use strict";

  const UI_ATTR = "data-local-system-composer-ui";
  const ICONS = Object.freeze({
    skill: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8.5 7-5 5 5 5M15.5 7l5 5-5 5M13.5 4 10.5 20"/></svg>',
  });

  globalThis.LocalSystemComposerContext = Object.freeze({ createComposerContext });

  function createComposerContext({
    getThreadId,
    bridgeRequest,
    skillRequest,
  }) {
    if (typeof getThreadId !== "function" || typeof bridgeRequest !== "function" || typeof skillRequest !== "function") {
      throw new Error("Local System composer context dependencies are unavailable");
    }

    const context = {
      attachedSkills: [],
      skillLoadSequence: 0,
      currentWorkspace: "",
      projectSource: "none",
      workspaceResolved: false,
      workspaceLoadSequence: 0,
      projectPopover: null,
      skillChipGroup: null,
      skillPopover: null,
    };

    const threadId = () => String(getThreadId() || "").trim();

    function replaceComposerText(editor, text) {
      editor.focus();
      const selection = globalThis.getSelection?.();
      if (!selection) return false;
      const range = document.createRange();
      range.selectNodeContents(editor);
      selection.removeAllRanges();
      selection.addRange(range);
      const inserted = document.execCommand("insertText", false, text);
      if (!inserted) return false;
      const end = document.createRange();
      end.selectNodeContents(editor);
      end.collapse(false);
      selection.removeAllRanges();
      selection.addRange(end);
      return true;
    }

    function refreshTheme() {
      const editor = globalThis.LocalSystemSharedRuntime?.findComposerEditor?.();
      const composer = globalThis.LocalSystemSharedRuntime?.findComposer?.();
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
      const text = editor ? getComputedStyle(editor).color : "";
      if (surface) document.documentElement.style.setProperty("--ls-composer-surface", surface);
      if (text) document.documentElement.style.setProperty("--ls-composer-text", text);
    }

    async function loadAttachedSkills({ active = false } = {}) {
      if (!threadId()) return;
      const sequence = ++context.skillLoadSequence;
      try {
        const payload = await skillRequest({ action: "list", active });
        if (sequence !== context.skillLoadSequence) return;
        context.attachedSkills = Array.isArray(payload.attachments) ? payload.attachments : [];
        renderSkillChips();
      } catch {
        // Preserve the current chips if the loopback bridge briefly disappears.
      }
    }

    async function loadWorkspaceContext() {
      if (!threadId()) {
        context.currentWorkspace = "";
        context.workspaceResolved = true;
        return;
      }
      const sequence = ++context.workspaceLoadSequence;
      try {
        const payload = await bridgeRequest("/local-ui/file-workspace", {
          threadId: threadId(),
          action: "context",
          active: false,
        });
        if (sequence !== context.workspaceLoadSequence) return;
        const previousWorkspace = context.currentWorkspace;
        context.currentWorkspace = typeof payload.currentWorkspace === "string" ? payload.currentWorkspace : "";
        context.projectSource = typeof payload.projectSource === "string" ? payload.projectSource : "none";
        context.workspaceResolved = true;
        if (previousWorkspace !== context.currentWorkspace) {
          globalThis.dispatchEvent(new CustomEvent("local-system-project-changed", {
            detail: {
              previousWorkspace,
              currentWorkspace: context.currentWorkspace,
              bound: payload.bound === true,
              source: "context-sync",
            },
          }));
        }
      } catch {
        // Keep the last known workspace label during brief bridge interruptions.
      }
    }

    async function handleSkillAttachRequest(event) {
      const name = String(event.detail?.name || "").trim();
      if (!name) return;
      try {
        const payload = await skillRequest({ action: "attach", name, active: true });
        const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
        context.attachedSkills = payload.bound === true
          ? attachments
          : [
              ...context.attachedSkills.filter((item) => !attachments.some((next) => next.path === item.path)),
              ...attachments,
            ];
        renderSkillChips();
        globalThis.dispatchEvent(new CustomEvent("local-system-skill-attach-result", {
          detail: { name, ok: true },
        }));
      } catch (error) {
        globalThis.dispatchEvent(new CustomEvent("local-system-skill-attach-result", {
          detail: {
            name,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          },
        }));
      }
    }

    async function removeAttachedSkill(skill) {
      if (!skill?.path) return;
      if (threadId()) {
        const payload = await skillRequest({ action: "delete", path: skill.path, active: true });
        context.attachedSkills = payload.bound === true && Array.isArray(payload.attachments)
          ? payload.attachments
          : context.attachedSkills.filter((item) => item.path !== skill.path);
      } else {
        context.attachedSkills = context.attachedSkills.filter((item) => item.path !== skill.path);
      }
      removeSkillInvocationMarkers(skill.name);
      renderSkillChips();
    }

    function removeSkillInvocationMarkers(name) {
      const editor = globalThis.LocalSystemSharedRuntime?.findComposerEditor?.();
      const skillName = String(name || "").trim();
      if (!editor || !skillName) return;
      const current = editor.innerText || editor.textContent || "";
      const escapedName = skillName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp(`(^|\\s)/${escapedName}(?=\\s|$)[ \\t]?`, "g");
      const next = current.replace(pattern, "$1");
      if (next !== current) replaceComposerText(editor, next);
    }

    async function clearAttachedSkills() {
      const removedSkills = [...context.attachedSkills];
      if (threadId()) {
        const payload = await skillRequest({ action: "clear", active: true });
        context.attachedSkills = payload.bound === true && Array.isArray(payload.attachments)
          ? payload.attachments
          : [];
      } else {
        context.attachedSkills = [];
      }
      for (const skill of removedSkills) removeSkillInvocationMarkers(skill.name);
      closeSkillPopover();
      renderSkillChips();
    }

    async function showProjectPopover(anchor = null) {
      closeProjectPopover();
      if (!threadId()) return;

      const popover = document.createElement("div");
      popover.className = "ls-project-popover ls-ui-floating-surface";
      popover.setAttribute(UI_ATTR, "true");

      const header = document.createElement("div");
      header.className = "ls-project-popover__header";
      const title = document.createElement("strong");
      title.textContent = "Open Project";
      const files = document.createElement("button");
      files.type = "button";
      files.className = "ls-project-popover__files";
      files.textContent = "Project Files";
      files.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        closeProjectPopover();
        globalThis.dispatchEvent(new CustomEvent("local-system-file-workspace-toggle-request"));
      });
      header.append(title, files);

      const search = document.createElement("input");
      search.type = "search";
      search.className = "ls-project-popover__search ls-ui-search-field";
      search.placeholder = "Search projects";
      search.autocomplete = "off";
      search.spellcheck = false;
      search.setAttribute("aria-label", "Search projects");

      const list = document.createElement("div");
      list.className = "ls-project-popover__list ls-ui-scroll";
      list.setAttribute("role", "listbox");
      const loading = document.createElement("div");
      loading.className = "ls-project-popover__empty";
      loading.textContent = "Loading projects…";
      list.appendChild(loading);
      popover.append(header, search, list);
      document.documentElement.appendChild(popover);
      context.projectPopover = popover;
      positionProjectPopover(anchor);
      requestAnimationFrame(() => search.focus());

      let projects = [];
      let visibleProjects = [];
      let activeIndex = 0;
      let loaded = false;

      const scoreProject = (project, query) => {
        if (!query) return 0;
        const name = String(project.name || "").toLowerCase();
        const projectPath = String(project.path || "").toLowerCase();
        if (name === query) return 10_000;
        if (name.startsWith(query)) return 9_000 - Math.min(500, name.length - query.length);
        const nameIndex = name.indexOf(query);
        if (nameIndex >= 0) return 8_000 - nameIndex * 20;
        const pathIndex = projectPath.indexOf(query);
        if (pathIndex >= 0) return 6_000 - pathIndex * 10;
        return 0;
      };

      const setActiveProject = (index) => {
        if (!visibleProjects.length) return;
        activeIndex = (index + visibleProjects.length) % visibleProjects.length;
        const rows = [...list.querySelectorAll(".ls-project-popover__project")];
        rows.forEach((row, rowIndex) => {
          const active = rowIndex === activeIndex;
          row.classList.toggle("active", active);
          row.setAttribute("aria-selected", active ? "true" : "false");
        });
        rows[activeIndex]?.scrollIntoView({ block: "nearest" });
      };

      const chooseProject = async (project, row) => {
        if (!project) return;
        if (project.path === context.currentWorkspace) {
          closeProjectPopover();
          globalThis.dispatchEvent(new CustomEvent("local-system-file-workspace-toggle-request"));
          return;
        }
        if (row) row.disabled = true;
        try {
          await openProjectFromUi(project.path);
        } catch {
          if (row) row.disabled = false;
        }
      };

      const renderProjects = () => {
        if (context.projectPopover !== popover) return;
        list.replaceChildren();
        if (!loaded) {
          const pending = document.createElement("div");
          pending.className = "ls-project-popover__empty";
          pending.textContent = "Loading projects…";
          list.appendChild(pending);
          return;
        }

        const query = search.value.trim().toLowerCase();
        visibleProjects = query
          ? projects
              .map((project) => ({ project, score: scoreProject(project, query) }))
              .filter(({ score }) => score > 0)
              .sort((a, b) => b.score - a.score || String(a.project.name || "").localeCompare(String(b.project.name || "")))
              .map(({ project }) => project)
          : projects;
        activeIndex = Math.min(activeIndex, Math.max(0, visibleProjects.length - 1));
        if (!visibleProjects.length) {
          const empty = document.createElement("div");
          empty.className = "ls-project-popover__empty";
          empty.textContent = query ? "No matching projects." : "No authorized projects found.";
          list.appendChild(empty);
          return;
        }

        for (const [index, project] of visibleProjects.entries()) {
          const row = document.createElement("button");
          row.type = "button";
          row.className = "ls-project-popover__project ls-ui-list-row";
          row.setAttribute("role", "option");
          row.setAttribute("aria-selected", index === activeIndex ? "true" : "false");
          if (index === activeIndex) row.classList.add("active");
          if (project.path === context.currentWorkspace) row.classList.add("current");
          const name = document.createElement("span");
          name.className = "ls-project-popover__project-name";
          name.textContent = project.name || project.path;
          row.append(name);
          if (project.path === context.currentWorkspace) {
            const status = document.createElement("span");
            status.className = "ls-project-popover__project-status";
            status.textContent = context.projectSource === "binding" ? "Bound" : "Saved";
            row.append(status);
          }
          row.addEventListener("mouseenter", () => setActiveProject(index));
          row.addEventListener("click", async (event) => {
            event.preventDefault();
            event.stopPropagation();
            await chooseProject(project, row);
          });
          list.appendChild(row);
        }
      };

      search.addEventListener("input", () => {
        activeIndex = 0;
        renderProjects();
      });
      search.addEventListener("keydown", (event) => {
        if (event.isComposing) return;
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          event.stopPropagation();
          setActiveProject(activeIndex + (event.key === "ArrowDown" ? 1 : -1));
          return;
        }
        if (event.key === "Enter" && visibleProjects[activeIndex]) {
          event.preventDefault();
          event.stopPropagation();
          const row = list.querySelectorAll(".ls-project-popover__project")[activeIndex];
          void chooseProject(visibleProjects[activeIndex], row);
        }
      });

      try {
        const payload = await bridgeRequest("/local-ui/file-workspace", {
          threadId: threadId(),
          action: "projects",
          active: true,
        });
        if (context.projectPopover !== popover) return;
        context.projectSource = typeof payload.projectSource === "string" ? payload.projectSource : context.projectSource;
        projects = (Array.isArray(payload.projects) ? payload.projects : [])
          .filter((project) => !/[\\/]\.agents[\\/]skills(?:[\\/]|$)/i.test(String(project?.path || "")));
        loaded = true;
        renderProjects();
      } catch (error) {
        if (context.projectPopover !== popover) return;
        list.replaceChildren();
        const empty = document.createElement("div");
        empty.className = "ls-project-popover__empty";
        empty.textContent = error instanceof Error ? error.message : String(error);
        list.appendChild(empty);
      }
    }

    async function openProjectFromUi(projectPath) {
      const previousWorkspace = context.currentWorkspace;
      const payload = await bridgeRequest("/local-ui/file-workspace", {
        threadId: threadId(),
        action: "select_project",
        path: projectPath,
        active: true,
      });
      context.currentWorkspace = typeof payload.currentWorkspace === "string" ? payload.currentWorkspace : "";
      context.projectSource = typeof payload.projectSource === "string" ? payload.projectSource : "none";
      context.workspaceResolved = true;
      closeProjectPopover();
      globalThis.dispatchEvent(new CustomEvent("local-system-project-changed", {
        detail: {
          previousWorkspace,
          currentWorkspace: context.currentWorkspace,
          bound: payload.bound === true,
          projectSource: context.projectSource,
          source: "project-selection",
          openFiles: true,
        },
      }));
      await loadWorkspaceContext();
    }

    function positionProjectPopover(anchor = null) {
      const popover = context.projectPopover;
      if (!popover?.isConnected) return;
      if (!anchor?.isConnected) {
        const width = Math.min(360, Math.max(280, globalThis.innerWidth - 32));
        popover.style.width = `${width}px`;
        popover.style.left = `${Math.max(8, Math.round((globalThis.innerWidth - width) / 2))}px`;
        popover.style.top = "72px";
        popover.style.bottom = "auto";
        return;
      }
      const anchorRect = anchor.getBoundingClientRect();
      const width = Math.min(360, Math.max(280, anchorRect.width + 100));
      popover.style.width = `${width}px`;
      popover.style.left = `${Math.max(8, Math.min(globalThis.innerWidth - width - 8, anchorRect.right - width))}px`;
      popover.style.bottom = `${Math.max(8, globalThis.innerHeight - anchorRect.top + 6)}px`;
    }

    function closeProjectPopover() {
      context.projectPopover?.remove();
      context.projectPopover = null;
    }

    function renderSkillChips() {
      const editor = globalThis.LocalSystemSharedRuntime?.findComposerEditor?.();
      if (!editor || !context.attachedSkills.length) {
        context.skillChipGroup?.remove();
        context.skillChipGroup = null;
        closeSkillPopover();
        cleanupComposerRail();
        return;
      }

      const signature = context.attachedSkills.map((skill) => `${skill.name}\u0000${skill.path}`).join("\u0001");
      let group = context.skillChipGroup;
      if (!group) {
        group = document.createElement("div");
        group.className = "ls-skill-chip-group";
        group.setAttribute(UI_ATTR, "true");
        context.skillChipGroup = group;
      }
      const rail = ensureComposerRail(editor);
      if (rail && group.parentElement !== rail) rail.appendChild(group);
      const expectedChildren = context.attachedSkills.length >= 3 ? 1 : context.attachedSkills.length;
      if (group.dataset.signature === signature && group.children.length === expectedChildren) return;

      closeSkillPopover();
      group.replaceChildren();
      group.dataset.signature = signature;

      if (context.attachedSkills.length >= 3) {
        const summary = document.createElement("button");
        summary.type = "button";
        summary.className = "ls-skill-chip ls-skill-chip--summary";
        summary.setAttribute("aria-label", `${context.attachedSkills.length} attached skills`);
        summary.title = `${context.attachedSkills.length} attached skills`;
        const icon = document.createElement("span");
        icon.className = "ls-skill-chip__icon";
        icon.innerHTML = ICONS.skill;
        const label = document.createElement("span");
        label.className = "ls-skill-chip__label";
        label.textContent = `Skills · ${context.attachedSkills.length}`;
        summary.append(icon, label);
        summary.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (context.skillPopover) closeSkillPopover();
          else showSkillPopover(summary);
        });
        group.appendChild(summary);
        return;
      }

      for (const skill of context.attachedSkills) group.appendChild(createSkillRemoveChip(skill));
    }

    function createSkillRemoveChip(skill, { popover = false } = {}) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = popover ? "ls-skill-popover__skill" : "ls-skill-chip";
      chip.title = `Remove ${skill.name} skill\n${skill.reference || `[$${skill.name}](${skill.path})`}`;
      chip.setAttribute("aria-label", `Remove ${skill.name} skill`);
      const icon = document.createElement("span");
      icon.className = "ls-skill-chip__icon";
      icon.innerHTML = ICONS.skill;
      const label = document.createElement("span");
      label.className = "ls-skill-chip__label";
      label.textContent = skill.name;
      chip.append(icon, label);
      chip.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        chip.disabled = true;
        try {
          await removeAttachedSkill(skill);
          closeSkillPopover();
        } catch {
          chip.disabled = false;
        }
      });
      return chip;
    }

    function showSkillPopover(anchor) {
      closeSkillPopover();
      if (!anchor?.isConnected || context.attachedSkills.length < 3) return;
      const popover = document.createElement("div");
      popover.className = "ls-skill-popover ls-ui-floating-surface";
      popover.setAttribute(UI_ATTR, "true");
      const list = document.createElement("div");
      list.className = "ls-skill-popover__list ls-ui-scroll";
      for (const skill of context.attachedSkills) list.appendChild(createSkillRemoveChip(skill, { popover: true }));
      const footer = document.createElement("div");
      footer.className = "ls-skill-popover__footer";
      const clear = document.createElement("button");
      clear.type = "button";
      clear.className = "ls-skill-popover__clear";
      clear.textContent = "Clear all";
      clear.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        clear.disabled = true;
        try {
          await clearAttachedSkills();
        } catch {
          clear.disabled = false;
        }
      });
      footer.appendChild(clear);
      popover.append(list, footer);
      document.documentElement.appendChild(popover);
      context.skillPopover = { element: popover, anchor };
      positionSkillPopover();
    }

    function positionSkillPopover() {
      const entry = context.skillPopover;
      if (!entry?.element?.isConnected || !entry.anchor?.isConnected) return;
      const anchorRect = entry.anchor.getBoundingClientRect();
      const popoverRect = entry.element.getBoundingClientRect();
      const width = popoverRect.width || 220;
      const left = Math.max(8, Math.min(globalThis.innerWidth - width - 8, anchorRect.right - width));
      entry.element.style.left = `${Math.round(left)}px`;
      entry.element.style.bottom = `${Math.max(8, Math.round(globalThis.innerHeight - anchorRect.top + 6))}px`;
    }

    function closeSkillPopover() {
      context.skillPopover?.element?.remove();
      context.skillPopover = null;
    }

    function ensureComposerRail(editor) {
      const composer = globalThis.LocalSystemSharedRuntime?.closestComposer?.(editor);
      if (!composer) return null;
      let rail = composer.previousElementSibling?.classList?.contains("local-system-composer-rail")
        ? composer.previousElementSibling
        : document.querySelector(".local-system-composer-rail");
      if (!rail) {
        rail = document.createElement("div");
        rail.className = "local-system-composer-rail";
      }
      if (rail.nextElementSibling !== composer) composer.insertAdjacentElement("beforebegin", rail);
      return rail;
    }

    function cleanupComposerRail() {
      const rail = document.querySelector(".local-system-composer-rail");
      if (rail && !rail.children.length) rail.remove();
    }

    function serializedSkillsBlock() {
      if (!context.attachedSkills.length) return "";
      return context.attachedSkills.map((skill) => {
        const contents = String(skill.contents || "");
        return [
          "<skill>",
          `<name>${escapeXmlText(skill.name)}</name>`,
          `<path>${escapeXmlText(skill.path)}</path>`,
          `${contents}${contents.endsWith("\n") ? "" : "\n"}</skill>`,
        ].join("\n");
      }).join("\n\n");
    }

    function stripSerializedSkillBlock(text, serializedBlock = null) {
      const value = String(text || "");
      if (!context.attachedSkills.length) return value;
      const block = typeof serializedBlock === "string" ? serializedBlock : serializedSkillsBlock();
      if (!block || !value.trimEnd().endsWith(block)) return value;
      const trimmedEnd = value.trimEnd();
      return trimmedEnd.slice(0, trimmedEnd.length - block.length).trimEnd();
    }

    function escapeXmlText(value) {
      return String(value || "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
    }

    function hasPromptContext() {
      return context.attachedSkills.length > 0;
    }

    function render() {
      refreshTheme();
      renderSkillChips();
    }

    function handleOutsidePointerDown(event) {
      const target = event.target;
      const skillEntry = context.skillPopover;
      if (skillEntry?.element
        && !skillEntry.element.contains(target)
        && !skillEntry.anchor?.contains(target)) {
        closeSkillPopover();
      }
      if (context.projectPopover && !context.projectPopover.contains(target)) {
        closeProjectPopover();
      }
    }

    function closeTransientUi() {
      closeSkillPopover();
      closeProjectPopover();
    }

    function positionTransientUi() {
      positionSkillPopover();
      positionProjectPopover();
    }

    function resetThreadContext() {
      context.attachedSkills = [];
      context.currentWorkspace = "";
      context.projectSource = "none";
      context.workspaceResolved = false;
      context.skillLoadSequence += 1;
      context.workspaceLoadSequence += 1;
      context.skillChipGroup?.remove();
      context.skillChipGroup = null;
      closeTransientUi();
      cleanupComposerRail();
    }

    return Object.freeze({
      loadAttachedSkills,
      loadWorkspaceContext,
      handleSkillAttachRequest,
      removeAttachedSkill,
      clearAttachedSkills,
      showProjectPopover,
      positionProjectPopover,
      closeProjectPopover,
      renderSkillChips,
      showSkillPopover,
      positionSkillPopover,
      closeSkillPopover,
      ensureComposerRail,
      cleanupComposerRail,
      serializedSkillsBlock,
      stripSerializedSkillBlock,
      hasPromptContext,
      render,
      handleOutsidePointerDown,
      closeTransientUi,
      positionTransientUi,
      resetThreadContext,
    });
  }
})();
