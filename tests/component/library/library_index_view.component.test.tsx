import type { LibraryEntryDto } from "@mdcz/shared/serverDtos";
import { type LibraryBrowseControls, LibraryEditForm, LibraryIndexView, useLibraryView } from "@mdcz/views/library";
import { expect, test, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

const createEntry = (id: string, available: LibraryEntryDto["available"]): LibraryEntryDto => ({
  actors: [],
  assets: [],
  available,
  crawlerData: null,
  createdAt: "2026-08-17T00:00:00.000Z",
  displayFileId: `file-${id}`,
  fileRefs: [],
  hiddenFromRecentAt: null,
  id,
  lastRefreshedAt: null,
  mediaIdentity: id,
  number: id,
  size: 10,
  thumbnailPath: null,
  title: `${id} title`,
});

const baseProps = {
  entries: [
    createEntry("AVAILABLE", "available"),
    createEntry("UNKNOWN", "unchecked"),
    createEntry("UNAVAILABLE", "unavailable"),
  ],
  page: 1,
  pageSize: 10 as const,
  selectionKey: "all",
  onPageChange: vi.fn(),
  onPageSizeChange: vi.fn(),
  onSelectAll: vi.fn(async () => baseProps.entries),
  onDeleteEntries: vi.fn(),
  onQueryChange: vi.fn(),
  onRefresh: vi.fn(),
  query: "",
  total: 3,
};

test("numbered pagination shows matching totals, supported sizes, boundaries, and page jumps", async () => {
  const onPageChange = vi.fn();
  const onPageSizeChange = vi.fn();
  const props = { ...baseProps, total: 630, onPageChange, onPageSizeChange };
  const screen = await render(<LibraryIndexView {...props} />);
  await expect.element(screen.getByText("共 630 部 · 第 1 / 63 页")).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "上一页" })).toBeDisabled();
  await expect.element(screen.getByRole("button", { name: /^可用/u })).not.toBeInTheDocument();
  await expect.element(screen.getByText("UNKNOWN title")).toBeVisible();
  await expect.element(screen.getByText("UNAVAILABLE title")).toBeVisible();
  await screen.getByRole("button", { name: "下一页" }).click();
  expect(onPageChange).toHaveBeenLastCalledWith(2);
  await screen.getByRole("button", { name: "第 63 页", exact: true }).click();
  expect(onPageChange).toHaveBeenLastCalledWith(63);
  for (const size of [20, 30, 50, 100, 10]) {
    await screen.getByRole("combobox", { name: "每页条数" }).selectOptions(String(size));
    expect(onPageSizeChange).toHaveBeenLastCalledWith(size);
  }
  await screen.getByRole("spinbutton", { name: "跳转" }).fill("12");
  await screen.getByRole("button", { name: "跳转", exact: true }).click();
  expect(onPageChange).toHaveBeenLastCalledWith(12);
  await screen.rerender(<LibraryIndexView {...props} page={63} />);
  await expect.element(screen.getByRole("button", { name: "下一页" })).toBeDisabled();
  await screen.rerender(<LibraryIndexView {...props} page={1} total={0} entries={[]} query="no match" />);
  await expect.element(screen.getByText("共 0 部 · 第 1 / 1 页")).toBeVisible();
  await expect.element(screen.getByText("暂无匹配条目")).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "下一页" })).toBeDisabled();
});

