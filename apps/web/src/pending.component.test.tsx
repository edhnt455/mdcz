import type { PendingDetailResponse, PendingItemDto } from "@mdcz/shared/pending";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";
import { api } from "./client";
import { queryKeys } from "./lib/queryKeys";
import { PendingPage } from "./routes/pending";

test("pending selection displays local data immediately, reuses cached diagnostics and locks STRM deletion", async () => {
  const items: PendingItemDto[] = ["ABC-001.strm", "ABC-002.mp4"].map((fileName) => ({
    id: fileName,
    kind: "failed",
    ref: { rootId: "root", relativePath: fileName },
    path: `/media/${fileName}`,
    fileName,
    libraryId: null,
    libraryName: null,
    movieId: null,
    number: null,
    detail: null,
    candidates: [],
    createdAt: "2026-11-11T00:00:00.000Z",
    updatedAt: "2026-11-11T00:00:00.000Z",
  }));
  const diagnostic: PendingDetailResponse = { item: items[0], siteResults: [], numberRecognition: null };
  let resolveDetail!: (value: PendingDetailResponse) => void;
  let rejectDetail!: (error: Error) => void;
  let finishDelete!: () => void;
  const firstDetail = new Promise<PendingDetailResponse>((resolve) => {
    resolveDetail = resolve;
  });
  const secondDetail = new Promise<PendingDetailResponse>((_resolve, reject) => {
    rejectDetail = reject;
  });
  const deletion = new Promise<{ success: true }>((resolve) => {
    finishDelete = () => resolve({ success: true });
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  const list = vi.spyOn(api.pending, "list").mockResolvedValue({ items });
  const detail = vi
    .spyOn(api.pending, "detail")
    .mockReturnValueOnce(firstDetail)
    .mockReturnValueOnce(secondDetail)
    .mockResolvedValue(diagnostic);
  const remove = vi.spyOn(api.pending, "delete").mockReturnValue(deletion);
  vi.spyOn(api.deletions, "list").mockResolvedValue({ jobs: [] });
  vi.spyOn(api.libraries, "list").mockResolvedValue({ libraries: [] });
  const router = createRouter({
    routeTree: createRootRoute({ component: PendingPage }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const app = (
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
  const screen = await render(app);
  try {
    await expect.element(screen.getByRole("heading", { name: items[0].fileName })).toBeVisible();
    await expect.element(screen.getByText(items[0].path, { exact: true })).toBeVisible();
    await expect.element(screen.getByRole("status")).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "删除", exact: true })).toBeEnabled();
    await expect.element(screen.getByRole("heading", { name: "AI 番号提取" })).not.toBeInTheDocument();
    resolveDetail(diagnostic);
    await expect.element(screen.getByRole("heading", { name: "AI 番号提取" })).toBeVisible();
    await expect.element(screen.getByRole("status")).not.toBeInTheDocument();

    await screen.getByRole("button", { name: /ABC-002.mp4/ }).click();
    await expect.element(screen.getByRole("heading", { name: items[1].fileName })).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "删除", exact: true })).not.toBeInTheDocument();
    await expect.element(screen.getByRole("heading", { name: "AI 番号提取" })).not.toBeInTheDocument();
    await expect.poll(() => detail.mock.calls.length).toBe(2);
    rejectDetail(new Error("Connection lost"));
    await expect.element(screen.getByRole("alert")).toHaveTextContent("Connection lost");
    await expect.element(screen.getByRole("heading", { name: items[1].fileName })).toBeVisible();
    await expect.element(screen.getByRole("status")).not.toBeInTheDocument();

    await screen.getByRole("button", { name: /ABC-001.strm/ }).click();
    await expect.element(screen.getByRole("heading", { name: "AI 番号提取" })).toBeVisible();
    expect(detail).toHaveBeenCalledTimes(2);
    await screen.rerender(<div />);
    await screen.rerender(app);
    await expect.element(screen.getByRole("heading", { name: "AI 番号提取" })).toBeVisible();
    expect(list).toHaveBeenCalledOnce();
    expect(detail).toHaveBeenCalledTimes(2);

    detail.mockResolvedValue({ ...diagnostic, numberRecognition: { status: "skipped", reason: "disabled" } });
    await client.invalidateQueries({ queryKey: queryKeys.pending.all });
    await expect.element(screen.getByText("未执行 AI 提取", { exact: true })).toBeVisible();
    expect(detail).toHaveBeenCalledTimes(3);
    await screen.getByRole("button", { name: "删除", exact: true }).click();
    expect(remove).toHaveBeenCalledExactlyOnceWith({ id: items[0].id });
    await expect.element(screen.getByRole("dialog")).not.toBeInTheDocument();
    await expect.element(screen.getByRole("button", { name: "正在删除…" })).toBeDisabled();
    await expect
      .element(screen.getByText("正在核验 115 来源并删除文件，具体进度和耗时可在运行日志查看。"))
      .toBeVisible();
    await expect.element(screen.getByRole("button", { name: "忽略", exact: true })).toBeDisabled();
    list.mockResolvedValue({ items: [] });
    finishDelete();
    await expect.element(screen.getByRole("heading", { name: items[0].fileName })).not.toBeInTheDocument();
    await expect.element(screen.getByRole("button", { name: "删除", exact: true })).not.toBeInTheDocument();
    await expect
      .element(screen.getByText("正在核验 115 来源并删除文件，具体进度和耗时可在运行日志查看。"))
      .not.toBeInTheDocument();
  } finally {
    resolveDetail(diagnostic);
    finishDelete();
    screen.unmount();
    client.clear();
    vi.restoreAllMocks();
  }
});
