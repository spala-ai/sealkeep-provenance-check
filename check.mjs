#!/usr/bin/env node
/**
 * Sealkeep provenance merge check. Lists the commits of a pull request (or a
 * push), reads each one's `Sealkeep-Session:` trailers and asks the plane
 * whether every named session was synced to a company space by a current
 * member, for this repository. Fails, naming the commit and the fix, when
 * one was not; with `require: all`, also fails on a commit that names no
 * session and does not say `Sealkeep-Session: none`.
 *
 * Dependency-free: Node builtins and fetch only. The pure functions are
 * exported for test/provenance-check-action.test.mjs; `repoKeyOf` and
 * `parseSessionTrailers` must stay identical to src/provenance.ts.
 *
 * The CI token is sent to the plane only, masked in the log, and never
 * printed. The plane sees two digests per question: the session ref and the
 * repository key; never the repository name or a commit.
 */
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const SESSION_TRAILER = "Sealkeep-Session";
export const SESSION_NONE = "none";
const REF_PATTERN = /^sks1_[0-9a-f]{32}$/;
const TRAILER_LINE = /^([A-Za-z0-9][A-Za-z0-9-]*)\s*:\s*(.*)$/;
const SCISSORS = /^[#;] -+ >8 -+$/;
const VERIFY_PATH = "/v1/provenance/verify";
const VERIFY_BATCH = 100;
const MAX_COMMITS = 250;

/** Same as src/provenance.ts `repoKeyOf`. */
export function repoKeyOf(hostAndPath) {
  const canonical = String(hostAndPath).trim().replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "").toLowerCase();
  if (!/^[^/\s]+\/\S+$/.test(canonical)) return null;
  return createHash("sha256").update(`sealkeep-provenance-repo:v1\0${canonical}`).digest("hex");
}

/** Same as src/provenance.ts `parseSessionTrailers`. */
export function parseSessionTrailers(message) {
  const refs = [];
  let none = false;
  for (const line of String(message).replace(/\r\n/g, "\n").split("\n")) {
    if (SCISSORS.test(line)) break;
    const match = TRAILER_LINE.exec(line);
    if (!match || match[1].toLowerCase() !== SESSION_TRAILER.toLowerCase()) continue;
    const value = match[2].trim();
    if (value.toLowerCase() === SESSION_NONE) none = true;
    else if (!refs.includes(value)) refs.push(value);
  }
  return { refs, none };
}

export function isProvenanceRef(value) {
  return REF_PATTERN.test(value);
}

/** `https://plane.example` or the full verify URL `sealkeep org provenance` prints. */
export function verifyUrlOf(planeUrl) {
  const raw = String(planeUrl ?? "").trim().replace(/\/+$/, "");
  if (!raw) return null;
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname))) return null;
  return raw.endsWith(VERIFY_PATH) ? raw : `${raw}${VERIFY_PATH}`;
}

/** GitHub passes `with:` inputs as INPUT_<NAME>, upper-cased, hyphens kept. */
export function readInputs(env) {
  const input = (name) => String(env[`INPUT_${name.toUpperCase()}`] ?? "").trim();
  const require = (input("require") || "ai").toLowerCase();
  if (require !== "ai" && require !== "all") throw new Error(`require must be "ai" or "all", not "${require}"`);
  const matchAuthor = /^(true|yes|1)$/i.test(input("match-author"));
  const repo = input("repo") || (env.GITHUB_REPOSITORY ? `${new URL(env.GITHUB_SERVER_URL || "https://github.com").host}/${env.GITHUB_REPOSITORY}` : "");
  return {
    planeUrl: input("plane-url"),
    token: input("token"),
    require,
    matchAuthor,
    repo,
    githubToken: input("github-token") || String(env.GITHUB_TOKEN ?? ""),
  };
}

export function subjectOf(message) {
  return String(message).replace(/\r\n/g, "\n").split("\n")[0].trim().slice(0, 72);
}

/**
 * What each commit needs from the plane. A merge commit is skipped (its
 * parents were checked); a commit saying `none` and naming no ref passes.
 */
export function planCommits(commits) {
  return commits.map((commit) => {
    const { refs, none } = parseSessionTrailers(commit.message);
    return {
      sha: commit.sha,
      subject: subjectOf(commit.message),
      authorEmail: String(commit.authorEmail ?? "").trim().toLowerCase(),
      merge: (commit.parents ?? 0) > 1,
      refs,
      none,
    };
  });
}

