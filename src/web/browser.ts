import fs from "node:fs";
import path from "node:path";
import { WebError } from "./errors.js";

const CHROME_CANDIDATES: Record<string, string[]> = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  ],
  linux: [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
  ],
  win32: [
    path.join(process.env.PROGRAMFILES ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
  ],
};

function isRegularExecutable(abs: string): boolean {
  try {
    const stat = fs.statSync(abs);
    if (!stat.isFile()) return false;
    if (process.platform === "win32") return abs.toLowerCase().endsWith(".exe");
    return (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

export function resolveBrowserExecutable(workspaceRoot?: string): string {
  const requested = process.env.C2C_BROWSER_PATH?.trim();
  const candidates = requested ? [requested] : (CHROME_CANDIDATES[process.platform] ?? CHROME_CANDIDATES.linux);
  for (const candidate of candidates) {
    let real: string;
    try {
      real = fs.realpathSync.native(candidate);
    } catch {
      continue;
    }
    if (!isRegularExecutable(real)) continue;
    if (workspaceRoot) {
      const root = fs.realpathSync.native(path.resolve(workspaceRoot));
      const rel = path.relative(root, real);
      if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) continue;
    }
    return real;
  }
  throw new WebError(
    "WEB_BROWSER_UNAVAILABLE",
    requested
      ? "C2C_BROWSER_PATH is not a usable browser executable outside the Workspace"
      : "Google Chrome was not found. Install Chrome or set C2C_BROWSER_PATH to a real browser binary outside the Workspace."
  );
}

export async function launchWebContext(input: {
  profileDir: string;
  workspaceRoot?: string;
}): Promise<{
  context: import("playwright-core").BrowserContext;
  executablePath: string;
}> {
  const executablePath = resolveBrowserExecutable(input.workspaceRoot);
  const playwright = await import("playwright-core");
  const context = await playwright.chromium.launchPersistentContext(input.profileDir, {
    executablePath,
    headless: false,
    viewport: { width: 1280, height: 900 },
  });
  context.setDefaultTimeout(30_000);
  context.on("page", (page) => {
    page.setDefaultTimeout(30_000);
  });
  return { context, executablePath };
}
