const PLATFORM_NAMES = { darwin: "macOS", linux: "Linux", win32: "Windows" };

export function platformSummary() {
  return { adapter: PLATFORM_NAMES[process.platform] || process.platform };
}
