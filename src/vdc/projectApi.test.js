import { loadProject, saveProject } from "./projectApi";

jest.mock("firebase/auth", () => ({ getAuth: () => ({ currentUser: { getIdToken: async () => "токен" } }) }));

const KEY = "АВ/24-11/187-1.6-АР";
const state = { version: 1, sections: "1, 2", wallHeight: "2,72", manualValues: { "1|1|plinth": "8,5" } };
const reply = (status, body) => Promise.resolve({ ok: status < 400, status, json: async () => body });

beforeEach(() => {
  localStorage.clear();
  global.fetch = jest.fn();
});

describe("загрузка проекта", () => {
  it("сервер вернул сохранение — оно и открывается; запрос с токеном и закодированным шифром", async () => {
    fetch.mockImplementation(() => reply(200, { found: true, state, updatedAt: "2026-11-06T09:00:00.000Z", updatedBy: "a@vkdev.kz" }));
    const r = await loadProject(KEY);
    expect(r).toMatchObject({ found: true, source: "server", updatedBy: "a@vkdev.kz" });
    expect(r.state.manualValues).toEqual(state.manualValues);
    const [url, options] = fetch.mock.calls[0];
    expect(url).toContain(`/api/vdc/projects/${encodeURIComponent(KEY)}`);
    expect(url).not.toContain("АВ/24"); // слэши в шифре закодированы
    expect(options.method).toBe("GET");
    expect(options.headers.Authorization).toBe("Bearer токен");
  });

  it("на сервере проекта нет — found: false", async () => {
    fetch.mockImplementation(() => reply(200, { found: false }));
    expect(await loadProject(KEY)).toMatchObject({ found: false });
  });

  it("сервер недоступен — берётся копия из этого браузера и показывается причина", async () => {
    fetch.mockImplementation(() => reply(503, { error: "Хранилище недоступно" }));
    localStorage.setItem(`vdc-project:${KEY}`, JSON.stringify({ state, updatedAt: "2026-11-05T10:00:00.000Z" }));
    const r = await loadProject(KEY);
    expect(r).toMatchObject({ found: true, source: "browser", serverError: "Хранилище недоступно" });
    expect(r.state.sections).toBe("1, 2");
  });

  it("сервер недоступен и копии нет — не найдено, с причиной", async () => {
    fetch.mockImplementation(() => Promise.reject(new Error("Failed to fetch")));
    expect(await loadProject(KEY)).toEqual({ found: false, serverError: "Failed to fetch" });
  });
});

describe("сохранение проекта", () => {
  it("пишет на сервер и всегда оставляет копию в браузере", async () => {
    fetch.mockImplementation(() => reply(200, { ok: true, updatedAt: "2026-11-06T09:30:00.000Z" }));
    const r = await saveProject(KEY, state);
    expect(r).toMatchObject({ ok: true, source: "server", updatedAt: "2026-11-06T09:30:00.000Z" });
    const [, options] = fetch.mock.calls[0];
    expect(options.method).toBe("PUT");
    expect(JSON.parse(options.body)).toEqual({ state });
    expect(JSON.parse(localStorage.getItem(`vdc-project:${KEY}`)).state).toEqual(state);
  });

  it("сервер не принял — ok: false с причиной, данные не потеряны (копия в браузере)", async () => {
    fetch.mockImplementation(() => reply(503, { error: "Хранилище недоступно" }));
    const r = await saveProject(KEY, state);
    expect(r).toMatchObject({ ok: false, source: "browser", error: "Хранилище недоступно" });
    expect(JSON.parse(localStorage.getItem(`vdc-project:${KEY}`)).state.wallHeight).toBe("2,72");
  });

  it("сохранённое в браузере открывается после неудачной отправки", async () => {
    fetch.mockImplementation(() => Promise.reject(new Error("offline")));
    await saveProject(KEY, state);
    const r = await loadProject(KEY);
    expect(r).toMatchObject({ found: true, source: "browser" });
    expect(r.state.manualValues).toEqual(state.manualValues);
  });
});
