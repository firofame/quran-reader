import { appendFile, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createSyncSetupCode, DEFAULT_SYNC_ENDPOINT, generateSyncKey, parseSyncSetupCode } from "../../sync-client.js";

export const PRODUCTION_LABEL = "deploy-sync-production";

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

export async function authorizeProduction({ eventName, event, ref, sha, repository, actor, token, fetch = globalThis.fetch }) {
  if (!token || !/^[\w.-]+\/[\w.-]+$/.test(repository) || !/^[a-f0-9]{40}$/.test(sha)) {
    throw new Error("Production authorization is missing repository, revision, or GitHub credentials.");
  }
  const get = path => requestJson(fetch, `https://api.github.com/repos/${repository}/${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
  });
  if (eventName === "pull_request") {
    if (
      event.action !== "labeled" ||
      event.label?.name !== PRODUCTION_LABEL ||
      event.pull_request?.base?.ref !== "main" ||
      event.pull_request?.head?.repo?.full_name !== repository ||
      event.pull_request?.head?.sha !== sha
    ) {
      throw new Error("Production requires an explicitly labeled, same-repository PR targeting main.");
    }
    const current = await get(`pulls/${event.pull_request.number}`);
    if (
      current.state !== "open" ||
      current.base?.ref !== "main" ||
      current.head?.repo?.full_name !== repository ||
      current.head?.sha !== sha ||
      !current.labels?.some(label => label.name === PRODUCTION_LABEL)
    ) {
      throw new Error("Production authorization expired: PR closed, label removed, or head changed.");
    }
  } else if ((eventName === "push" || eventName === "workflow_dispatch") && ref === "refs/heads/main") {
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
      throw new Error("The production label sender and triggering actor must both have repository write access.");
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
  for (const name of ["quran", "quran-reader-sync"]) {
    const worker = await api(`workers/${name}`, { allowNotFound: true });
    if (worker) {
      if (worker.name !== name || typeof worker.id !== "string" || !worker.id) {
        throw new Error("Cloudflare returned an unexpected Worker identity.");
      }
      return worker;
    }
  }
  throw new Error("Neither the current nor legacy sync Worker exists; refusing to create a replacement.");
}

export async function readBindings(api, name) {
  const { deployments } = await api(`scripts/${name}/deployments`);
  const versions = deployments?.[0]?.versions?.filter(version => version.percentage > 0);
  if (!versions?.length) throw new Error("The sync Worker has no active deployment.");
  let expected;
  for (const { version_id: versionId } of versions) {
    if (typeof versionId !== "string" || !versionId) throw new Error("Invalid active Worker version.");
    const version = await api(`scripts/${name}/versions/${encodeURIComponent(versionId)}`);
    const bindings = version.resources?.bindings?.filter(binding => binding.type === "durable_object_namespace");
    if (
      !bindings?.some(binding => binding.name === "SYNC_DO" && binding.class_name === "SyncDurableObject") ||
      bindings.some(binding => typeof binding.namespace_id !== "string" || !binding.namespace_id)
    ) {
      throw new Error("Cannot verify the sync Worker's Durable Object namespace bindings.");
    }
    const signature = bindings.map(binding => ({
      name: binding.name,
      className: binding.class_name,
      namespaceId: binding.namespace_id,
    })).sort((first, second) => first.name.localeCompare(second.name));
    if (expected && JSON.stringify(expected) !== JSON.stringify(signature)) {
      throw new Error("Active Worker versions use conflicting Durable Object namespaces.");
    }
    expected = signature;
  }
  return expected;
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
  const bindings = await readBindings(api, "quran");
  if (JSON.stringify(bindings) !== JSON.stringify(snapshot.bindings)) {
    throw new Error("Production deployment changed the Durable Object namespace bindings.");
  }
}

async function syncRequest(endpoint, key, data) {
  return requestJson(globalThis.fetch, `${endpoint}/api/sync`, {
    method: data ? "PUT" : "GET",
    headers: { Authorization: `Bearer ${key}`, "X-Sync-Key": key, "Content-Type": "application/json" },
    body: data ? JSON.stringify(data) : undefined,
  });
}

function assertCanary(actual, expected) {
  if (!actual || actual.empty === true) throw new Error("Production sync canary returned no reading state.");
  for (const field of ["chapter", "verse", "translation", "updatedAt"]) {
    if (actual[field] !== expected[field]) throw new Error("Production sync canary did not preserve its reading state.");
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
  const statePath = resolve(env.RUNNER_TEMP, "sync-production-state.json");
  if (command === "prepare") {
    await authorize();
    const worker = await findWorker(api);
    const bindings = await readBindings(api, worker.name);
    const canaryKey = generateSyncKey();
    console.log(`::add-mask::${canaryKey}`);
    const endpoint = DEFAULT_SYNC_ENDPOINT.replace("://quran.", `://${worker.name}.`);
    if ((await syncRequest(endpoint, canaryKey)).empty !== true) {
      throw new Error("The fresh production canary key unexpectedly has existing state.");
    }
    const canary = { chapter: 2, verse: 255, translation: "en.sahih", updatedAt: Date.now() };
    assertCanary(await syncRequest(endpoint, canaryKey, canary), canary);
    await writeFile(statePath, JSON.stringify({
      workerId: worker.id,
      renamed: worker.name !== "quran",
      bindings,
      canaryKey,
      canary,
      sha: env.DEPLOY_SHA,
    }), { mode: 0o600 });
    await authorize();
    await renameWorker(api, worker);
    await verifyWorker(api, { workerId: worker.id, bindings });
    console.log(worker.name === "quran" ? "Same-name edit permission verified; Worker already migrated." : "Worker renamed in place; identity and namespaces preserved.");
    return;
  }
  if (command === "verify") {
    const snapshot = JSON.parse(await readFile(statePath, "utf8"));
    if (snapshot.sha !== env.DEPLOY_SHA) throw new Error("Production snapshot does not match the deployed revision.");
    await verifyWorker(api, snapshot);
    let healthy = false;
    for (let attempt = 0; attempt < 12; attempt++) {
      const health = await requestJson(globalThis.fetch, `${DEFAULT_SYNC_ENDPOINT}/health`);
      if (health.status === "ok" && health.service === "quran") {
        healthy = true;
        break;
      }
      if (attempt < 11) await delay(5000);
    }
    if (!healthy) throw new Error("Production health did not report the new quran service.");
    const setup = parseSyncSetupCode(createSyncSetupCode(DEFAULT_SYNC_ENDPOINT, snapshot.canaryKey));
    if (!setup) throw new Error("Production canary setup code failed to round-trip.");
    assertCanary(await syncRequest(setup.endpoint, setup.syncKey), snapshot.canary);
    const secondKey = generateSyncKey();
    console.log(`::add-mask::${secondKey}`);
    if ((await syncRequest(DEFAULT_SYNC_ENDPOINT, secondKey)).empty !== true) {
      throw new Error("Production sync keys are not isolated.");
    }
    await appendFile(env.GITHUB_STEP_SUMMARY,
      `### Production sync Worker verified\n\n- Revision: \`${snapshot.sha}\`\n- URL: ${DEFAULT_SYNC_ENDPOINT}\n- Migration: ${snapshot.renamed ? "renamed in place" : "already named quran; same-name edit verified"}\n- Worker identity and Durable Object namespaces preserved.\n- Health, pre-deployment canary state, and independent-key isolation passed.\n`);
    console.log("Production health, preserved reading state, and key isolation verified.");
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