/** One verify body per author (when matching authors), at most 100 refs each. */
export function verifyRequests(planned, repoKey, matchAuthor) {
  const groups = new Map();
  for (const commit of planned) {
    if (commit.merge) continue;
    const author = matchAuthor ? commit.authorEmail : "";
    const refs = groups.get(author) ?? [];
    for (const ref of commit.refs) if (isProvenanceRef(ref) && !refs.includes(ref)) refs.push(ref);
    groups.set(author, refs);
  }
  const requests = [];
  for (const [author, refs] of groups) {
    for (let at = 0; at < refs.length; at += VERIFY_BATCH) {
      const body = { repo_key: repoKey, sessions: refs.slice(at, at + VERIFY_BATCH) };
      if (author) body.author_email = author;
      requests.push(body);
    }
  }
  return requests;
}

const REASONS = {
  not_found: "is not synced to any company project this check can see",
  other_repo: "was synced, but for a different repository",
};

/**
 * The verdict per commit, from the plane's answers keyed by
 * `${author}\0${ref}` (author empty unless matching authors).
 */
export function judgeCommits(planned, answers, options) {
  const failures = [];
  let verified = 0;
  let declaredNone = 0;
  let unmarked = 0;
  let merges = 0;
  for (const commit of planned) {
    const where = `${commit.sha.slice(0, 7)} "${commit.subject}"`;
    if (commit.merge) { merges += 1; continue; }
    if (commit.refs.length === 0) {
      if (commit.none) { declaredNone += 1; continue; }
      if (options.require === "all") {
        failures.push({ sha: commit.sha, message: `${where} names no agent session. Fix: run \`sealkeep provenance install\` on the machine that made it and re-commit, or, if no agent wrote it, add a line \`${SESSION_TRAILER}: ${SESSION_NONE}\` to the commit message.` });
      } else unmarked += 1;
      continue;
    }
    let ok = true;
    for (const ref of commit.refs) {
      if (!isProvenanceRef(ref)) {
        ok = false;
        failures.push({ sha: commit.sha, message: `${where} has a malformed ${SESSION_TRAILER} value "${ref.slice(0, 48)}". Fix: amend the message so the line is \`${SESSION_TRAILER}: sks1_\` and 32 hex characters, as \`sealkeep provenance install\` writes it, or \`${SESSION_TRAILER}: ${SESSION_NONE}\`.` });
        continue;
      }
      const answer = answers.get(`${options.matchAuthor ? commit.authorEmail : ""}\0${ref}`);
      if (!answer || answer.verified !== true) {
        ok = false;
        const reason = REASONS[answer?.reason] ?? "was not confirmed by the plane";
        failures.push({ sha: commit.sha, message: `${where}: session ${ref} ${reason}. Fix: run \`sealkeep sync\` on the machine that made the commit (its project must be shared with the company), then re-run this check; if no agent wrote the commit, amend it to say \`${SESSION_TRAILER}: ${SESSION_NONE}\`.` });
        continue;
      }
      if (options.matchAuthor && answer.author_match === false) {
        ok = false;
        failures.push({ sha: commit.sha, message: `${where}: session ${ref} was synced by ${answer.member_email ?? "another member"}, not the commit author ${commit.authorEmail || "(no email)"}. Fix: commit with the email of your Sealkeep account (\`git config user.email\`), or ask an admin to turn off match-author.` });
      }
    }
    if (ok) verified += 1;
  }
  return { failures, counts: { verified, declaredNone, unmarked, merges, total: planned.length } };
}

// ---------------------------------------------------------------------------
// I/O

async function github(path, inputs, env) {
  const base = String(env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, "");
  const response = await fetch(`${base}${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(inputs.githubToken ? { authorization: `Bearer ${inputs.githubToken}` } : {}),
    },
  });
  if (!response.ok) throw new Error(`GitHub API ${path} answered ${response.status}; the workflow needs \`permissions: contents: read, pull-requests: read\``);
  return response.json();
}

const fromApi = (row) => ({ sha: row.sha, message: row.commit?.message ?? "", authorEmail: row.commit?.author?.email ?? "", parents: Array.isArray(row.parents) ? row.parents.length : 0 });

