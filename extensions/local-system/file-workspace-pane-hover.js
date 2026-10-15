/* global document */

(() => {
  const OPEN_DELAY_MS = 150;
  const CLOSE_DELAY_MS = 110;
  const EXIT_ANIMATION_MS = 120;

  function createPaneHoverController({
    elements,
    isHydrated,
    isMobileStandalone,
    isCollapsed,
    currentWorkspace,
    loadProjectRoot,
  }) {
    const hoverState = {
      active: false,
      openTimer: 0,
      closeTimer: 0,
      exitTimer: 0,
      bound: false,
    };
    const hoverSurfaces = [elements.workspaceToolbar, elements.treePane].filter(Boolean);

    function eligible() {
      return isHydrated() && !isMobileStandalone() && isCollapsed();
    }

    function surfaceActive() {
      return hoverSurfaces.some((surface) => surface.matches(":hover"));
    }

    function clearTimer(key) {
      const timer = hoverState[key];
      if (!timer) return;
      globalThis.clearTimeout(timer);
      hoverState[key] = 0;
    }

    function cancelClose() {
      clearTimer("closeTimer");
      clearTimer("exitTimer");
      elements.workspace.classList.remove("tree-hover-preview-closing");
    }

    function scheduleOpen() {
      if (!eligible() || hoverState.active || hoverState.openTimer) return;
      hoverState.openTimer = globalThis.setTimeout(() => {
        hoverState.openTimer = 0;
        if (!eligible() || !surfaceActive()) return;
        open();
      }, OPEN_DELAY_MS);
    }

    function open() {
      if (!eligible()) return;
      cancelClose();
      hoverState.active = true;
      elements.workspace.classList.add("tree-hover-preview");
      elements.treeToggle.dataset.hoverPreview = "true";
      elements.treeToggle.setAttribute("aria-expanded", "true");
      if (currentWorkspace() && !elements.projectTree.children.length) void loadProjectRoot();
    }

    function scheduleClose() {
      clearTimer("openTimer");
      if (!hoverState.active || hoverState.closeTimer) return;
      hoverState.closeTimer = globalThis.setTimeout(() => {
        hoverState.closeTimer = 0;
        close();
      }, CLOSE_DELAY_MS);
    }

    function close() {
      if (!hoverState.active) return;
      elements.workspace.classList.add("tree-hover-preview-closing");
      clearTimer("exitTimer");
      hoverState.exitTimer = globalThis.setTimeout(() => {
        hoverState.exitTimer = 0;
        reset();
      }, EXIT_ANIMATION_MS);
    }

    function reset() {
      clearTimer("openTimer");
      clearTimer("closeTimer");
      clearTimer("exitTimer");
      hoverState.active = false;
      elements.workspace.classList.remove("tree-hover-preview", "tree-hover-preview-closing");
      delete elements.treeToggle.dataset.hoverPreview;
      if (!isMobileStandalone()) {
        elements.treeToggle.setAttribute("aria-expanded", isCollapsed() ? "false" : "true");
      }
    }

    function bind() {
      if (hoverState.bound) return;
      hoverState.bound = true;
      for (const surface of hoverSurfaces) {
        surface.addEventListener("pointerenter", () => {
          if (hoverState.active) cancelClose();
          else scheduleOpen();
        });
        surface.addEventListener("pointerleave", () => {
          if (hoverState.active) {
            scheduleClose();
          } else {
            globalThis.requestAnimationFrame(() => {
              if (!surfaceActive()) clearTimer("openTimer");
            });
          }
        });
      }
      document.addEventListener("pointerover", (event) => {
        if (!hoverState.active) return;
        const target = event.target;
        const insideHoverSurface = hoverSurfaces.some((surface) => surface === target || surface.contains(target));
        if (insideHoverSurface) {
          cancelClose();
          return;
        }
        scheduleClose();
      }, true);
    }

    return Object.freeze({ bind, reset });
  }

  globalThis.LocalSystemWorkspacePaneHover = Object.freeze({
    createPaneHoverController,
  });
})();
