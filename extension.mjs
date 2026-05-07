// Fossil VCS extension for GitHub Copilot CLI
// Self-contained: no .bashrc wrapper, no persistent files.
// Creates a temporary .git/ spoof so the TUI shows the fossil branch,
// keeps it fresh via hooks and fs.watch, cleans up on session end.

import { joinSession } from "@github/copilot-sdk/extension";
import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  watch,
  writeFileSync,
} from "node:fs";

const MARKER = "Spoofed by copilotcli-fossil";

// --- Fossil binary discovery ---

function findFossil() {
  try {
    return execSync("which fossil", { encoding: "utf8", timeout: 2000 }).trim();
  } catch {}
  const candidates = [
    `${process.env.HOME}/.local/bin/fossil`,
    "/usr/local/bin/fossil",
    "/usr/bin/fossil",
    "/opt/homebrew/bin/fossil",
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return "fossil";
}

const FOSSIL = findFossil();

// --- Fossil state queries ---

function isFossilCheckout(cwd) {
  return existsSync(`${cwd}/.fslckout`) || existsSync(`${cwd}/_FOSSIL_`);
}

function getFossilBranch(cwd) {
  try {
    return execSync(`${FOSSIL} branch current`, {
      cwd,
      encoding: "utf8",
      timeout: 3000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

function getFossilDirty(cwd) {
  try {
    const out = execSync(`${FOSSIL} changes --differ`, {
      cwd,
      encoding: "utf8",
      timeout: 3000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return out.length > 0;
  } catch {
    return false;
  }
}

function getFossilExtras(cwd) {
  try {
    const out = execSync(`${FOSSIL} extras --dotfiles`, {
      cwd,
      encoding: "utf8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return out.length > 0;
  } catch {
    return false;
  }
}

function getFossilRepoPath(cwd) {
  try {
    const info = execSync(`${FOSSIL} info`, {
      cwd,
      encoding: "utf8",
      timeout: 3000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const match = info.match(/repository:\s+(.+)/);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

// --- .git/ spoof management ---

function isSpoofedGit(cwd) {
  try {
    const desc = readFileSync(`${cwd}/.git/description`, "utf8");
    return desc.includes(MARKER);
  } catch {
    return false;
  }
}

function hasRealGit(cwd) {
  return existsSync(`${cwd}/.git`) && !isSpoofedGit(cwd);
}

function createGitSpoof(cwd, branch) {
  const gitDir = `${cwd}/.git`;
  mkdirSync(`${gitDir}/objects`, { recursive: true });
  mkdirSync(`${gitDir}/refs/heads`, { recursive: true });
  mkdirSync(`${gitDir}/info`, { recursive: true });

  writeFileSync(`${gitDir}/HEAD`, `ref: refs/heads/${branch}·fossil\n`);
  writeFileSync(`${gitDir}/info/exclude`, `*\n`);
  writeFileSync(
    `${gitDir}/description`,
    `Not a real git repository.\n${MARKER} for Copilot CLI.\nActual VCS: Fossil SCM — see .fslckout\n`
  );
  writeFileSync(
    `${gitDir}/config`,
    [
      `# ${MARKER}`,
      `[core]`,
      `\trepositoryformatversion = 0`,
      `\tbare = false`,
      ``,
    ].join("\n")
  );

  // Create an empty initial commit so `git branch --show-current` works.
  try {
    execSync(
      `git -c user.name=fossil -c user.email=fossil@localhost ` +
        `commit --allow-empty -m init --quiet`,
      { cwd, timeout: 3000, stdio: ["pipe", "pipe", "pipe"] }
    );
  } catch {}
}

function updateGitHead(cwd, branch) {
  // Self-heal: recreate .git/ spoof if it was deleted mid-session
  if (!existsSync(`${cwd}/.git/HEAD`)) {
    createGitSpoof(cwd, branch);
    return true;
  }

  const headPath = `${cwd}/.git/HEAD`;
  const desired = `ref: refs/heads/${branch}·fossil\n`;
  try {
    const current = readFileSync(headPath, "utf8");
    if (current === desired) return false;
  } catch {}
  writeFileSync(headPath, desired);

  // Ensure the branch ref file exists so `git branch --show-current` resolves it
  const refPath = `${cwd}/.git/refs/heads/${branch}·fossil`;
  if (!existsSync(refPath)) {
    try {
      const head = execSync("git rev-parse HEAD", {
        cwd,
        encoding: "utf8",
        timeout: 2000,
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      writeFileSync(refPath, head + "\n");
    } catch {}
  }
  return true;
}

function removeGitSpoof(cwd) {
  if (!isSpoofedGit(cwd)) return;
  rmSync(`${cwd}/.git`, { recursive: true, force: true });
}

// --- Main ---

const cwd = process.cwd();

if (!isFossilCheckout(cwd)) process.exit(0);

if (hasRealGit(cwd)) {
  // Real git repo coexists — inject context only, no spoof
  const branch = getFossilBranch(cwd);
  const repoPath = getFossilRepoPath(cwd);
  if (branch) {
    const session = await joinSession({
      systemMessage: {
        mode: "customize",
        sections: {
          environment_context: {
            action: (current) => {
              if (current.includes("Fossil branch:")) return current;
              return `${current}\n* Fossil branch: ${branch}\n* Fossil repository: ${repoPath || cwd}`;
            },
          },
        },
      },
    });
    await session.log(`🦴 Fossil: ${branch} (context only, real .git/ present)`);
  }
  process.exit(0);
}

// --- Spoof path ---

const branch = getFossilBranch(cwd);
if (!branch) process.exit(0);

createGitSpoof(cwd, branch);

// Watch .fslckout for branch switches between turns
let watcher;
try {
  const target = existsSync(`${cwd}/.fslckout`)
    ? `${cwd}/.fslckout`
    : `${cwd}/_FOSSIL_`;
  watcher = watch(target, () => {
    const b = getFossilBranch(cwd);
    if (b) updateGitHead(cwd, b);
  });
  watcher.unref();
} catch {}

function refreshState() {
  const b = getFossilBranch(cwd);
  if (b) updateGitHead(cwd, b);
  return b;
}

const repoPath = getFossilRepoPath(cwd);

const session = await joinSession({
  systemMessage: {
    mode: "customize",
    sections: {
      environment_context: {
        action: (current) => {
          const freshBranch = getFossilBranch(cwd) || branch;
          const dirty = getFossilDirty(cwd);
          const extras = getFossilExtras(cwd);
          const marks = [dirty ? "*" : "", extras ? "%" : ""]
            .filter(Boolean)
            .join("");
          const statusMark = marks ? ` (${marks})` : "";

          const fossilLines = [
            `* Fossil branch: ${freshBranch}${statusMark}`,
            repoPath ? `* Fossil repository: ${repoPath}` : null,
          ]
            .filter(Boolean)
            .join("\n");

          let result = current;
          result = result.replace(
            /\* Git repository root: .+/,
            `* Git repository root: ${cwd}`
          );
          result = result.replace(/\* Git repository: .+/, "");
          if (!result.includes("Fossil branch:")) {
            result = `${result}\n${fossilLines}`;
          } else {
            result = result.replace(
              /\* Fossil branch: .+/,
              `* Fossil branch: ${freshBranch}${statusMark}`
            );
          }
          return result;
        },
      },
    },
  },
  hooks: {
    onUserPromptSubmitted: async () => {
      refreshState();
    },
    onPostToolUse: async (input) => {
      if (
        input.toolName === "bash" &&
        /fossil/.test(String(input.toolArgs?.command || ""))
      ) {
        refreshState();
      }
    },
    onSessionEnd: async () => {
      if (watcher) watcher.close();
      removeGitSpoof(cwd);
    },
  },
});

const dirty = getFossilDirty(cwd);
const extras = getFossilExtras(cwd);
const marks = [dirty ? "*" : "", extras ? "%" : ""].filter(Boolean).join("");
const statusMark = marks ? ` (${marks})` : "";
await session.log(`🦴 Fossil: ${branch}${statusMark}`);
