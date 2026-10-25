# 115 STRM 与 Emby 删除联动实施方案

状态：代码已实现并完成隔离验证，尚未部署或启用真实删除。修订日期：2026-10-25。当前实例只读验证见项目本地 `.codex/mp-preflight-verification.md`；启用步骤见 [Emby 删除联动](./emby-deletion-sync.md#115-strm-复制库扩展)。

推荐：只在 MDCz 开发联动功能，直接调用 MoviePilot 已有存储 API；Emby / 神医助手直接向 MDCz 发送深度删除通知。取消自写 MP 桥接插件的计划。115 登录和凭据继续由 MP 管理。

## 1. 目标与目录

| 用途 | 配置 |
| --- | --- |
| 115 源目录 | /Media/AV，以上线前核对的真实目录为准 |
| MP 本地生成目录 | /volume4/Media/AV/Normal |
| MDCz 来源目录 | /volume4/Media/AV/Normal |
| MDCz 输出目录 | /volume4/Media/AV/Link，整理方式 copy |
| Emby 媒体库 | 只包含 /volume4/Media/AV/Link |

Normal 保留原始 STRM，Link 保存整理后的副本。MDCz 只监控 Normal，避免把 Link 再次当作来源。Emby 与 MDCz 首版要求看到相同的 Link 绝对路径；Docker 内实际挂载也要核对。

成功标准：用户在 Emby 主动删除一个独立资源后，Link STRM、Normal 对应 STRM、115 对应源视频及 MDCz 对应影片记录全部清理；重复通知或重启不扩大删除范围。

## 2. 搜索结果与选型依据

| 方案 | 已查到的能力 | 对本场景的结论 |
| --- | --- | --- |
| MDCz 调用 MP 原生存储 API | 列出目录和文件，返回 pickcode / fileid，按文件项删除 | 推荐；关联、队列和确认都在 MDCz，不需要新增 MP 插件 |
| SaMediaSyncDel / 115 助手内置同步删除 | 接收 deep.delete，按路径映射和转移记录删除 | 当前电影链路可继续用；不能直接解决 MDCz 改名后的来源匹配 |
| CloudDiskDel「云盘文件删除」 | 处理插件动作，映射到本地可访问的云盘路径后 unlink / rmtree | 核对的版本依赖云盘挂载路径，不是 HTTP STRM 的 pickcode 删除接口 |
| CloudSyncDel「云盘同步删除」V3 | 路径映射、挂载文件清理、媒体身份校验及回调 | 仍依赖映射后的文件系统路径，不能直接套用当前 HTTP STRM 链路 |
| P115StrgmSub 配套删除 daemon | 文档描述 inotify 监听 STRM 删除后调用 CD2 API | 还需额外守护进程和 CD2；未在所查仓库树找到同名配套脚本，未验证其实现，不作为可直接部署方案 |

这些是已检查仓库的结论，不代表整个插件生态不存在其他实现。当前用户日志显示 MP 已能通过 u115 删除电影，说明有可复用的云端执行基础；是否能通过当前实例 HTTP API 完成查询、删除与确认，需要实施前验证。

## 3. 已确认的原生接口

以下路径按 MP 默认 API 前缀 /api/v1 表示，若用户修改前缀需同步配置。

| 接口 | 用途 |
| --- | --- |
| GET /api/v1/storage/options | 查询已配置存储选项 |
| POST /api/v1/storage/list | 列出指定目录，部分后端也支持刷新指定文件详情 |
| POST /api/v1/storage/delete | 删除请求中的 FileItem |

已核对 MP V3 源码：
- list / delete 使用拥有管理权限的身份。
- FileItem 包含 storage、type、path、fileid、parent_fileid、pickcode、size 等字段。
- 原生 u115 的目录列表填充 fileid、parent_fileid 和 pickcode；删除向 115 提交 fileid，返回明确的业务成功结果。
- 当前 V3 认证支持 X-API-KEY 请求头中的 API_TOKEN，也支持 Bearer 用户令牌。部署时以当前实例 OpenAPI 和只读调用为准。
- 原生 API 没有本方案之前拟议的 resolve、operations 接口，也不接受自定义幂等操作 ID；这些工作改由 MDCz 自己持久记录。

MDCz 设置 MP 地址、认证凭据、所选存储（优先验证日志中的 u115）、云端允许根目录和 Normal 来源根。原生固定 API_TOKEN 具有较高权限，不能称为仅限删除的专用密钥；凭据保存在 MDCz 现有服务端凭据存储，经请求头传递，不回显、不写入日志。

不需要把 115 Cookie / Open Token 复制到 MDCz，也不依赖从 pickcode 自行解码出 fileid。

## 4. 用现有 list 接口完成资源定位

正常整理时保存 Link 文件 ID、文件版本、Normal 来源根与相对路径、STRM 内容哈希及 pickcode。现有 retainedSourceIdentity 和 STRM 内容解析可以复用。

查询资源采用：
1. 从允许的 MP 播放地址读取唯一 pickcode，只接受配置的 origin 和 P115StrmHelper redirect_url 路径。
2. 从已配置的 115 根目录，通过 MP list 获取文件项。Normal 的相对目录可作为优先查询候选，但不能按改名后的 Link 路径推算云端路径。
3. 将返回项的 pickcode 与 STRM 内容精确比对，找到唯一的 file 类型后保存完整 FileItem。
4. 保存 fileid、parent_fileid、实际返回的路径、大小、存储及 MP 连接身份。fileid 始终用字符串保存，避免 JavaScript 数字精度损失。
5. 后续优先查询已绑定父目录；首次回填可以对允许根内做一次有界目录遍历，建立 pickcode 索引，不能每删一部都全盘扫描。
6. 获取完整分页并限速；返回项缺关键字段、候选重复、超出扫描上限或 MP 请求失败，均保持“未验证”。

文件名只用于定位候选，不作为最终删除依据。列表中的路径由后端根据输入目录拼接，不应只凭缓存 FileItem 的 path 字符串判断当前边界；删除前需从绑定根核对目标所在目录及父子关系，避免父目录被移动后仍按旧路径放行。

连接或存储账号更换后重新验证关联。若 API 不提供稳定账号 ID，不能虚构该字段：使用连接、存储、绑定根目录 ID 和返回资源身份核对，并把账号切换列为需要重新绑定的配置操作。

## 5. Emby 直接通知 MDCz

神医助手官方文档已说明：
- 媒体深度删除通知只在用户主动删除时发送。
- 扫描发现文件消失或改名不会产生此通知。
- 本地 STRM 删除失败时不发送。
- 支持 Webhook 接收方，事件为 deep.delete。
- Description 中的 Mount Paths 包含目标路径或 HTTP 链接列表。

因此在 Emby 通知设置增加发往 MDCz 的“媒体深度删除”Webhook，POST application/json；不经新 MP 插件转发。现有发往 MP 的普通电影通知可继续保留，AV 由 MDCz 独立处理。

MDCz 扩展现有 Emby Webhook 接收器与 schema 支持 deep.delete 及必要字段。首先抓取一份实际版本的脱敏事件作为协议样本，确认 Server.Id、事件时间、Item.Path、Description 等字段。神医通知按执行删除的用户发送，实际操作用户要有相应通知配置。

数据库预先保存的来源关联是主依据；Mount Paths 中的 pickcode 可以交叉核对，不能把通知里任意 URL 当作删除授权。目录级或多版本通知必须能逐个匹配已登记文件，否则待检查，不推断整个目录可删。

普通 library.deleted 保留原有仅清理记录的用途；对启用 115 联动的库，不得由普通通知抢先清理来源关联。缺失核对不能凭空制造 deep.delete 授权。

## 6. 删除顺序、确认与重试

1. Emby 主动删除，Link STRM 消失，MDCz 收到 deep.delete。
2. 验证专用 Webhook 密钥、Server ID、事件时间、输出路径和已登记文件版本，持久入队。
3. 核对 Link 和 Normal 挂载身份，沿用缺失确认和路径锁。将目标资源标为删除中，阻止监控、扫描、刮削和发布重新导入。
4. 查询 MP，重新核对已绑定云端文件的 fileid、pickcode、类型及范围。其他已登记 Link 仍引用相同资源时，保留云端及其来源，只清理本次消失的 Link 记录。
5. 对最后一个引用，调用 storage/delete，提交已核验的单个 file 类型 FileItem；不调用递归媒体目录清理。
6. 持久保存业务响应，再用 MP 重新查询父目录核验目标消失。确认后进入 Normal 清理。
7. 校验 Normal 根、路径和当前 STRM 身份，删除对应原始 STRM；已不存在算完成，已替换为其他资源则保留并待检查。
8. 检查助手在途生成是否重新写回同资源 STRM。有限次处理并保留资源抑制状态；持续重建时报告待检查。
9. 最后清理 MDCz 对应文件及关联记录。最后一个影片文件消失才移除影片和无其他引用的关联数据，刷新界面。

MDCz 复用现有持久队列，增加步骤：validating → deleting_cloud → verifying_cloud → cleaning_source → cleaning_records → completed。队列保存独立于影片行的资源快照、最后确认和操作结果，重启按步骤继续。

### 原生 API 的结果边界

MP 的存储 list 端点会把底层 None 归一为空列表，某些存储实现会将查询失败转换为 None。因此“HTTP 200 + []”不能单独证明文件已删除。

- 删除返回明确 success=true 后，仍校验接口与已知父目录的查询是否正常，并完成完整列表确认。
- 删除响应丢失时，先恢复查询，不能按同名路径选择新 fileid 再删。
- 缓存列表、未知存储、鉴权失败、分页不完整或无法区分不存在与查询失败，均进入重试 / 待检查，不提前清理 Normal 和关联。
- 即便返回空列表，目标也可能被移动到别处。没有明确删除成功结果时，不能仅凭“旧父目录中消失”认定云端已删除。
- 如当前安装版本无法给出足够的结果证据，就明确保留“云端状态未确认”；不为了完全自动化自动扩大权限或安装自写插件。

首次适配优先针对验证过的原生 u115 行为，而非一次支持所有云盘后端。按保存的同一 fileid 重试提供目标幂等性，MDCz 不承诺原生 API 提供“恰好执行一次”。

## 7. MDCz 修改范围

| 模块 | 改动 |
| --- | --- |
| packages/shared | MP 连接设置、来源关联、深度删除事件、分阶段状态 |
| packages/runtime/src/publication 与 STRM 工具 | 保存 Link / Normal / pickcode，复用已有来源身份 |
| packages/persistence | 新增来源关联及删除队列步骤、资源快照和查询索引 |
| apps/server/src/services | MP 原生 API 客户端；扩展 Emby 删除服务支持显式启用的 copy STRM 库 |
| 监控、扫描、刮削、发布 | 共用资源删除状态，防止处理中重新导入 |
| Emby 删除设置面板与服务 API | MP 连接测试、存储/目录选择、关联核验、观察模式、步骤结果、重试 |

不新增 MP 插件目录，不复制 MP 内部 Python 实现。数据库采用下一条新迁移，不改已发布迁移。保留现有账号、全局设置、任务历史和下载器去重；未完成任务与必要的资源抑制信息不能随影片记录级联丢失。

关闭联动停止后续副作用并保留进度；已经删除云端、尚未完成本地清理的任务必须显示实际状态。首版不额外删除云端目录、下载任务或 Link 残留海报等文件。

## 8. 迁移与验收

实施前做只读预检：
1. 读取当前 MP 版本及 OpenAPI，验证管理认证、storage/options 和 storage/list。
2. 选择一个现有 STRM，确认其 pickcode 能在 /Media/AV 范围内唯一匹配到 fileid、父目录和实际文件。
3. 验证原生 u115 查询错误与空目录的响应行为、分页及缓存特征。
4. 获取实际 deep.delete 样本并验证通知用户、字段和文件路径。

然后实施 MDCz 改动和隔离测试。生产启用按顺序：
1. 备份数据库及配置；暂停 AV 生成和整理。
2. 将本地生成目录从旧 /AV 改为 /AV/Normal，MDCz 来源改为 Normal，输出 Link 使用 copy。旧平铺文件仅迁移确认属于来源的部分，不递归搬动 Normal / Link。
3. 恢复生成并回填现有 Link 的来源关联；唯一匹配且云端验证成功的才标记为可联动。缺失、冲突或已删除的旧文件不按番号追溯删除。
4. 在观察模式显示将处理的 Link、Normal 和云端文件。AV 范围从其他同步删除执行方排除，普通电影原有配置保留。
5. 获得真实数据操作授权后，用专用测试资源验证一条端到端删除，再启用已核验的 AV 关联。

重点验收：四处清理、普通扫描移除不删云端、重复事件、网络错误、响应丢失、各阶段重启、同名新文件、共享资源、挂载失效、Normal 被替换、生成任务延迟写回。

复用并扩展现有测试，仅为新增行为增加必要用例。使用 pnpm 进行项目检查和隔离接口验证。回滚时关闭联动、保留未完成任务报告，再恢复配套程序与数据库；不要通过改回 move 回滚，也不要把程序回滚描述为能恢复云端视频。

## 9. 依据与版本限制

- [MP 存储列表和删除 API](https://github.com/jxxghp/MoviePilot/blob/v3/app/api/endpoints/storage.py)
- [MP 原生 u115：列表返回资源身份、按 fileid 删除](https://github.com/jxxghp/MoviePilot/blob/v3/app/modules/filemanager/storages/u115.py)
- [MP FileItem 字段](https://github.com/jxxghp/MoviePilot/blob/v3/app/schemas/file.py)
- [MP 认证入口](https://github.com/jxxghp/MoviePilot/blob/v3/app/adapters/web/security/access.py)
- [神医通知系统增强与 deep.delete 约定](https://github.com/sjtuross/StrmAssistant/wiki/通知系统增强-(Notification))
- [CloudDiskDel 所核对版本](https://github.com/DDSRem-Dev/MoviePilot-Plugins-Official/blob/main/plugins/clouddiskdel/__init__.py)
- [CloudSyncDel V3](https://github.com/thsrite/MoviePilot-Plugins/blob/main/plugins.v3/cloudsyncdel/__init__.py)
- [P115StrgmSub 配套 daemon 的文档描述](https://github.com/jinyuhao-886/MoviePilot-Plugins/blob/main/README_P115StrgmSub.md)
- [现有 MDCz Emby 删除功能](./emby-deletion-sync.md)

已对用户 MP 实例完成只读验证：前后端和 OpenAPI 应用版本为 v3.1.9，X-API-KEY 认证正常，u115 的 /Media/AV 返回 281 个文件，样例 pickcode 唯一匹配，完整列表与分页集合一致。OpenAPI schema 已与真实响应核对；单文件详情允许 parent_fileid 为空，目录列表能提供完整父子身份。尚未验证真实删除。用户提供的 Emby 日志只有发送和响应记录，没有 deep.delete JSON 请求体；真实协议样本仍须在观察模式核对，不能把上游说明或隔离测试当成实机协议验收。
