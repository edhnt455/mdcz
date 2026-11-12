import { Website } from "@mdcz/shared/enums";
import { resolvePosterEditorCropRegion } from "@mdcz/shared/posterCrop";
import { type DetailActionPort, DetailPanelAdapter } from "@mdcz/views/adapters";
import { SceneImageGallery } from "@mdcz/views/detail";
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

test("detail poster editor hides remote-only failures and refreshes a successful save", async () => {
  const unavailable = await render(
    <DetailPanelAdapter
      port={createPort({ preparePosterCrop: async () => await Promise.reject(new Error("no local image")) })}
      item={item}
    />,
  );
  await expect.element(unavailable.getByRole("button", { name: "编辑封面" })).not.toBeInTheDocument();
  await unavailable.unmount();

  const screen = await render(<DetailPanelAdapter port={createPort()} item={item} />);
  await screen.getByRole("button", { name: "编辑封面" }).click();
  await screen.getByRole("button", { name: "保存封面" }).click();
  await expect.element(screen.getByRole("dialog", { name: "编辑封面" })).not.toBeInTheDocument();
  await expect.element(screen.getByAltText("ABC-001")).toHaveAttribute("src", `${sourceUrl}#revision`);
  await screen.unmount();
  const gallery = await render(
    <SceneImageGallery
      images={[sourceUrl]}
      trailerSrc="/trailer-test.mp4"
      resolveImageCandidates={async (candidates) => candidates}
    />,
  );
  expect(document.querySelector("video")).toBeNull();
  await gallery.getByRole("button", { name: "播放预告片" }).click();
  await expect.poll(() => document.querySelector("video")?.getAttribute("src")).toBe("/trailer-test.mp4");
  await gallery.getByRole("button", { name: "下一张剧照" }).click();
  await expect.poll(() => document.querySelector("video")).toBeNull();
  await gallery.getByRole("button", { name: "上一张剧照" }).click();
  expect(document.querySelector("video")).toBeNull();
  await gallery.getByRole("button", { name: "播放预告片" }).last().click();
  await expect.poll(() => document.querySelector("video")).not.toBeNull();
  await gallery.getByRole("button", { name: "关闭剧照预览" }).click();
  await expect.poll(() => document.querySelector("video")).toBeNull();
});
