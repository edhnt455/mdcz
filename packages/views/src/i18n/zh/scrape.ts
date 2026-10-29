import type { Messages } from "../en";

export const scrape: Messages["scrape"] = {
  conflict: {
    referenceErrors: {
      missingSource: (path: string) =>
        `下列 Link STRM 已不存在，且影片记录没有可核验的来源信息，无法确认它原来引用哪个 115 视频。请修复这条残留记录或来源关联：\n${path}`,
      shared: (path: string) => `另一个已入库 STRM 仍引用要删除的 115 视频，本次未执行删除。请先处理该引用：\n${path}`,
      unverified: (path: string) =>
        `无法读取或识别下列 STRM，尚不能排除它引用要删除的 115 视频。本次未执行删除，请检查该文件或修复来源关联：\n${path}`,
    },
    setupErrors: {
      moviePilotRequired:
        "尚未配置 MoviePilot。请到「设置 → 媒体服务器 → Emby → MoviePilot · 115 STRM 联动」填写 MP 地址、API_TOKEN 和 115 允许根目录，点击「保存并验证 MP」。",
      copyLibraryRequired: "此操作需要复制媒体库，请先在媒体库设置中将视频放置方式设为「复制」。",
      libraryBindingRequired:
        "尚未保存当前复制媒体库的 STRM 联动范围。请到「设置 → 媒体服务器 → Emby」勾选当前媒体库，点击「保存联动设置」，再点击「核验 STRM 来源关联」。手动处理重复可保持处理模式「关闭」，无需填写 Emby Server ID 或生成 Webhook。",
      libraryPathsChanged: "当前媒体库的来源或输出目录已变更，请重新保存 STRM 联动设置并核验来源关联。",
    },
    openSettings: "在新标签页打开 STRM 联动设置",
    open: "处理重复",
    title: "选择要保留的版本",
    description: "比较 115 源视频的实际大小后，选择要保留的版本。另一个版本将被删除。",
    keepExisting: "保留已入库版本",
    keepIncoming: "保留本次新版本",
    cloud: "115 源视频",
    loading: "正在核验双方的 115 源文件…",
    deleting: "正在删除所选淘汰版本并核验结果…",
    sameResource: "两个 STRM 指向同一个 115 视频，将保留云端视频，只清理多余的本地 STRM。",
    willDelete: "将删除以下版本：",
    deleteIncoming: "删除它对应的 Normal STRM，保留现有 Link STRM。",
    deleteExisting: "删除它对应的 Normal 和 Link STRM，再重试本次新版本的刮削。",
    deleteCloud: "同时删除此版本在 115 上的源视频。",
    confirm: "删除另一版本并继续",
    completed: "重复已处理。",
  },
  stages: {
    discovering: "扫描视频文件",
    prepare: "抓取元数据",
    "check-output": "检查冲突",
    execute: "整理归档",
    search: "搜索中",
    download: "下载资产",
    completed: "未找到待处理视频",
  },
  launch: {
    selection: "已启动所选文件刮削",
    singleFile: "单文件刮削任务已启动",
    retry: "已启动重试",
    manualUrl: "已启动按 URL 刮削",
  },

  // ScrapeStartErrorDialog
  incompleteTitle: "刮削任务未能完成",
  incompleteDesc: "请查看任务结果，处理以下问题后重试：",
  understood: "我知道了",

  // UncensoredConfirmDialog
  uncensored: {
    title: "确认无码类型",
    description: "请手动确认以下影片类型",
    batchSetTo: "批量设为：",
    skip: "跳过",
    confirm: "确认",
    noItemsToSubmit: "没有可提交的条目",
    options: {
      umr: "破解",
      leak: "流出",
      uncensored: "无码",
    },
  },

  // ScrapeWorkbenchAdapter
  taskQueued: "任务已排队",
  scanningVideoFiles: "正在扫描视频文件",
  stoppingWaitingCurrent: "正在停止，等待当前文件处理完成",
  noVideosFound: "未找到可处理视频",
  taskStopped: "任务已停止",
  taskInterrupted: "任务已中断",
  preparingTask: "正在准备任务",
  taskInterruptedHint: "任务在完成前被中断，可以重新刮削此目录再次运行。",

  // ResultTreeAdapter
  numberEmpty: "番号为空",
  numberCopied: "已复制番号",
  copyNumberFailed: "复制番号失败",
  rescrapeFailed: "重新刮削失败",
  confirmRemoveGroup: (count: number, number: string) => `确定从媒体库移除 ${count} 项记录吗？\n${number}`,
  confirmRemoveSingle: (path: string) => `确定从媒体库移除记录吗？\n${path}`,
  removedSuccess: "已从媒体库移除",
  operationFailed: "操作失败",
  noOpenablePath: "无可打开的文件路径",
  openFolderFailed: (error: string) => `打开目录失败: ${error}`,
  unrecognizedNumber: "未识别番号",
  copyNumber: "复制番号",
  pathCopied: "已复制路径",
  copyPathFailed: "复制路径失败",
  copyPath: "复制路径",
  rescrape: "重新刮削",
  rescrapeByUrl: "按 URL 重新刮削",
  rescrapeByNumber: "按番号重新刮削（移除固定详情页）",
  removeFromLibrary: "从媒体库移除",
  openSourceFolder: "打开源目录",
  openMetadataFolder: "打开元数据目录",
  editNfo: "编辑 NFO",
  play: "播放",
  metrics: {
    total: "总计",
    success: "成功",
    failed: "失败",
  },
  rescrapeByUrlFailed: "按 URL 重新刮削失败",

  // DetailPanelAdapter
  emptyMessage: "请选择一个项目以查看详情",
  selectItemFirst: "请先选择一个项目",
  loadNfoFailed: (error: string) => `加载 NFO 失败: ${error}`,
  checkFormContent: "请检查表单内容",
  nfoSaved: "NFO 已保存",
  saveNfoFailed: (error: string) => `保存 NFO 失败: ${error}`,
  discardNfoChanges: "放弃未保存的 NFO 修改？",
  discardPosterChanges: "放弃未保存的封面修改？",
  coverSaved: "封面已保存",
  saveCoverFailed: (error: string) => `保存封面失败: ${error}`,
};
