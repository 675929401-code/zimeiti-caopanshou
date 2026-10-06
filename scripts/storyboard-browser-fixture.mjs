const DEFAULT_TOKEN = "storyboard-browser-fixture-token";

const DEFAULT_USER = Object.freeze({
  id: "storyboard-browser-fixture-user",
  username: "storyboard_fixture",
  displayName: "分镜验收账号",
  email: "storyboard-fixture@example.invalid",
  role: "admin",
  status: "active",
  is_active: true,
  credits: 1000,
});

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function submittedAt(document) {
  const values = [document?.lastSubmittedAt];
  for (const card of document?.cards || []) {
    values.push(card?.imageSubmittedAt, card?.videoStartedAt);
  }
  const timestamps = values
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0);
  return timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : null;
}

function summary(record) {
  return {
    id: record.id,
    title: record.title,
    revision: record.revision,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    submittedAt: record.submittedAt,
    cardCount: record.cardCount,
  };
}

/**
 * Installs an authenticated, account-owned Storyboard project fixture.
 * Every project mutation stays in memory, so browser regressions exercise the
 * real save-before-dispatch gate without touching the database.
 */
export async function installStoryboardBrowserFixture(page, options = {}) {
  const origin = new URL(options.origin || "http://127.0.0.1:5000").origin;
  const token = options.token || DEFAULT_TOKEN;
  const user = { ...DEFAULT_USER, ...(options.user || {}) };
  const resetStorage = options.resetStorage !== false;
  const projects = new Map();
  const projectWrites = [];
  const projectReads = [];
  const projectDeletes = [];
  const timeline = [];

  for (const document of options.initialProjects || []) {
    const now = new Date(Number(document.updatedAt) || Date.now()).toISOString();
    projects.set(document.id, {
      id: document.id,
      title: document.title,
      revision: 1,
      createdAt: new Date(Number(document.createdAt) || Date.now()).toISOString(),
      updatedAt: now,
      submittedAt: submittedAt(document),
      cardCount: document.cards?.length || 0,
      document: clone(document),
    });
  }

  await page.addInitScript(({ expectedOrigin, sessionToken, fixtureUser, clearStorage }) => {
    if (location.origin !== expectedOrigin) return;
    if (clearStorage) {
      localStorage.clear();
      sessionStorage.clear();
    }
    localStorage.setItem("auth_token", sessionToken);
    localStorage.setItem("auth_user", JSON.stringify(fixtureUser));
    sessionStorage.setItem("entered_app", "1");
  }, {
    expectedOrigin: origin,
    sessionToken: token,
    fixtureUser: user,
    clearStorage: resetStorage,
  });

  await page.route("**/api/auth/me**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname !== "/api/auth/me") return route.fallback();
    timeline.push({ type: "auth", method: request.method(), at: Date.now() });
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ user }),
    });
  });

  await page.route("**/api/credits**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname !== "/api/credits") return route.fallback();
    timeline.push({ type: "credits", method: request.method(), at: Date.now() });
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ credits: 1000, cashBalance: 1000, transactions: [] }),
    });
  });

  await page.route("**/api/member-permissions**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname !== "/api/member-permissions") return route.fallback();
    timeline.push({ type: "member-permissions", method: request.method(), at: Date.now() });
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "Cache-Control": "private, no-store, max-age=0" },
      body: JSON.stringify({
        permission: {
          userId: user.id,
          role: user.role,
          featureNavigationKeys: [
            "marketplace",
            "toolbox",
            "storyboard_workbench",
            "image_workbench",
            "create",
            "voice",
            "cover",
            "youcai",
            "commerce_agent",
          ],
          agentNavigationKeys: [],
          revision: 1,
          checksum: "storyboard-browser-fixture",
          sourceProfileKey: null,
          sourceProfileVersion: null,
          updatedAt: null,
          updatedBy: null,
          reason: "browser fixture",
          integrityValid: true,
          authorityStatus: "admin",
        },
      }),
    });
  });

  await page.route("**/api/storyboard/projects**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname !== "/api/storyboard/projects") return route.fallback();
    const method = request.method();

    if (method === "GET") {
      const id = url.searchParams.get("id");
      projectReads.push({ id, at: Date.now() });
      timeline.push({ type: id ? "project-read" : "project-list", id, at: Date.now() });
      if (id) {
        const record = projects.get(id);
        if (!record) {
          return route.fulfill({
            status: 404,
            contentType: "application/json",
            body: JSON.stringify({ code: "PROJECT_NOT_FOUND", error: "fixture project not found" }),
          });
        }
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ project: { ...summary(record), document: clone(record.document) } }),
        });
      }
      const offset = Math.max(0, Number(url.searchParams.get("offset") || 0));
      const rows = [...projects.values()]
        .sort((left, right) => Date.parse(right.submittedAt || right.updatedAt) - Date.parse(left.submittedAt || left.updatedAt))
        .slice(offset, offset + 50)
        .map(summary);
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ projects: rows, nextOffset: null }),
      });
    }

    if (method === "POST") {
      const payload = request.postDataJSON();
      const document = clone(payload?.document);
      if (!document?.id) {
        return route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({ code: "INVALID_PROJECT", error: "fixture project id is required" }),
        });
      }
      const previous = projects.get(document.id);
      const revision = (previous?.revision || 0) + 1;
      const createdAt = previous?.createdAt || new Date(Number(document.createdAt) || Date.now()).toISOString();
      const updatedAt = new Date(Number(document.updatedAt) || Date.now()).toISOString();
      const record = {
        id: document.id,
        title: document.title || "分镜浏览器验收",
        revision,
        createdAt,
        updatedAt,
        submittedAt: submittedAt(document),
        cardCount: document.cards?.length || 0,
        document,
      };
      projects.set(record.id, record);
      const write = {
        id: record.id,
        revision,
        expectedRevision: Number(payload?.expectedRevision || 0),
        document: clone(document),
        at: Date.now(),
      };
      projectWrites.push(write);
      timeline.push({ type: "project-save", id: record.id, revision, at: write.at });
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ project: summary(record) }),
      });
    }

    if (method === "DELETE") {
      const payload = request.postDataJSON();
      const id = String(payload?.id || "");
      projects.delete(id);
      projectDeletes.push({ id, at: Date.now() });
      timeline.push({ type: "project-delete", id, at: Date.now() });
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ deleted: true, id }),
      });
    }

    return route.fulfill({
      status: 405,
      contentType: "application/json",
      body: JSON.stringify({ error: `unsupported fixture method ${method}` }),
    });
  });

  return {
    origin,
    token,
    user,
    projects,
    projectWrites,
    projectReads,
    projectDeletes,
    timeline,
    latestDocument() {
      return clone(projectWrites.at(-1)?.document);
    },
  };
}
