import test from "node:test";
import assert from "node:assert/strict";
import {
  authorizeProduction,
  createCloudflareApi,
  findWorker,
  PRODUCTION_LABEL,
  readBindings,
  renameWorker,
  seedCanary,
  verifyWorker,
} from "../worker/scripts/deployment.js";

const sha = "a".repeat(40);
const repository = "firofame/quran-reader";
const worker = { id: "existing-worker-id", name: "quran" };
const binding = { type: "durable_object_namespace", name: "SYNC_DO", class_name: "SyncDurableObject", namespace_id: "existing-namespace" };
const signature = [{ name: "SYNC_DO", className: "SyncDurableObject", namespaceId: "existing-namespace" }];

test("production canary: seeds legacy bookmark-requiring Workers without changing the reader payload", async () => {
  const state = { chapter: 2, verse: 255, translation: "en.sahih", updatedAt: Date.now() };
  let captured;
  await seedCanary({
    endpoint: "https://quran.firofame.workers.dev",
    key: "synthetic-private-key",
    state,
    fetch: async (url, options) => {
      if (options.method === "GET") return Response.json({ empty: true, updatedAt: 0 });
      captured = JSON.parse(options.body);
      if (!Array.isArray(captured.bookmarks)) return Response.json({ error: "Invalid state payload." }, { status: 400 });
      return Response.json({ empty: false, ...captured });
    },
  });
  assert.deepEqual(captured, { ...state, bookmarks: [] });
  assert.equal(Object.hasOwn(state, "bookmarks"), false);
});

test("production canary: rejects existing state and unsuccessful legacy writes", async () => {
  const options = {
    endpoint: "https://quran.firofame.workers.dev",
    key: "synthetic-private-key",
    state: { chapter: 2, verse: 255, translation: "en.sahih", updatedAt: Date.now() },
  };
  await assert.rejects(seedCanary({ ...options, fetch: async () => Response.json({ empty: false }) }), /existing state/);
  await assert.rejects(seedCanary({
    ...options,
    fetch: async (url, options) => options.method === "GET"
      ? Response.json({ empty: true })
      : Response.json({ error: "Rejected" }, { status: 400 }),
  }), /HTTP 400/);
});

function authorizationOptions() {
  const current = {
    state: "open",
    base: { ref: "main" },
    head: { repo: { full_name: repository }, sha },
    labels: [{ name: PRODUCTION_LABEL }],
  };
  const roles = new Map([["maintainer", "write"], ["rerun-actor", "admin"]]);
  return {
    current,
    roles,
    options: {
      eventName: "pull_request",
      event: {
        action: "labeled",
        label: { name: PRODUCTION_LABEL },
        sender: { login: "maintainer" },
        pull_request: { ...structuredClone(current), number: 10 },
      },
      ref: "refs/pull/10/merge",
      sha,
      repository,
      actor: "rerun-actor",
      token: "test-github-token",
      fetch: async (url, options) => {
        assert.equal(options.redirect, "error");
        assert.ok(options.signal);
        const path = new URL(url).pathname;
        if (path.endsWith("/pulls/10")) return Response.json(current);
        if (path.endsWith("/git/ref/heads/main")) return Response.json({ object: { sha: current.head.sha } });
        const login = path.match(/collaborators\/([^/]+)\/permission$/)?.[1];
        assert.ok(login, `Unexpected GitHub request: ${path}`);
        return Response.json({ permission: roles.get(login) });
      },
    },
  };
}

function cloudflareApi(fetch) {
  return createCloudflareApi({ accountId: "a".repeat(32), token: "test-cloudflare-token", fetch });
}

