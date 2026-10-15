(() => {
  if (globalThis.LocalSystemSharedRuntime) return;

  const UI_VISIBILITY_STORAGE_KEY = "localSystemUiVisibilityV1";
  const DEFAULT_UI_VISIBILITY = Object.freeze({
    skills: true,
    todos: true,
    workspace: true,
    annotations: true,
  });
  const COMPOSER_SELECTOR = 'form[data-chatgpt-composer], form[data-type="unified-composer"]';
  const COMPOSER_EDITOR_SELECTOR = '[data-composer-markdown][contenteditable="true"][role="textbox"], #prompt-textarea';

  function currentThreadId(locationValue = globalThis.location) {
    const route = globalThis.LocalSystemThreadRoute;
    if (!route?.threadIdFromUrl || !locationValue) return "";
    try {
      const href = typeof locationValue === "string" ? locationValue : locationValue.href;
      return route.threadIdFromUrl(href) || "";
    } catch {
      return "";
    }
  }

  function findComposer(root = globalThis.document) {
    if (!root?.querySelector) return null;
    return root.querySelector('form[data-chatgpt-composer]')
      || root.querySelector('form[data-type="unified-composer"]')
      || findComposerEditor(root)?.closest?.("form")
      || null;
  }

  function findComposerEditor(root = globalThis.document) {
    if (!root?.querySelector) return null;
    return root.querySelector('[data-composer-markdown][contenteditable="true"][role="textbox"]')
      || root.querySelector("#prompt-textarea")
      || null;
  }

  function closestComposerEditor(target) {
    const element = target && typeof target.closest === "function" ? target : target?.parentElement;
    return element?.closest?.(COMPOSER_EDITOR_SELECTOR) || null;
  }

  function closestComposer(target) {
    const element = target && typeof target.closest === "function" ? target : target?.parentElement;
    if (!element) return null;
    return element.closest?.(COMPOSER_SELECTOR)
      || closestComposerEditor(element)?.closest?.("form")
      || null;
  }

  function findShareButton(root = globalThis.document) {
    if (!root?.querySelector) return null;
    return root.querySelector('button[data-testid="share-chat-button"]')
      || root.querySelector('button[aria-label="Share"]')
      || root.querySelector('button[aria-label^="Share "]')
      || [...root.querySelectorAll("button")].find((button) => (
        !button.closest?.("form")
        && String(button.textContent || "").trim() === "Share"
      ))
      || null;
  }

  function findHeaderActionButton(root = globalThis.document) {
    const shareButton = findShareButton(root);
    if (shareButton) return shareButton;
    if (!root?.querySelectorAll) return null;
    const actionGroups = [...root.querySelectorAll(
      '[data-app-shell-main-titlebar="true"] [data-app-shell-header-obstacle="true"]',
    )];
    for (let index = actionGroups.length - 1; index >= 0; index -= 1) {
      const buttons = [...actionGroups[index].querySelectorAll("button")]
        .filter((button) => !button.closest?.("form"));
      if (buttons.length) return buttons[buttons.length - 1];
    }
    return null;
  }

  function ensureComposerRail(root = globalThis.document) {
    const composer = findComposer(root);
    if (!composer) return null;
    let rail = composer.previousElementSibling?.classList?.contains("local-system-composer-rail")
      ? composer.previousElementSibling
      : root.querySelector?.(".local-system-composer-rail") || null;
    if (!rail) {
      const doc = composer.ownerDocument || globalThis.document;
      if (!doc?.createElement) return null;
      rail = doc.createElement("div");
      rail.className = "local-system-composer-rail";
    }
    if (rail.nextElementSibling !== composer) composer.insertAdjacentElement("beforebegin", rail);
    return rail;
  }

  function ensureComposerRailActionsHost(root = globalThis.document) {
    const rail = ensureComposerRail(root);
    if (!rail) return null;
    let host = rail.querySelector?.(":scope > .local-system-rail-actions") || null;
    if (!host) {
      const doc = rail.ownerDocument || globalThis.document;
      if (!doc?.createElement) return null;
      host = doc.createElement("div");
      host.className = "local-system-rail-actions";
      host.setAttribute("data-local-system-composer-ui", "true");
      rail.prepend(host);
    }
    return { rail, host };
  }

  function ComposerIconButton({ className = "", label, title = label, order = null, dataset = {}, icon = "" } = {}) {
    const button = globalThis.document?.createElement?.("button");
    if (!button || !label) return null;
    button.type = "button";
    button.className = ["composer-icon-button", "local-system-rail-action", className].filter(Boolean).join(" ");
    button.disabled = false;
    button.tabIndex = 0;
    button.setAttribute("aria-label", label);
    button.title = title || label;
    if (order !== null && order !== undefined) button.style.order = String(order);
    for (const [key, value] of Object.entries(dataset)) button.dataset[key] = String(value);
    button.innerHTML = icon;
    return button;
  }

  function normalizeUiVisibility(value, defaults = DEFAULT_UI_VISIBILITY) {
    const source = value && typeof value === "object" ? value : {};
    return Object.fromEntries(
      Object.entries(defaults).map(([key, fallback]) => [
        key,
        typeof source[key] === "boolean" ? source[key] : fallback,
      ]),
    );
  }

  async function loadUiVisibility(
    storage = globalThis.chrome?.storage?.local,
    defaults = DEFAULT_UI_VISIBILITY,
  ) {
    if (!storage?.get) return { ...defaults };
    try {
      const stored = await storage.get(UI_VISIBILITY_STORAGE_KEY);
      return normalizeUiVisibility(stored?.[UI_VISIBILITY_STORAGE_KEY], defaults);
    } catch {
      return { ...defaults };
    }
  }

  async function saveUiVisibility(
    value,
    storage = globalThis.chrome?.storage?.local,
    defaults = DEFAULT_UI_VISIBILITY,
  ) {
    const normalized = normalizeUiVisibility(value, defaults);
    if (!storage?.set) return normalized;
    await storage.set({ [UI_VISIBILITY_STORAGE_KEY]: normalized });
    return normalized;
  }

  function applyTheme(theme, {
    aliases = false,
    composerTypography = false,
    mainFontSizeVariable = "",
  } = {}) {
    if (!theme || typeof theme !== "object") return;
    const style = globalThis.document?.documentElement?.style;
    if (!style) return;

    setVariable(style, "--ls-ui-surface", theme.surface);
    setVariable(style, "--ls-ui-text", theme.text);
    if (aliases) {
      setVariable(style, "--surface", theme.surface);
      setVariable(style, "--text", theme.text);
    }
    if (composerTypography) {
      setVariable(style, "--ls-composer-font-family", theme.fontFamily);
      setVariable(style, "--ls-composer-font-size", theme.fontSize);
      setVariable(style, "--ls-composer-font-weight", theme.fontWeight);
      setVariable(style, "--ls-composer-line-height", theme.lineHeight);
      setVariable(style, "--ls-composer-main-font-weight", theme.mainFontWeight);
    }
    if (mainFontSizeVariable) setVariable(style, mainFontSizeVariable, theme.mainFontSize);
  }

  function clearTheme() {
    const style = globalThis.document?.documentElement?.style;
    if (!style) return;
    style.removeProperty("--ls-ui-surface");
    style.removeProperty("--ls-ui-text");
  }

  function setVariable(style, name, value) {
    if (typeof value === "string" && value) style.setProperty(name, value);
  }

  globalThis.LocalSystemSharedRuntime = Object.freeze({
    UI_VISIBILITY_STORAGE_KEY,
    DEFAULT_UI_VISIBILITY,
    COMPOSER_SELECTOR,
    COMPOSER_EDITOR_SELECTOR,
    currentThreadId,
    findComposer,
    findComposerEditor,
    closestComposer,
    closestComposerEditor,
    findShareButton,
    findHeaderActionButton,
    ensureComposerRail,
    ensureComposerRailActionsHost,
    ComposerIconButton,
    normalizeUiVisibility,
    loadUiVisibility,
    saveUiVisibility,
    applyTheme,
    clearTheme,
  });
})();
