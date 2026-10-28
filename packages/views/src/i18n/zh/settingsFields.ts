import { DEFAULT_LLM_BASE_URL } from "@mdcz/shared/llm";
import type { Messages } from "../en";

export const settingsFields: Messages["settingsFields"] = {
  sections: {
    paths: { label: "路径", aliases: ["路径", "目录", "排除", "演员头像"] },
    scrape: { label: "刮削设置" },
    sites: { label: "站点", aliases: ["网站", "刮削站点", "cookie", "镜像"] },
    network: { label: "网络连接" },
    translate: { label: "翻译服务" },
    naming: { label: "命名规则" },
    download: { label: "下载选项" },
    mediaServer: { label: "媒体服务器", aliases: ["媒体服务器", "Jellyfin", "Emby", "人物", "演员"] },
    automation: {
      label: "集成",
      aliases: ["集成", "自动化", "下载器", "qBittorrent", "CloudDrive", "API Key", "通知", "推送"],
    },
  },
  fields: {
    "translate.deeplApiKey": {
      label: "DeepL API Key",
      description: "以 :fx 结尾的 Free Key 使用 Free 接口，其余使用 Pro 接口。",
    },
    "translate.baiduService": {
      label: "百度翻译服务",
      description: "需在百度翻译开放平台开通对应服务；通用文本翻译使用密钥，大模型文本翻译使用 API Key。",
    },
    "translate.baiduAppId": { label: "百度翻译 APPID", description: "在百度翻译开放平台「开发者信息」页面查看。" },
    "translate.baiduSecretKey": { label: "百度翻译密钥", description: "在「开发者信息」页面查看。" },
    "translate.baiduApiKey": { label: "百度翻译 API Key", description: "在管理控制台「API Key 管理」页面创建。" },
    "paths.defaultScanExcludeDirs": {
      label: "排除目录",
      description: "扫描媒体库时自动跳过这些文件夹。",
      aliases: ["排除目录", "扫描排除"],
    },
    "paths.actorPhotoFolder": {
      label: "本地演员头像库目录",
      description: "仅当“人物头像来源顺序”启用“本地”时读取，用于本地头像覆盖和媒体服务器头像同步。",
      aliases: ["头像", "演员"],
    },
    "paths.sceneImagesFolder": { label: "剧照目录名" },
    "paths.outputSummaryPath": { label: "概览统计目录", description: "留空则使用整理目标目录", aliases: ["概览目录"] },
    "paths.configDirectory": { label: "配置文件目录", aliases: ["配置目录"] },
    "scrape.sites": {
      label: "站点顺序",
      description: "勾选决定是否参与刮削，上下移动调整优先级。未勾选的站保留位置，刮削时跳过。",
      aliases: ["网站优先级", "站点优先级", "排序"],
    },
    "scrape.siteOrder": { label: "站点位置" },
    "scrape.r18MetadataLanguage": { label: "R18.dev 元数据语言" },
    "scrape.aiNumberFallback": {
      label: "AI 番号识别兜底",
      description:
        "未提取到番号，或至少一个站点正常响应但所有站点均未查到影片时，尝试用 AI 提取番号。复用翻译设置中的 LLM 配置，无需启用翻译；会发送文件名和直接父目录名，仍失败则交由手动处理。",
      aliases: ["AI", "LLM", "番号", "兜底"],
    },
    "scrape.filenameIgnoreTokens": {
      label: "番号识别忽略词",
      description: "番号识别前忽略这些文字；仅影响识别，不修改文件名。支持 Enter、逗号或空格分割添加。",
    },
    "scrape.filenameBlacklistTokens": {
      label: "自动扫描黑名单词",
      description:
        "自动扫描时排除名称包含这些文字的文件和文件夹（含其下所有内容）；匹配时不区分大小写。支持 Enter、逗号或空格分割添加。",
    },
    "scrape.minVideoSizeMb": {
      label: "最小视频大小 (MB)",
      description: "小于该大小的视频不进入刮削候选，0 表示不限制；STRM 文件不受影响。",
    },
    "scrape.subtitleKeywords": {
      label: "字幕关键词",
      description:
        "识别中文字幕，支持多个关键词，匹配文件名和完整路径，不区分大小写。短英文标记按分隔符匹配；支持 Enter、逗号分割添加，清空可关闭关键词识别。",
    },
    "scrape.umrKeywords": {
      label: "破解关键词",
      description:
        "识别无码破解，支持多个关键词，匹配文件名和完整路径，不区分大小写。短英文标记按分隔符匹配；与无码、流出同时命中时优先采用破解。",
    },
    "scrape.uncensoredKeywords": {
      label: "无码关键词",
      description:
        "识别无码版本，支持多个关键词，匹配文件名和完整路径，不区分大小写。短英文标记按分隔符匹配；不影响根据番号识别无码片商。",
    },
    "scrape.leakKeywords": {
      label: "流出关键词",
      description:
        "识别无码流出，支持多个关键词，匹配文件名和完整路径，不区分大小写。短英文标记按分隔符匹配；优先级低于破解、高于普通无码。",
    },
    "scrape.threadNumber": { label: "并发线程数" },
    "scrape.javdbDelaySeconds": { label: "JavDB 请求延迟(秒)" },
    "scrape.restAfterCount": { label: "连续刮削后休息(条数)" },
    "scrape.restDuration": { label: "休息时长" },
    "network.proxyType": { label: "代理类型" },
    "network.proxy": { label: "代理地址" },
    "network.useProxy": { label: "启用代理" },
    "network.directSites": { label: "直连站点（绕过代理）" },
    "network.timeout": { label: "超时时间(秒)" },
    "network.retryCount": { label: "重试次数" },
    "network.javdbUrl": {
      label: "JavDB 地址",
      description: "留空使用官网 https://javdb.com；官网无法访问时可填写防屏蔽镜像地址。",
      aliases: ["镜像", "防屏蔽", "网址", "域名"],
    },
    "network.javbusUrl": {
      label: "JavBus 地址",
      description: "留空使用官网 https://www.javbus.com；官网无法访问时可填写防屏蔽镜像地址。",
      aliases: ["镜像", "防屏蔽", "网址", "域名"],
    },
    "network.javdbCookie": { label: "JavDB Cookie", aliases: ["凭证"] },
    "network.javbusCookie": { label: "JavBus Cookie", aliases: ["凭证"] },
    "network.fantiaCookie": { label: "Fantia Cookie", aliases: ["凭证"] },
    "aggregation.fieldPriorities.title": {
      label: "标题来源顺序",
      description: "按站点顺序选择影片标题。",
      aliases: ["标题", "字段来源"],
    },
    "aggregation.fieldPriorities.plot": {
      label: "简介来源顺序",
      description: "按站点顺序选择影片简介。",
      aliases: ["简介", "剧情"],
    },
    "aggregation.fieldPriorities.actors": {
      label: "演员来源顺序",
      description: "按站点顺序选择演员列表。",
      aliases: ["演员"],
    },
    "aggregation.fieldPriorities.genres": {
      label: "类型来源顺序",
      description: "按站点顺序选择类型与标签。",
      aliases: ["类型", "标签"],
    },
    "aggregation.fieldPriorities.thumb_url": {
      label: "缩略图来源顺序",
      description: "按站点顺序选择横版缩略图。",
      aliases: ["缩略图"],
    },
    "aggregation.fieldPriorities.poster_url": {
      label: "海报来源顺序",
      description: "按站点顺序选择海报。",
      aliases: ["海报"],
    },
    "aggregation.fieldPriorities.scene_images": {
      label: "剧照来源顺序",
      description: "按站点顺序选择剧照集合。",
      aliases: ["剧照"],
    },
    "aggregation.fieldPriorities.studio": {
      label: "片商来源顺序",
      description: "按站点顺序选择片商信息。",
      aliases: ["片商"],
    },
    "aggregation.fieldPriorities.director": {
      label: "导演来源顺序",
      description: "按站点顺序选择导演信息。",
      aliases: ["导演"],
    },
    "aggregation.fieldPriorities.publisher": {
      label: "发行商来源顺序",
      description: "按站点顺序选择发行商信息。",
      aliases: ["发行商"],
    },
    "aggregation.fieldPriorities.series": {
      label: "系列来源顺序",
      description: "按站点顺序选择系列信息。",
      aliases: ["系列"],
    },
    "aggregation.fieldPriorities.release_date": {
      label: "发行日期来源顺序",
      description: "按站点顺序选择发行日期。",
      aliases: ["发行日期"],
    },
    "aggregation.fieldPriorities.durationSeconds": {
      label: "时长来源顺序",
      description: "按站点顺序选择影片时长。",
      aliases: ["时长"],
    },
    "aggregation.fieldPriorities.rating": {
      label: "评分来源顺序",
      description: "按站点顺序选择评分。",
      aliases: ["评分"],
    },
    "aggregation.fieldPriorities.trailer_url": {
      label: "预告片来源顺序",
      description: "按站点顺序选择预告片地址。",
      aliases: ["预告片"],
    },
    "aggregation.maxParallelCrawlers": {
      label: "聚合并行站点数",
      description: "同一影片聚合抓取时，最多同时请求多少个站点。",
      aliases: ["并行站点", "聚合并发"],
    },
    "aggregation.perCrawlerTimeoutMs": {
      label: "单站超时 (ms)",
      description: "单个站点在聚合阶段允许的最长等待时间。",
      aliases: ["单站超时"],
    },
    "aggregation.globalTimeoutMs": {
      label: "全局超时 (ms)",
      description: "单部影片整次聚合抓取允许的总超时时间，必须大于单站超时。",
      aliases: ["全局超时"],
    },
    "download.tagBadgeTargets": {
      label: "添加水印的图片类型",
      description: "仅处理本次新下载或生成的图片，保留的已有图片不会重复添加。",
    },
    "download.tagBadgeStyle": { label: "水印样式" },
    "download.tagBadgeResolutionStyle": {
      label: "分辨率水印样式",
      description: "用于 1080P、4K、8K。MDCx 的 1080P 使用内建缎带样式。",
    },
    "download.tagBadgeLayout": {
      label: "布局方式",
      description: "横向排列：在起始角落依次排列；顺时针或逆时针：在四角依次添加。",
    },
    "download.tagBadgeScale": {
      label: "缩放倍率",
      description: "水印高度 = 图片高度 ÷ 倍率；倍率越大，水印越小。空间不足时自动缩小。",
    },
    "download.tagBadgeOffsetX": { label: "横向偏移（像素）", description: "距离图片左右边缘的最小距离。" },
    "download.tagBadgeOffsetY": { label: "纵向偏移（像素）", description: "距离图片上下边缘的最小距离。" },
    "download.tagBadgeGap": { label: "水印间距（像素）" },
    "download.tagBadgeDirectory": {
      label: "自定义水印目录",
      description: "留空使用数据目录下的 watermark 文件夹。Web 端填写服务器上的目录。",
    },
    "download.tagBadgePositions.subtitle": { label: "字幕固定位置" },
    "download.tagBadgePositions.censored": { label: "有码固定位置" },
    "download.tagBadgePositions.umr": { label: "破解固定位置" },
    "download.tagBadgePositions.leak": { label: "流出固定位置" },
    "download.tagBadgePositions.uncensored": { label: "无码固定位置" },
    "download.tagBadgePositions.fullHd": { label: "1080P固定位置" },
    "download.tagBadgePositions.fourK": { label: "4K固定位置" },
    "download.tagBadgePositions.eightK": { label: "8K固定位置" },
    "download.downloadThumb": { label: "下载横版缩略图" },
    "download.downloadPoster": { label: "下载海报" },
    "download.tagBadges": {
      label: "启用图片水印",
      description: "根据影片信息，为选中的图片添加水印。",
      aliases: ["角标", "标签角标"],
    },
    "download.tagBadgeTypes": {
      label: "角标类型",
      description: "选择允许自动渲染的内建角标类型。未选中的类型即使被识别到，也不会叠加到图片上。",
      aliases: ["中字", "有码", "破解", "流出", "无码"],
    },
    "download.tagBadgePosition": {
      label: "角标位置",
      description: "自动布局的第一个水印位置。",
      aliases: ["角标位置"],
    },
    "download.tagBadgeImageOverrides": {
      label: "覆盖角标图片",
      description: "优先使用自定义目录中匹配的图片；缺少某类图片时使用所选内建样式。",
      aliases: ["覆盖角标", "角标图片", "水印"],
    },
    "download.downloadFanart": { label: "下载背景图" },
    "download.downloadSceneImages": { label: "下载剧照" },
    "download.downloadTrailer": { label: "下载预告片" },
    "download.sceneImageConcurrency": {
      label: "剧照下载并发",
      description: "仅影响剧照下载任务的并发请求数；关闭“下载剧照”时此设置不会生效。",
      aliases: ["剧照并发"],
    },
    "download.generateNfo": { label: "生成 NFO" },
    "download.nfoNaming": { label: "NFO 文件命名" },
    "download.nfoIgnoreFields": {
      label: "NFO 忽略字段",
      description: "选择不写入 NFO 的可选字段；标题、番号、演员等核心字段始终保留。空白表示写入全部可选字段。",
      aliases: [
        "简介",
        "发行信息",
        "时长",
        "技术信息",
        "评分",
        "片商",
        "导演",
        "发行商",
        "系列",
        "类型",
        "标签",
        "海报",
        "缩略图",
        "背景图",
        "剧照",
        "预告片",
        "来源",
        "番号",
      ],
    },
    "download.keepThumb": { label: "保留已有横版缩略图" },
    "download.keepPoster": { label: "保留已有海报" },
    "download.keepFanart": { label: "保留已有背景图" },
    "download.keepSceneImages": { label: "保留已有剧照" },
    "download.keepTrailer": { label: "保留已有预告片" },
    "titleRepair.enabled": {
      label: "标题与简介屏蔽词还原",
      description:
        "自动将官方标题和简介中的避讳符号（●、〇 等）还原为原始词汇（例如把「催●」还原为「催眠」，「●っ払う」还原为「酔っ払う」），翻译前生效；原始标题仍会保留在 NFO 中。",
      aliases: ["标题修复", "遮蔽标题", "简介屏蔽词"],
    },
    "titleRepair.stripTrailingActors": {
      label: "去除标题末尾的演员名",
      description: "部分站点把演员名附在标题末尾（如「…… 三上悠亜」）；开启后按本片演员名单移除。",
      aliases: ["标题演员", "女优名"],
    },
    "naming.assetNamingMode": { label: "附属文件命名", description: "海报、横版缩略图、背景图与预告片的文件名规则。" },
    "naming.nfoTitleTemplate": {
      label: "NFO 标题模板",
      description: "NFO 中 title 字段的格式。可用占位符：{number} {title} {originaltitle}",
    },
    "naming.actorNameMax": { label: "演员名最大数量" },
    "naming.actorNameMore": { label: "演员名超出后缀" },
    "naming.actorFallbackToStudio": {
      label: "演员为空时使用片商或卖家",
      description:
        "开启后，{actor} 在没有演员名时会回退到片商或卖家名称；如需显示来源，可在模板中使用 {actorFallbackPrefix}{actor}。",
    },
    "naming.releaseRule": { label: "发行日期格式" },
    "naming.folderNameMax": { label: "文件夹名最大长度" },
    "naming.fileNameMax": { label: "文件名最大长度" },
    "naming.cnwordStyle": { label: "中文字幕标记" },
    "naming.umrStyle": { label: "UMR 标记" },
    "naming.leakStyle": { label: "流出标记" },
    "naming.uncensoredStyle": { label: "无码标记" },
    "naming.censoredStyle": { label: "有码标记" },
    "naming.partStyle": {
      label: "分盘样式",
      description: "分盘的视频在输出时保留原始后缀，或统一改写为 CD / PART / DISC 风格",
    },
    "aggregation.behavior.maxSceneImages": {
      label: "最多保留剧照数",
      description: "聚合后的剧照数量上限。",
      aliases: ["最多剧照"],
    },
    "aggregation.behavior.maxActors": {
      label: "最多保留演员数",
      description: "聚合后的演员数量上限。",
      aliases: ["最多演员"],
    },
    "aggregation.behavior.maxGenres": {
      label: "最多保留标签数",
      description: "聚合后的类型或标签数量上限。",
      aliases: ["最多标签"],
    },
    "translate.enableTranslation": {
      label: "启用内容翻译",
      description: "DeepL、百度等传统机器翻译质量有限，推荐使用 LLM；也可以保持关闭，之后用其他工具翻译 NFO。",
    },
    "translate.fields": {
      label: "翻译字段",
      description: "只翻译选中的字段，其余保持原文。",
      aliases: ["翻译范围", "只翻译简介"],
    },
    "translate.engine": { label: "翻译引擎", aliases: ["翻译引擎"] },
    "translate.llmModelName": { label: "LLM 模型名称" },
    "translate.llmApiKey": {
      label: "LLM 密钥（可选）",
      description: "默认 OpenAI 地址通常必须填写；本地或兼容服务是否需要密钥取决于服务端配置",
      aliases: ["密钥"],
    },
    "translate.llmBaseUrl": {
      label: "LLM API 地址",
      description: `默认值：${DEFAULT_LLM_BASE_URL}。Google Gemini 示例：https://generativelanguage.googleapis.com/v1beta/openai。本地示例：Ollama 用 http://127.0.0.1:11434/v1`,
      aliases: ["api 地址"],
    },
    "translate.llmApiFormat": { label: "请求形式" },
    "translate.llmServiceType": {
      label: "服务类型",
      description: "自定义代理需要显式选择 Google 或 DeepSeek；不要依赖网址域名识别。",
    },
    "translate.llmSystemPrompt": {
      label: "LLM 前置提示词",
      description: "共用于翻译和兜底番号识别，作为系统提示词发送。可填写角色、背景和通用要求；留空则不发送。",
      aliases: ["提示词", "系统提示词", "前置"],
    },
    "translate.llmPrompt": {
      label: "LLM 翻译提示词",
      description:
        "用于文本、影片元数据及批量 NFO 翻译。{lang} 替换为目标语言，{content} 替换为待翻译内容；输出格式由程序附加。",
      aliases: ["提示词"],
    },
    "translate.llmNumberRecognitionPrompt": {
      label: "LLM 兜底番号识别提示词",
      description: "仅用于 AI 番号识别兜底。程序自动附加文件名、直接父目录名和原识别番号，并约束 JSON 输出和来源证据。",
      aliases: ["提示词", "番号", "兜底"],
    },
    "translate.llmTemperature": { label: "LLM 温度（高级，可选）", description: "留空时使用服务端默认值。" },
    "translate.llmReasoning": { label: "LLM 推理强度", aliases: ["思考", "推理强度"] },
    "translate.llmOutputFormat": {
      label: "输出格式",
      description: "提示词 JSON 省略结构化输出参数；元数据翻译始终要求 JSON 并在本地校验。",
    },
    "translate.llmTimeout": { label: "LLM 请求超时(秒)" },
    "translate.llmMaxRetries": { label: "LLM 最大重试次数" },
    "translate.llmMaxRequestsPerSecond": { label: "LLM 每秒最大请求数" },
    "translate.targetLanguage": { label: "目标语言", aliases: ["语言"] },
    "translate.untranslatedJapaneseRunLength": {
      label: "未翻译判定连续日文字符数",
      description:
        "批量 NFO「仅未翻译」扫描：标题或简介连续达到此数量的平假名、片假名才判定需翻译，默认 5，含半角假名和长音符。汉字、空格和标点会中断计数；有失败记录的字段始终可补译，纯英文或仅需简繁转换不命中。",
      aliases: ["未翻译", "日文", "假名", "阈值", "批量翻译"],
    },
    "personSync.personOverviewSources": { label: "人物简介来源顺序" },
    "personSync.personImageSources": { label: "人物头像来源顺序" },
    "jellyfin.url": { label: "Jellyfin 服务器地址" },
    "jellyfin.apiKey": { label: "Jellyfin API Key" },
    "jellyfin.userId": {
      label: "Jellyfin 用户 ID",
      description: "必须是 UUID。用于人物列表读取，留空则按服务端默认处理。",
    },
    "jellyfin.refreshPersonAfterSync": {
      label: "同步后刷新人物",
      description: "同步简介或头像后，额外请求 Jellyfin 刷新人物元数据与图片。",
    },
    "jellyfin.lockOverviewAfterSync": {
      label: "同步后锁定人物简介",
      description: "写入简介后把 Overview 加入 LockedFields，降低被 Jellyfin 元数据刷新覆盖的概率。",
    },
    "emby.url": { label: "Emby 服务器地址" },
    "emby.apiKey": { label: "Emby API Key" },
    "emby.userId": { label: "Emby 用户 ID", description: "用于人物列表读取，留空则按服务端默认处理。" },
    "emby.refreshPersonAfterSync": {
      label: "同步后刷新人物",
      description: "同步简介或头像后，额外请求 Emby 刷新人物元数据与图片。",
    },
    "emby.autoSyncActorPhotos": {
      label: "自动同步演员头像",
      description: "影片整理入库后自动通知 Emby 扫描，并检查一次本次影片的演员头像。已有头像不覆盖，不自动循环重查。",
    },
    "emby.actorPhotoDailySyncTime": {
      label: "每日头像补查时间",
      description:
        "可选，填写 24 小时制 HH:mm（如 03:00），每天补全一次 Emby 中缺失的演员头像。留空关闭；按 MDCz 服务所在时区执行，需开启自动同步。",
    },
    "emby.notifyAfterPublish": {
      label: "入库后增量刷新目录",
      description: "影片整理入库后，请求 Emby 刷新该影片所在目录。开启自动头像同步时始终发送扫描通知。",
    },
    "jellyfin.notifyAfterPublish": {
      label: "入库后增量刷新目录",
      description: "影片整理入库后，请求 Jellyfin 仅刷新该影片所在目录，无需全局扫描媒体库即可即时显示。",
    },
    "automation.pathMappings": {
      label: "下载器路径映射",
      description: "下载器运行在其他容器或主机时，把它报告的路径换成 MDCz 能访问的路径；按最长前缀匹配。",
      aliases: ["远程路径", "Docker"],
    },
    "automation.qbittorrent.url": {
      label: "qBittorrent WebUI 地址",
      description: "例如 http://qbittorrent:8080。留空则停止轮询。",
      aliases: ["下载器", "种子"],
    },
    "automation.qbittorrent.apiKey": {
      label: "qBittorrent API Key",
      description: "qBittorrent 5.2 及以上可用，优先于用户名和密码。",
    },
    "automation.qbittorrent.username": {
      label: "qBittorrent 用户名",
      description: "用于旧版本。若 qBittorrent 对 MDCz 所在地址免认证，可留空。",
    },
    "automation.qbittorrent.password": { label: "qBittorrent 密码" },
    "automation.qbittorrent.category": {
      label: "分类",
      description:
        "MDCz 仅处理该分类中下载完成的种子。分类的保存路径必须位于某个媒体库的来源目录内；若同时使用了 MoviePilot 等工具，请避免监控同一分类或路径以防止文件冲突。",
    },
    "notifications.webhookUrl": { label: "Webhook 地址", description: "以 JSON 接收每个任务的开始与结束。" },
    "notifications.webhookSecret": { label: "Webhook 密钥", description: "通过 x-mdcz-webhook-secret 请求头发送。" },
    "notifications.channels": {
      label: "通知渠道",
      description: "刮削完成时发送通知消息；开启每日摘要后也通过这些渠道发送。",
    },
    "notifications.telegramBotToken": { label: "Telegram Bot Token" },
    "notifications.telegramChatId": { label: "Telegram Chat ID" },
    "notifications.barkUrl": { label: "Bark 地址", description: "包含设备 Key 的 Bark 推送地址。" },
    "notifications.ntfyUrl": { label: "ntfy 主题地址", description: "例如 https://ntfy.sh/your-topic。" },
    "notifications.ntfyToken": { label: "ntfy 访问令牌", description: "公开主题可留空。" },
    "notifications.dailyDigest": {
      label: "每日摘要",
      description: "每日定时汇总前一天新增入库的影片数与待处理文件数。",
    },
    "notifications.digestHour": { label: "摘要发送时间（0-23 时）", description: "服务端本地时间。" },
  },
  llmReasoningDescription: {
    google: "默认省略推理字段。Gemini 2.5 Pro 和 Gemini 3 系列不能关闭推理；其他模型由服务端校验。",
    deepseek: "默认省略开关和强度；开启可使用服务端默认强度，或选择 low / high / max。思考模式下 temperature 不生效。",
    default: "默认省略推理字段；关闭与指定强度是否可用由模型和服务端校验。",
  },
  search: {
    filterByGroup: (group: string) => `按分组筛选: ${group}`,
    modifiedTokenHint: "仅显示已偏离默认值的设置",
    groupTokenHint: "按分组筛选，例如 @group:数据源",
  },
  quote: (label: string) => `“${label}”`,
};