function mockApi({ existing = worker, bindings = [binding], renamed = worker } = {}) {
  const calls = [];
  const api = cloudflareApi(async (url, options) => {
    const path = new URL(url).pathname.split("/workers/")[1];
    calls.push({ path, ...options });
    assert.equal(options.redirect, "error");
    assert.ok(options.signal);
    if (options.method === "PATCH") return Response.json({ success: true, result: renamed });
    if (path === "workers/quran" && existing.name !== "quran") return Response.json({ success: false }, { status: 404 });
    if (path === `workers/${existing.name}`) return Response.json({ success: true, result: existing });
    if (path.endsWith("/deployments")) {
      return Response.json({ success: true, result: { deployments: [{ versions: [{ version_id: "active-version", percentage: 100 }] }] } });
    }
    if (path.endsWith("/versions/active-version")) {
      return Response.json({ success: true, result: { resources: { bindings } } });
    }
    throw new Error(`Unexpected Cloudflare request: ${path}`);
  });
  return { api, calls };
}

test("production authorization: accepts only maintainers on the exact opted-in PR head", async () => {
  for (const role of ["write", "maintain", "admin"]) {
    const { options, roles } = authorizationOptions();
    roles.set("maintainer", role);
    await authorizeProduction(options);
  }
});

test("production authorization: rejects read/triage senders and unauthorized rerun actors", async () => {
  for (const login of ["maintainer", "rerun-actor"]) {
    for (const role of ["read", "triage", "none"]) {
      const { options, roles } = authorizationOptions();
      roles.set(login, role);
      await assert.rejects(authorizeProduction(options), /both have repository write access/);
    }
  }
});

test("production authorization: rejects forks, wrong labels, wrong events, and non-main targets", async () => {
  const changes = [
    options => { options.event.action = "synchronize"; },
    options => { options.event.label.name = "enhancement"; },
    options => { options.event.pull_request.head.repo.full_name = "fork/quran-reader"; },
    options => { options.event.pull_request.base.ref = "other"; },
    options => { options.event.pull_request.head.sha = "b".repeat(40); },
    options => { options.eventName = "pull_request_target"; },
    options => { options.eventName = "workflow_dispatch"; options.ref = "refs/heads/topic"; },
  ];
  for (const change of changes) {
    const { options } = authorizationOptions();
    change(options);
    await assert.rejects(authorizeProduction(options), /not authorized|explicitly labeled/);
  }
});

test("production authorization: rejects stale heads, removed labels, and closed or retargeted PRs", async () => {
  const changes = [
    current => { current.head.sha = "b".repeat(40); },
    current => { current.labels = []; },
    current => { current.state = "closed"; },
    current => { current.base.ref = "other"; },
    current => { current.head.repo.full_name = "fork/quran-reader"; },
  ];
  for (const change of changes) {
    const { options, current } = authorizationOptions();
    change(current);
    await assert.rejects(authorizeProduction(options), /authorization expired/);
  }
});

test("production authorization: permits main push/manual runs but rejects stale main revisions", async () => {
  for (const eventName of ["push", "workflow_dispatch"]) {
    const { options, current } = authorizationOptions();
    options.eventName = eventName;
    options.ref = "refs/heads/main";
    await authorizeProduction(options);
    current.head.sha = "b".repeat(40);
    await assert.rejects(authorizeProduction(options), /current main head/);
  }
});

test("production authorization: surfaces unavailable GitHub permission checks and missing credentials", async () => {
  const { options } = authorizationOptions();
  await assert.rejects(authorizeProduction({ ...options, token: "" }), /credentials/);
  await assert.rejects(authorizeProduction({
    ...options,
    fetch: async () => Response.json({ message: "Forbidden" }, { status: 403 }),
  }), /HTTP 403/);
});

test("Worker migration: verifies same-name edit access without probing an inaccessible legacy resource", async () => {
  const { api, calls } = mockApi();
  assert.deepEqual(await findWorker(api), worker);
  assert.equal(calls.length, 1);
  await renameWorker(api, worker);
  const patch = calls.find(call => call.method === "PATCH");
  assert.equal(patch.path, `workers/${worker.id}`);
  assert.deepEqual(JSON.parse(patch.body), { name: "quran" });
});

