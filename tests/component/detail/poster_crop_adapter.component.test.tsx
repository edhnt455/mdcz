import { Website } from "@mdcz/shared/enums";
import { resolvePosterEditorCropRegion } from "@mdcz/shared/posterCrop";
import { type DetailActionPort, DetailPanelAdapter } from "@mdcz/views/adapters";
import { detailImageWidths, SceneImageGallery } from "@mdcz/views/detail";
import { expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";

const sourceUrl =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="500"><rect width="100%" height="100%" fill="#c84630"/></svg>',
  );
const session = { sourceUrl, width: 900, height: 500, initialCrop: resolvePosterEditorCropRegion(900, 500) };
const item = {
  id: "root-1:ABC-001.mp4",
  resultId: "result-1",
  number: "ABC-001",
  path: "ABC-001.mp4",
  posterUrl: sourceUrl,
  status: "success" as const,
};

const createPort = (overrides: Partial<DetailActionPort> = {}): DetailActionPort => ({
  resolveImageCandidates: async (candidates) => candidates,
  readNfo: async () => ({
    path: "movie.nfo",
    crawlerData: {
      title: "Original",
      number: "ABC-001",
      actors: [],
      genres: [],
      scene_images: [],
      website: Website.DMM,
    },
  }),
  writeNfo: async () => undefined,
  preparePosterCrop: async () => session,
  savePosterCrop: async () => ({ posterUrl: `${sourceUrl}#revision` }),
  ...overrides,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

test("detail poster editor keeps the dialog open after a failed save", async () => {
  const savePosterCrop = vi.fn().mockRejectedValue(new Error("disk full"));
  const writeNfo = vi.fn().mockResolvedValue(undefined);
  const screen = await render(<DetailPanelAdapter port={createPort({ savePosterCrop, writeNfo })} item={item} />);
  await screen.getByRole("button", { name: "编辑封面" }).click();
  await screen.getByRole("button", { name: "保存封面" }).click();

  await expect.element(screen.getByRole("dialog", { name: "编辑封面" })).toBeVisible();
  expect(savePosterCrop).toHaveBeenCalledOnce();
  await screen.getByRole("button", { name: "取消" }).click();
  await expect.element(screen.getByRole("dialog", { name: "编辑封面" })).not.toBeInTheDocument();
  await screen.getByRole("button", { name: "编辑 NFO" }).click();
  await screen.getByRole("textbox", { name: "标题", exact: true }).fill("Edited title");
  await screen.getByRole("button", { name: "保存修改" }).click();
  expect(writeNfo).toHaveBeenCalledWith(item, "movie.nfo", expect.objectContaining({ title: "Edited title" }), [
    "title",
  ]);
  await expect.element(screen.getByRole("dialog", { name: "编辑 NFO 文件" })).not.toBeInTheDocument();
});

test("detail crop loads on demand and keeps late responses scoped to the selected result", async () => {
  const nextItem = { ...item, resultId: "result-2", number: "ABC-002" };
  const firstLoad = deferred<typeof session>();
  const firstSave = deferred<{ posterUrl: string }>();
  const preparePosterCrop = vi
    .fn<DetailActionPort["preparePosterCrop"]>()
    .mockReturnValueOnce(firstLoad.promise)
    .mockRejectedValueOnce(new Error("no local image"))
    .mockResolvedValue(session);
  const savePosterCrop = vi
    .fn<DetailActionPort["savePosterCrop"]>()
    .mockReturnValueOnce(firstSave.promise)
    .mockResolvedValue({ posterUrl: `${sourceUrl}#revision` });
  const port = createPort({ preparePosterCrop, savePosterCrop });
  const screen = await render(<DetailPanelAdapter port={port} item={item} />);
  await expect.element(screen.getByAltText("ABC-001")).toBeVisible();
  expect(preparePosterCrop).not.toHaveBeenCalled();
  const edit = screen.getByRole("button", { name: "编辑封面" });
  const dialog = screen.getByRole("dialog", { name: "编辑封面" });
  await edit.click();
  await expect.element(edit).toBeDisabled();
  expect(preparePosterCrop).toHaveBeenLastCalledWith(item);

  await screen.rerender(<DetailPanelAdapter port={port} item={nextItem} />);
  firstLoad.resolve(session);
  await firstLoad.promise;
  await expect.element(edit).toBeEnabled();
  await expect.element(dialog).not.toBeInTheDocument();
  expect(preparePosterCrop).toHaveBeenCalledOnce();
  await edit.click();
  await expect.element(edit).toBeEnabled();
  await expect.element(dialog).not.toBeInTheDocument();

  await edit.click();
  await screen.getByRole("button", { name: "保存封面" }).click();
  expect(savePosterCrop).toHaveBeenLastCalledWith(nextItem, session.initialCrop);
  await screen.rerender(<DetailPanelAdapter port={port} item={item} />);
  firstSave.resolve({ posterUrl: `${sourceUrl}#stale` });
  await firstSave.promise;
  await expect.element(screen.getByAltText("ABC-001")).toHaveAttribute("src", sourceUrl);

  await screen.getByRole("button", { name: "编辑封面" }).click();
  await screen.getByRole("button", { name: "保存封面" }).click();
  await expect.element(dialog).not.toBeInTheDocument();
  await expect.element(screen.getByAltText("ABC-001")).toHaveAttribute("src", `${sourceUrl}#revision`);
  await screen.rerender(<DetailPanelAdapter port={port} item={nextItem} />);
  await expect.element(screen.getByAltText("ABC-002")).toHaveAttribute("src", sourceUrl);
  await screen.rerender(<DetailPanelAdapter port={port} item={item} />);
  await expect.element(screen.getByAltText("ABC-001")).toHaveAttribute("src", `${sourceUrl}#revision`);
  expect(preparePosterCrop).toHaveBeenCalledTimes(4);
  await screen.unmount();
  const resolveImageCandidates = vi.fn(async (candidates: string[], _directory?: string, width?: number) =>
    candidates.map((candidate) => (width ? `${candidate}#w=${width}` : candidate)),
  );
  const gallery = await render(
    <SceneImageGallery
      images={[sourceUrl]}
      trailerSrc="/trailer-test.mp4"
      resolveImageCandidates={resolveImageCandidates}
    />,
  );
  await expect
    .element(gallery.getByAltText("Scene 1"))
    .toHaveAttribute("src", `${sourceUrl}#w=${detailImageWidths.scene}`);
  expect(document.querySelector("video")).toBeNull();
  await gallery.getByRole("button", { name: "播放预告片" }).click();
  await expect.poll(() => document.querySelector("video")?.getAttribute("src")).toBe("/trailer-test.mp4");
  await gallery.getByRole("button", { name: "下一张剧照" }).click();
  await expect.poll(() => document.querySelector("video")).toBeNull();
  await expect.element(gallery.getByRole("dialog").getByAltText("Scene 1")).toHaveAttribute("src", sourceUrl);
  await gallery.getByRole("button", { name: "上一张剧照" }).click();
  expect(document.querySelector("video")).toBeNull();
  await gallery.getByRole("button", { name: "播放预告片" }).last().click();
  await expect.poll(() => document.querySelector("video")).not.toBeNull();
  await gallery.getByRole("button", { name: "关闭剧照预览" }).click();
  await expect.poll(() => document.querySelector("video")).toBeNull();
});
