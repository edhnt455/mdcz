# 外挂字幕更新通知

字幕插件完成写盘后，使用 MDCz 自动化 API Key 提交通知：

```http
POST /api/automation/subtitles/updated
Authorization: Bearer mdcz_xxx
Content-Type: application/json

{
  "eventId": "b157bd22-055f-4b67-872f-22a02f312cff",
  "mediaPath": "/media/259LUXU-1573/259LUXU-1573.mp4",
  "subtitlePath": "/media/259LUXU-1573/259LUXU-1573.chs.srt",
  "language": "zh-CN"
}
```

两个路径使用媒体服务器视角；需要时在设置中配置自动化路径映射。影片必须已登记，字幕必须存在且符合现有同目录字幕匹配规则。STRM 影片传 `.strm` 文件路径。中文语言代码以 `zh` 或 `zh-` 开头，按回调提供的语言标记中文字幕。

返回 `202` 和 `{ "taskId": "subtitle-update-…", "status": "queued" }`。同一个 `eventId` 重试必须携带相同字段，返回原有任务和当前状态；同一 ID 对应不同内容返回 `409`。任务持久化，重启后未完成的任务重新排队。

```http
GET /api/automation/subtitles/jobs/{taskId}
Authorization: Bearer mdcz_xxx
```

状态为 `queued`、`running`、`completed` 或 `failed`。成功结果包含 `metadataUpdated`、`badgeStatus`（`updated`、`unchanged`、`skipped`）和 `mediaServerNotified`；`warnings` 记录跳过及通知失败原因，`error` 记录任务失败原因。通知媒体服务器表示对所有启用的服务器发送成功，未配置时为 `false`。

启用角标时，MDCz 从已记录的图片来源重建图片并应用当前全部角标设置，来源不可用的图片保持原样并产生警告。字幕登记和 NFO 更新不依赖角标开关。任务按媒体写入流程串行执行，完成后按已启用的媒体服务器通知设置请求刷新。