test("selection spans every matching page, excludes unchecked movies, and resets only when its scope changes", async () => {
  const matches = Array.from({ length: 120 }, (_, index) => createEntry(`MOVIE-${index + 1}`, "available"));
  const onSelectAll = vi.fn(async () => matches);
  const onDeleteEntries = vi.fn();
  const onEditEntries = vi.fn();
  const props = {
    ...baseProps,
    total: 120,
    entries: matches.slice(0, 10),
    onSelectAll,
    onDeleteEntries,
    onEditEntries,
  };
  const screen = await render(<LibraryIndexView {...props} />);
  const multiSelect = screen.getByRole("button", { name: "多选" });
  const selectAll = screen.getByRole("checkbox", { name: "全选筛选结果" });
  await expect.element(selectAll).not.toBeInTheDocument();
  await multiSelect.click();
  await selectAll.click();
  await expect.element(screen.getByText("已选 120 部影片")).toBeVisible();
  await expect.element(selectAll).toBeChecked();
  await screen.rerender(<LibraryIndexView {...props} page={2} entries={matches.slice(10, 20)} />);
  await expect.element(screen.getByRole("checkbox", { name: "选择 MOVIE-11", exact: true })).toBeChecked();
  await screen.getByRole("checkbox", { name: "选择 MOVIE-11", exact: true }).click();
  await expect.element(screen.getByText("已选 119 部影片")).toBeVisible();
  await expect.element(selectAll).toHaveAttribute("data-state", "indeterminate");
  await screen.getByRole("button", { name: "深度删除", exact: true }).last().click();
  expect(onDeleteEntries.mock.lastCall?.[0].map((entry: LibraryEntryDto) => entry.id)).toEqual(
    matches.filter((entry) => entry.id !== "MOVIE-11").map((entry) => entry.id),
  );
  await screen.getByRole("button", { name: "编辑", exact: true }).click();
  expect(onEditEntries).toHaveBeenLastCalledWith(onDeleteEntries.mock.lastCall?.[0]);
  const added = createEntry("NEW", "available");
  await screen.rerender(
    <LibraryIndexView {...props} pageSize={20} entries={[added, ...matches.slice(0, 19)]} total={121} />,
  );
  await expect.element(screen.getByText("已选 119 部影片")).toBeVisible();
  await expect.element(screen.getByRole("checkbox", { name: "选择 NEW", exact: true })).not.toBeChecked();
  expect(onSelectAll).toHaveBeenCalledOnce();
  await screen.rerender(<LibraryIndexView {...props} selectionKey="missingSynopsis" />);
  await expect.element(screen.getByText(/^已选/u)).not.toBeInTheDocument();
  await multiSelect.click();
  await expect.element(screen.getByRole("checkbox", { name: "选择 MOVIE-1", exact: true })).not.toBeChecked();
  await selectAll.click();
  await expect.element(screen.getByText("已选 120 部影片")).toBeVisible();
  await selectAll.click();
  await expect.element(screen.getByText(/^已选/u)).not.toBeInTheDocument();
});

test("an unfinished select-all cannot select movies in a different filter", async () => {
  let resolve!: (entries: LibraryEntryDto[]) => void;
  const onSelectAll = vi.fn(
    () =>
      new Promise<LibraryEntryDto[]>((done) => {
        resolve = done;
      }),
  );
  const props = { ...baseProps, onSelectAll };
  const screen = await render(<LibraryIndexView {...props} />);
  await screen.getByRole("button", { name: "多选" }).click();
  await screen.getByRole("checkbox", { name: "全选筛选结果" }).click();
  await expect.element(screen.getByRole("checkbox", { name: "全选筛选结果" })).toBeDisabled();
  await screen.rerender(<LibraryIndexView {...props} selectionKey="new-filter" />);
  resolve(baseProps.entries);
  await screen.getByRole("button", { name: "多选" }).click();
  await expect.element(screen.getByRole("checkbox", { name: "选择 AVAILABLE" })).not.toBeChecked();
  await expect.element(screen.getByText(/^已选/u)).not.toBeInTheDocument();
});

