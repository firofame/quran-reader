import { appendFile, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const PRODUCTION_URL = "https://quran.firofame.workers.dev";

async function requestJson(fetch, url, options = {}) {
  const response = await fetch(url, {
    ...options,
    redirect: "error",
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) {
    throw new Error(`${options.method || "GET"} ${new URL(url).pathname} failed (HTTP ${response.status}).`);
  }
  try {
    return await response.json();
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`Invalid JSON from ${new URL(url).pathname}.`);
    throw error;
  }
}

/**
 * Confirms that the running workflow may deploy to production.
 *
 * Production is deployed from `main` only: a push to `main` or a manual run
 * on `main`, at the exact revision that is still the head of `main`, by
 * someone with repository write access.
 */
export async function authorizeProduction({ eventName, event, ref, sha, repository, actor, token, fetch = globalThis.fetch }) {
  if (!token || !/^[\w.-]+\/[\w.-]+$/.test(repository) || !/^[a-f0-9]{40}$/.test(sha)) {
    throw new Error("Production authorization is missing repository, revision, or GitHub credentials.");
  }
  const get = path => requestJson(fetch, `https://api.github.com/repos/${repository}/${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
  });
  if ((eventName === "push" || eventName === "workflow_dispatch") && ref === "refs/heads/main") {
    const current = await get("git/ref/heads/main");
    if (current.object?.sha !== sha) throw new Error("Production revision is no longer the current main head.");
  } else {
    throw new Error("This event is not authorized for production deployment.");
  }

  for (const login of new Set([event.sender?.login, actor])) {
    if (typeof login !== "string" || !/^[\w-]+(?:\[bot\])?$/.test(login)) {
      throw new Error("Production authorization requires an identifiable maintainer.");
    }
    const result = await get(`collaborators/${encodeURIComponent(login)}/permission`);
    if (!["admin", "maintain", "write"].includes(result.permission)) {
      throw new Error("The production deploy must be triggered by someone with repository write access.");
    }
  }
}

export function createCloudflareApi({ accountId, token, fetch = globalThis.fetch }) {
  if (!/^[a-f0-9]{32}$/.test(accountId) || !token) {
    throw new Error("Cloudflare account ID and API token are required.");
  }
  return async (path, { method = "GET", body, allowNotFound = false } = {}) => {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(20000),
    });
    if (allowNotFound && response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`Cloudflare ${method} ${path} failed (HTTP ${response.status}); verify Workers edit access to the existing Worker.`);
    }
    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error(`Cloudflare ${method} ${path} returned invalid JSON.`);
      throw error;
    }
    if (payload.success !== true || !payload.result) {
      throw new Error(`Cloudflare ${method} ${path} did not report API success.`);
    }
    return payload.result;
  };
}

export async function findWorker(api) {
  const worker = await api("workers/quran", { allowNotFound: true });
  if (!worker) throw new Error("The Worker does not exist; refusing to create a replacement.");
  if (worker.name !== "quran" || typeof worker.id !== "string" || !worker.id) {
    throw new Error("Cloudflare returned an unexpected Worker identity.");
  }
  return worker;
}

export async function renameWorker(api, worker) {
  const renamed = await api(`workers/${encodeURIComponent(worker.id)}`, {
    method: "PATCH",
    body: { name: "quran" },
  });
  if (renamed.id !== worker.id || renamed.name !== "quran") {
    throw new Error("The in-place Worker update did not preserve the expected identity.");
  }
}

export async function verifyWorker(api, snapshot) {
  const worker = await api("workers/quran");
  if (worker.id !== snapshot.workerId || worker.name !== "quran") {
    throw new Error("Production deployment changed the Worker identity.");
  }
}

async function main(command) {
  const env = process.env;
  const authorize = async () => authorizeProduction({
    eventName: env.GITHUB_EVENT_NAME,
    event: JSON.parse(await readFile(env.GITHUB_EVENT_PATH, "utf8")),
    ref: env.GITHUB_REF,
    sha: env.DEPLOY_SHA,
    repository: env.GITHUB_REPOSITORY,
    actor: env.GITHUB_TRIGGERING_ACTOR,
    token: env.GITHUB_TOKEN,
  });
  if (command === "authorize") {
    await authorize();
    console.log("Maintainer authorization and current production revision verified.");
    return;
  }

  const api = createCloudflareApi({ accountId: env.ACCOUNT_ID, token: env.CLOUDFLARE_API_TOKEN });
  if (command === "find") {
    const worker = await findWorker(api);
    await appendFile(env.GITHUB_OUTPUT, `name=${worker.name}\n`);
    return;
  }
  const statePath = resolve(env.RUNNER_TEMP, "deployment-state.json");
  if (command === "prepare") {
    await authorize();
    const worker = await findWorker(api);
    await writeFile(statePath, JSON.stringify({
      workerId: worker.id,
      renamed: worker.name !== "quran",
      sha: env.DEPLOY_SHA,
    }), { mode: 0o600 });
    await authorize();
    await renameWorker(api, worker);
    await verifyWorker(api, { workerId: worker.id });
    console.log(worker.name === "quran" ? "Same-name edit permission verified." : "Worker renamed in place; identity preserved.");
    return;
  }
  if (command === "verify") {
    const snapshot = JSON.parse(await readFile(statePath, "utf8"));
    if (snapshot.sha !== env.DEPLOY_SHA) throw new Error("Production snapshot does not match the deployed revision.");
    await verifyWorker(api, snapshot);
    let healthy = false;
    for (let attempt = 0; attempt < 12; attempt++) {
      const health = await requestJson(globalThis.fetch, `${PRODUCTION_URL}/health`);
      if (health.status === "ok" && health.service === "quran") {
        healthy = true;
        break;
      }
      if (attempt < 11) await delay(5000);
    }
    if (!healthy) throw new Error("Production health did not report the new quran service.");
    await appendFile(env.GITHUB_STEP_SUMMARY,
      `### Production Worker verified\n\n- Revision: \`${snapshot.sha}\`\n- URL: ${PRODUCTION_URL}\n- Migration: ${snapshot.renamed ? "renamed in place" : "already named quran; same-name edit verified"}\n- Worker identity preserved.\n- Health check passed.\n`);
    console.log("Production identity and health verified.");
    return;
  }
  throw new Error(`Unknown deployment command: ${command}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv[2]).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
