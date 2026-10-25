import type { EmbyDeletionSettings, EmbyDeletionStatus } from "@mdcz/shared/embyDeletion";
import type { MoviePilotSettings } from "@mdcz/shared/moviePilot";
import { EmbyDeletionPanel } from "@mdcz/views/settings/sections/EmbyDeletionPanel";
import { expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";

const createService = () => {
  const state: EmbyDeletionStatus = {
    settings: { mode: "off", serverId: "", libraryIds: [] },
    configured: false,
    libraries: [{ id: "av", name: "AV", outputPath: "/volume4/Media/AV/Link" }],
    counts: { pending: 0, completed: 0, ignored: 0, needs_review: 0 },
    recent: [],
    moviePilot: null,
    associations: { verified: 0, blocked: 0 },
  };
  return {
    origin: "http://nas:3838",
    status: vi.fn(async () => structuredClone(state)),
    configure: vi.fn(async (settings: EmbyDeletionSettings) => {
      state.settings = settings;
      return structuredClone(state);
    }),
    rotateSecret: vi.fn(async () => {
      state.configured = true;
      return { token: "one-time-secret" };
    }),
    reconcile: vi.fn(async () => ({ queued: 3 })),
    configureMoviePilot: vi.fn(async (input: MoviePilotSettings) => {
      state.moviePilot = {
        id: "connection",
        baseUrl: input.baseUrl,
        storage: input.storage,
        rootPath: input.rootPath,
        root: { storage: "u115", type: "dir", path: "/Media/AV/", fileid: "root" },
      };
      return structuredClone(state);
    }),
    testMoviePilot: vi.fn(async () => ({ storage: "u115" })),
    bindSources: vi.fn(async () => ({ verified: 1, unverified: 0 })),
    retry: vi.fn(async () => ({ success: true as const })),
  };
};

test("configures observation with the exact output library and exposes a one-time webhook address", async () => {
  const service = createService();
  const screen = await render(<EmbyDeletionPanel service={service} />);
  await screen.getByRole("button", { name: "生成 Webhook 地址" }).click();
  await expect
    .element(screen.getByRole("textbox", { name: "Emby Webhook 地址" }))
    .toHaveValue("http://nas:3838/api/webhooks/emby/one-time-secret");
  await screen.getByRole("textbox", { name: "Emby Server ID" }).fill("emby-server");
  await screen.getByRole("combobox", { name: "处理模式" }).click();
  await screen.getByRole("option", { name: "观察（只记录）" }).click();
  await screen.getByRole("checkbox", { name: /AV.*Link/ }).click();
  await screen.getByRole("button", { name: "保存联动设置" }).click();
  await expect
    .poll(() => service.configure.mock.calls)
    .toEqual([[{ mode: "observe", serverId: "emby-server", libraryIds: ["av"] }]]);
  await expect.element(screen.getByRole("status")).toHaveTextContent("联动设置已保存");
  await screen.getByRole("button", { name: "核对已登记文件" }).click();
  await expect.element(screen.getByRole("status")).toHaveTextContent("已提交 3 个文件核对");
});

test("saves MP credentials without echoing them and verifies sources after saving the copy library", async () => {
  const service = createService();
  const screen = await render(<EmbyDeletionPanel service={service} />);
  await screen.getByRole("textbox", { name: "MP 地址" }).fill("https://mp.test");
  await screen.getByLabelText("MP API_TOKEN").fill("test-mp-token");
  await screen.getByRole("button", { name: "保存并验证 MP" }).click();
  await expect
    .poll(() => service.configureMoviePilot.mock.calls)
    .toEqual([[{ baseUrl: "https://mp.test", rootPath: "/Media/AV", storage: "u115", token: "test-mp-token" }]]);
  await expect.element(screen.getByLabelText("MP API_TOKEN")).toHaveValue("");
  await screen.getByRole("button", { name: "测试已保存连接" }).click();
  await expect.poll(() => service.testMoviePilot.mock.calls.length).toBe(1);
  await screen.getByRole("textbox", { name: "Emby Server ID" }).fill("emby-server");
  await screen.getByRole("combobox", { name: "处理模式" }).click();
  await screen.getByRole("option", { name: "观察（只记录）" }).click();
  await screen.getByRole("checkbox", { name: /AV.*Link/ }).click();
  await screen.getByRole("button", { name: "保存联动设置" }).click();
  await screen.getByRole("button", { name: "核验 STRM 来源关联" }).click();
  await expect.poll(() => service.bindSources.mock.calls.length).toBe(1);
});

test("shows configuration failures without discarding edits and recovers after a successful save", async () => {
  const service = createService();
  service.configure.mockRejectedValueOnce(new Error("Library mount is offline"));
  const screen = await render(<EmbyDeletionPanel service={service} />);
  await screen.getByRole("textbox", { name: "Emby Server ID" }).fill("emby-server");
  await screen.getByRole("button", { name: "保存联动设置" }).click();
  await expect.element(screen.getByRole("alert")).toHaveTextContent("Library mount is offline");
  await expect.element(screen.getByRole("textbox", { name: "Emby Server ID" })).toHaveValue("emby-server");
  await screen.getByRole("button", { name: "保存联动设置" }).click();
  await expect.element(screen.getByRole("status")).toHaveTextContent("联动设置已保存");
  await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
});