/** The commits to check: a pull request's, or a push's. */
export async function listCommits(event, inputs, env) {
  const repository = env.GITHUB_REPOSITORY;
  const number = event.pull_request?.number ?? event.merge_group?.pull_requests?.[0]?.number;
  if (number) {
    const rows = [];
    for (let page = 1; rows.length < MAX_COMMITS; page += 1) {
      const batch = await github(`/repos/${repository}/pulls/${number}/commits?per_page=100&page=${page}`, inputs, env);
      rows.push(...batch);
      if (batch.length < 100) break;
    }
    if (rows.length >= MAX_COMMITS) throw new Error(`the pull request has ${MAX_COMMITS} or more commits, more than GitHub lists; split it`);
    return rows.map(fromApi);
  }
  if (event.before && event.after && !/^0+$/.test(event.before)) {
    const compare = await github(`/repos/${repository}/compare/${event.before}...${event.after}`, inputs, env);
    return (compare.commits ?? []).map(fromApi);
  }
  if (Array.isArray(event.commits)) {
    return event.commits.map((row) => ({ sha: row.id, message: row.message ?? "", authorEmail: row.author?.email ?? "", parents: 1 }));
  }
  throw new Error("no commits to check: run this on pull_request or push");
}

async function verify(verifyUrl, token, body) {
  let response;
  try {
    response = await fetch(verifyUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new Error(`could not reach the Sealkeep plane at ${new URL(verifyUrl).origin} (${error?.name === "TimeoutError" ? "timed out" : "network error"})`);
  }
  if (response.status === 401) throw new Error("the plane refused the CI token: it is wrong or revoked. An admin makes a new one with `sealkeep org provenance token rotate` and stores it as the workflow's secret");
  if (response.status === 404) throw new Error(`the plane at ${new URL(verifyUrl).origin} has no provenance routes; check plane-url against \`sealkeep org provenance\``);
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const code = /PROVENANCE_[A-Z_]+/.exec(text)?.[0];
    throw new Error(`the plane answered ${response.status}${code ? ` ${code}` : ""}`);
  }
  const answer = await response.json();
  if (!Array.isArray(answer?.results)) throw new Error("the plane's answer had no results");
  return answer.results;
}

const escapeData = (value) => String(value).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const escapeProperty = (value) => escapeData(value).replace(/:/g, "%3A").replace(/,/g, "%2C");

export async function run(env = process.env, log = (line) => process.stdout.write(`${line}\n`)) {
  const inputs = readInputs(env);
  if (inputs.token) log(`::add-mask::${inputs.token}`);
  const verifyUrl = verifyUrlOf(inputs.planeUrl);
  if (!verifyUrl) throw new Error("plane-url is missing or not an https URL; use the verify URL `sealkeep org provenance` prints");
  if (!inputs.token) throw new Error("token is missing; an admin makes one with `sealkeep org provenance token create` and stores it as a repository or organisation secret");
  const repoKey = repoKeyOf(inputs.repo);
  if (!repoKey) throw new Error(`repo "${inputs.repo}" is not host/owner/name`);
  const event = env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8")) : {};
  const planned = planCommits(await listCommits(event, inputs, env));
  const answers = new Map();
  for (const body of verifyRequests(planned, repoKey, inputs.matchAuthor)) {
    for (const result of await verify(verifyUrl, inputs.token, body)) answers.set(`${body.author_email ?? ""}\0${result.session}`, result);
  }
  const { failures, counts } = judgeCommits(planned, answers, inputs);
  for (const failure of failures) log(`::error title=${escapeProperty(`Sealkeep provenance: ${failure.sha.slice(0, 7)}`)}::${escapeData(failure.message)}`);
  const summary = `Sealkeep provenance (${inputs.require === "all" ? "every commit" : "agent commits"}): ${counts.verified} verified, ${counts.declaredNone} marked none, ${counts.unmarked} unmarked, ${counts.merges} merges skipped, ${failures.length} problem${failures.length === 1 ? "" : "s"} in ${counts.total} commits.`;
  log(summary);
  if (env.GITHUB_STEP_SUMMARY) {
    try { appendFileSync(env.GITHUB_STEP_SUMMARY, `${summary}\n\n${failures.map((failure) => `- ${failure.message}`).join("\n")}\n`); } catch { /* the summary is a convenience */ }
  }
  return failures.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().then((code) => { process.exitCode = code; }, (error) => {
    process.stdout.write(`::error title=Sealkeep provenance::${escapeData(error?.message ?? String(error))}\n`);
    process.exitCode = 1;
  });
}