test("Worker migration: renames the legacy Worker by immutable identity", async () => {
  const existing = { ...worker, name: "quran-reader-sync" };
  const { api, calls } = mockApi({ existing });
  assert.deepEqual(await findWorker(api), existing);
  await renameWorker(api, existing);
  assert.deepEqual(calls.slice(0, 2).map(call => call.path), ["workers/quran", "workers/quran-reader-sync"]);
  assert.equal(calls.at(-1).path, `workers/${worker.id}`);
});

test("Worker migration: falls back only on 404, never on authorization or server failures", async () => {
  for (const status of [401, 403, 409, 500]) {
    let calls = 0;
    const api = cloudflareApi(async () => { calls++; return Response.json({ success: false }, { status }); });
    await assert.rejects(findWorker(api), new RegExp(`HTTP ${status}`));
    assert.equal(calls, 1);
  }
  const absent = cloudflareApi(async () => Response.json({ success: false }, { status: 404 }));
  await assert.rejects(findWorker(absent), /refusing to create a replacement/);
});

test("Worker migration: rejects HTTP-success API failures, invalid JSON, and unexpected identities", async () => {
  for (const response of [
    Response.json({ success: false, result: worker }),
    Response.json({ success: true }),
    new Response("{invalid-json"),
    Response.json({ success: true, result: { name: "quran" } }),
  ]) {
    await assert.rejects(findWorker(cloudflareApi(async () => response)), /API success|invalid JSON|unexpected Worker identity/);
  }
  const { api } = mockApi({ renamed: { ...worker, id: "replacement-id" } });
  await assert.rejects(renameWorker(api, worker), /preserve the expected identity/);
});

test("Worker migration: surfaces name conflicts and transport failures without mutation retries", async () => {
  const conflict = cloudflareApi(async () => Response.json({ success: false }, { status: 409 }));
  await assert.rejects(renameWorker(conflict, worker), /HTTP 409/);
  const offline = cloudflareApi(async () => { throw new Error("Network unavailable"); });
  await assert.rejects(findWorker(offline), /Network unavailable/);
});

test("Worker deployment: verifies the active Durable Object namespace, not just the class name", async () => {
  const { api } = mockApi();
  assert.deepEqual(await readBindings(api, "quran"), signature);
  await verifyWorker(api, { workerId: worker.id, bindings: signature });
  await assert.rejects(verifyWorker(api, { workerId: "different-worker", bindings: signature }), /Worker identity/);
  const changed = mockApi({ bindings: [{ ...binding, namespace_id: "replacement-namespace" }] });
  await assert.rejects(verifyWorker(changed.api, { workerId: worker.id, bindings: signature }), /namespace bindings/);
});

test("Worker deployment: rejects missing or unverifiable Durable Object bindings and inactive deployments", async () => {
  for (const bindings of [[], [{ ...binding, namespace_id: undefined }], [{ ...binding, class_name: "OtherClass" }]]) {
    await assert.rejects(readBindings(mockApi({ bindings }).api, "quran"), /Cannot verify/);
  }
  const inactive = cloudflareApi(async () => Response.json({ success: true, result: { deployments: [] } }));
  await assert.rejects(readBindings(inactive, "quran"), /no active deployment/);
});

test("Worker deployment: rejects active versions with conflicting namespaces", async () => {
  const api = cloudflareApi(async url => {
    if (url.endsWith("/deployments")) {
      return Response.json({ success: true, result: { deployments: [{ versions: [
        { version_id: "first", percentage: 50 },
        { version_id: "second", percentage: 50 },
      ] }] } });
    }
    const namespace_id = url.endsWith("/first") ? "first-namespace" : "second-namespace";
    return Response.json({ success: true, result: { resources: { bindings: [{ ...binding, namespace_id }] } } });
  });
  await assert.rejects(readBindings(api, "quran"), /conflicting Durable Object namespaces/);
});