test("a health filter offers to ignore its movies, and the ignored view only restores them", async () => {
  const browse = {
    libraries: [],
    summary: {
      total: 3,
      issues: { missingPoster: 0, missingBackdrop: 0, missingSynopsis: 3, noNfo: 0, duplicate: 3 },
      ignored: 1,
      facets: { actors: [], studios: [], tags: [] },
    },
    ignored: false,
    view: "list",
    onLibraryChange: vi.fn(),
    onHealthChange: vi.fn(),
    onIgnoredChange: vi.fn(),
    onFacetChange: vi.fn(),
    onClear: vi.fn(),
    onViewChange: vi.fn(),
    onFix: vi.fn(async () => undefined),
    onIgnore: vi.fn(async () => undefined),
    onRestore: vi.fn(async () => undefined),
  } satisfies LibraryBrowseControls;
  const view = (controls: Partial<LibraryBrowseControls>) => (
    <LibraryIndexView {...baseProps} browse={{ ...browse, ...controls }} />
  );
  const screen = await render(view({ health: "missingSynopsis" }));
  const refresh = screen.getByRole("button", { name: "从站点刷新 3 部" });
  const ignore = screen.getByRole("button", { name: "忽略这 3 部" });
  const restore = screen.getByRole("button", { name: "取消忽略 3 部" });

  await expect.element(refresh).toBeVisible();
  await ignore.click();
  expect(browse.onIgnore).toHaveBeenCalledWith("missingSynopsis");

  await screen.rerender(view({ health: "duplicate" }));
  await expect.element(refresh).not.toBeInTheDocument();
  await expect.element(ignore).toBeVisible();

  await screen.rerender(view({ ignored: true }));
  await expect.element(screen.getByRole("button", { name: /^已忽略\s*1$/u })).toHaveAttribute("aria-pressed", "true");
  await expect.element(ignore).not.toBeInTheDocument();
  await restore.click();
  expect(browse.onRestore).toHaveBeenCalledOnce();
});

test("library view preference survives remounts", async () => {
  const previous = localStorage.getItem("mdcz.library.view");
  localStorage.removeItem("mdcz.library.view");
  function Preference() {
    const { view, onViewChange } = useLibraryView();
    return (
      <button type="button" onClick={() => onViewChange(view === "list" ? "wall" : "list")}>
        {view}
      </button>
    );
  }
  try {
    const first = await render(<Preference />);
    await first.getByRole("button", { name: "list", exact: true }).click();
    await first.unmount();
    const second = await render(<Preference />);
    await second.getByRole("button", { name: "wall", exact: true }).click();
    expect(localStorage.getItem("mdcz.library.view")).toBe("list");
  } finally {
    if (previous === null) localStorage.removeItem("mdcz.library.view");
    else localStorage.setItem("mdcz.library.view", previous);
  }
});

test("library edits preview changes, exclude movies, and block disabled fields or busy tasks", async () => {
  const onSubmit = vi.fn();
  const entries = ["ONE", "TWO"].map((id) => ({
    ...createEntry(id, "available"),
    crawlerData: { title: id, number: id, actors: ["Alice"], genres: ["Drama"], studio: "Old", scene_images: [] },
  }));
  const props = { entries, ignoredFields: ["director"] as const, onSubmit };
  const screen = await render(<LibraryEditForm {...props} />);
  await screen.getByRole("textbox", { name: "值", exact: true }).fill("New studio");
  await expect.element(screen.getByRole("option", { name: /导演/u })).toBeDisabled();
  await screen.getByRole("checkbox", { name: "选择 TWO" }).click();
  await screen.getByRole("textbox", { name: "值", exact: true }).click();
  await userEvent.keyboard("{Enter}");
  expect(onSubmit).toHaveBeenLastCalledWith({
    ids: ["ONE"],
    edit: { field: "studio", operation: "set", value: "New studio" },
  });
  await screen.rerender(<LibraryEditForm {...props} blockedReason="维护任务正在运行" />);
  await expect.element(screen.getByRole("button", { name: "更改 1 部影片" })).toBeDisabled();
  await screen.rerender(<LibraryEditForm {...props} />);
  await screen.getByRole("combobox", { name: "字段" }).selectOptions("actors");
  await screen.getByRole("combobox", { name: "操作" }).selectOptions("rename");
  await screen.getByRole("textbox", { name: "新值" }).fill("Renamed");
  await userEvent.keyboard("{Enter}");
  expect(onSubmit).toHaveBeenLastCalledWith({
    ids: ["ONE", "TWO"],
    edit: { field: "actors", operation: "rename", from: "Alice", to: "Renamed" },
  });
});
