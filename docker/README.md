# Docker 部署与维护

推荐使用仓库根目录提供的 `compose.yaml` 进行部署。本 fork 通过阿里云容器镜像服务（ACR）个人版发布 Linux amd64（x86_64）镜像；服务内置 SQLite 数据库，无需额外部署 MySQL / PostgreSQL 等数据库容器。

## 镜像发布

镜像由阿里云 ACR 个人版直接从 GitHub 代码源构建并发布，GitHub 不运行检查或镜像发布工作流。本地修改后仍应按改动风险执行验证。

1. 在阿里云 ACR 控制台打开 `skyhook-image/mdcz` 仓库，确认代码源关联 `edhnt455/mdcz`。
2. 在「构建」页面保留以下设置：

   | 设置 | 值 |
   | --- | --- |
   | 代码变更自动构建镜像 | 开启 |
   | 海外机器构建 | 开启；本仓库国内构建实测拉取 Node 基础镜像超时，改用海外构建 |
   | 不使用缓存 | 关闭，复用 Docker 层缓存 |

3. 使用控制台已有的内置规则：

   | 设置 | 值 |
   | --- | --- |
   | Branch/Tag | `tags:release-v$version` |
   | 构建上下文目录 | `/`（仓库根目录） |
   | Dockerfile 文件名 | `Dockerfile` |
   | 镜像版本 | `$version` |

4. 修改根目录 `VERSION`。版本使用不带 `v` 前缀的语义版本号，支持预发布版本（例如 `0.22.10-rc.1`），不接受 `+` 构建元数据。Docker 打包脚本直接读取并校验该文件，应用展示版本由此生成，无需修改 `package.json` 或配置构建参数。常规发布只递增补丁号；只有用户明确提出时才递增次版本号。不要重用或移动已发布版本。
5. 提交并推送代码后，给该提交创建与 `VERSION` 一致的发布标签并推送：

```sh
git tag release-v0.22.10
git push origin release-v0.22.10
```

`release-v0.22.10` 标签匹配内置规则，生成 `registry.cn-hangzhou.aliyuncs.com/skyhook-image/mdcz:0.22.10`。后续发布应同步修改 `VERSION` 和标签版本；只推送 `main` 不会匹配这条标签规则。这条规则不生成 `latest`，部署时使用具体版本。

在阿里云「构建日志」查看构建状态，成功后在「镜像版本」确认标签。个人版单次构建限时 30 分钟；海外构建仍需将镜像传回杭州，存在跨境网络慢或超时的风险，以实际构建日志为准。国内构建实测在拉取 `node:24-bookworm-slim` 时发生 Docker Hub 连接超时，尚未进入项目编译。当前 Dockerfile 使用普通多阶段构建，不依赖 BuildKit 缓存挂载。详见[阿里云个人版构建指南](https://help.aliyun.com/zh/acr/user-guide/create-a-repository-and-build-images)。

原 GitHub 发布流程使用的 `ALIYUN_USERNAME`、`ALIYUN_PASSWORD` Secrets 和 `ALIYUN_REGISTRY`、`ALIYUN_NAMESPACE` Variables 已不被工作流使用，无需继续维护；部署机器 `.env` 中的镜像地址变量仍需保留。ACR 拉取私有代码源所需的 GitHub 授权由阿里云控制台单独管理。

## 首次部署

1. 将仓库根目录的 `compose.yaml` 复制到部署目录，并在同级目录下将 `docker/compose.env.example` 复制命名为 `.env`。
2. 编辑 `.env` 文件：
   - 填写 `ALIYUN_REGISTRY` 和 `ALIYUN_NAMESPACE`，与阿里云镜像仓库地址一致。
   - 前往阿里云 ACR 的对应命名空间下 `mdcz` 仓库查看已发布标签并填入 `MDCZ_VERSION`（例如 `0.22.10`，不带 `v` 前缀）。
   - 填写宿主机上真实的影片目录绝对路径 `MDCZ_MEDIA_PATH`。
   - 配置目录所有者的数字用户与组 ID（`PUID`、`PGID`，可在宿主机终端运行 `id` 命令获取）。
   - 若在 NAS 或局域网服务器部署，建议将 `MDCZ_BIND_IP` 改为 `0.0.0.0` 或 NAS 的局域网 IP。
3. 创建数据存放目录（默认命令 `mkdir -p ./data`）。为防止因路径手误拼错而挂载出空目录，Compose 默认不会自动创建不存在的宿主机挂载目录。
4. 若仓库为私有，在部署机器上先登录 Registry（将示例替换为控制台提供的登录名和域名，按提示输入 Registry 固定密码）；公开仓库可跳过：

```sh
docker login --username='<ACR登录名>' '<ALIYUN_REGISTRY>'
```

5. 启动服务并查看日志：

```sh
docker compose up -d
docker compose logs -f mdcz
```

6. 在浏览器中打开 `http://<服务器IP>:3838`。首次访问时，直接设置管理员密码即可完成初始化。密码无特殊字符或长度限制，系统没有默认 `admin` 密码。
7. 登录后进入系统设置添加媒体库。

已有 Docker Hub 部署切换到阿里云时，先确认所需版本已推送到 ACR，替换 `compose.yaml`，在 `.env` 删除 `DOCKERHUB_USERNAME` 并填写 `ALIYUN_REGISTRY`、`ALIYUN_NAMESPACE`，必要时登录后执行 `docker compose pull && docker compose up -d`。这次切换无需迁移数据；若需恢复旧仓库，恢复原 Compose 和 `.env` 即可，跨应用版本回滚仍须遵守下方数据库回滚要求。

> [!IMPORTANT]
> **媒体库路径填写提示**：在 WebUI 设置中添加媒体库时，**必须填写容器内映射的路径**（例如 `/media` 或 `/media/movies`），切勿填写宿主机的物理路径（如群晖的 `/volume1/...` 或 Unraid 的 `/mnt/user/...`）。

> [!TIP]
> **关于环境变量密码**：如果你希望跳过网页初始化、直接在容器启动时指定管理员密码，可以在 `.env` 中取消注释并配置 `MDCZ_ADMIN_PASSWORD`。该环境变量优先级高于网页设置的密码，且不会写入磁盘文件。

## 持久化与权限

| 容器路径 | 用途 |
| --- | --- |
| `/data/config` | 配置文件目录：存放 TOML 规则档案及管理员密码哈希（`auth-state.json`） |
| `/data/data` | 运行数据目录：存放 SQLite 数据库、任务记录与运行缓存 |
| `/data/logs` | 应用运行日志：每份约 10 MB，最多三份（含当前文件） |
| `/media` | 媒体挂载目录：挂载宿主机上的影片文件夹 |

- **文件日志**：当前文件为 `/data/logs/mdcz.log`，达到 10 MiB（10,485,760 字节）前按完整日志记录轮转，历史文件为 `mdcz1.log`、`mdcz2.log`，更旧的文件自动删除。单条日志超过阈值时独占一份文件。重启会按已有文件大小继续写入；退出前等待队列写完。宿主机对应 `${MDCZ_STATE_PATH:-./data}/logs`，日志目录需允许配置的 `PUID`/`PGID` 写入。网页“清空日志”只清空显示，不删除这些文件；Docker 自身的控制台日志轮转仍独立生效。
- **账号凭据安全**：管理员密码以加盐哈希（scrypt）的形式安全保存在 `auth-state.json`（文件权限为 `0600`）。管理员账号一旦设置便长期有效，即使媒体库中没有任何影片或被清空，也不会重新要求注册。
- **旧版本明文凭据说明**：旧版本明文格式的认证文件不做自动迁移。从旧版升级前，请先停止服务并备份数据，删除旧的 `auth-state.json` 后启动，随后在网页上重新设置管理员密码即可（这不会影响数据库与已有影片）。
- **用户权限（PUID / PGID）**：容器启动时会自动降权为你指定的 `PUID`/`PGID` 用户（默认 1000:1000）运行，确保 MDCz 生成的刮削海报与 NFO 文件在宿主机上能被正常读写。创建文件的掩码默认为 `UMASK=022`；若共享文件夹组内需要写权限，可设置为 `002`。
  - **注意**：容器不会递归修改宿主机上已有媒体文件的所有权。请确保宿主机上的媒体目录对所配置的 `PUID`/`PGID` 用户具备读写权限。若需补充宿主机用户组，可利用 Compose 的 `group_add` 参数。
  - 若你希望完全不使用 root 引导，也可以在 Compose 中直接声明 `user: "1026:100"`，此时环境中的 `PUID`/`PGID` 必须与之保持一致。
- **数据库存储位置限制**：运行中的 SQLite 数据库（`mdcz.sqlite`）**必须存放在宿主机的本地硬盘上**（NAS 本地的存储池属于本地磁盘，可放心使用）。**切勿将数据目录挂载在远程 NFS / SMB 网络共享上**，因为网络文件系统不支持 SQLite 严格的文件锁机制，极易导致数据库损坏。同目录下的 `.lock.sqlite` 是防多实例并发写入锁，正常退出后由系统自动释放，请勿手动删除。
- **文件自动整理建议**：如果你的工作流包含自动整理（将未刮削的影片移动到整理库），强烈建议将“下载目录”与“影片库目录”挂载在同一个 `/media` 目录下（如 `/media/downloads` 和 `/media/movies`）。如果是跨挂载卷移动，系统底层无法实现秒级的原子移动，而会触发耗时的全量文件拷贝；软链接与硬链接也要求路径在同一个容器卷内可解析。

## 健康检查与诊断

- `/health`：仅检查 HTTP 服务进程是否存活。
- `/ready`：检查数据库连接是否可用（镜像默认以此作为健康检查依据），不探测外部刮削网站。
- 注意：Docker 的健康状态仅供监控，不会自动重启容器；容器的自动拉起由 `restart: unless-stopped` 策略在进程异常退出时代为处理。

常用排错命令：

```sh
# 查看容器状态与健康情况
docker compose ps

# 查看实时运行日志
docker compose logs --tail=200 -f mdcz

# 查看持久化到数据目录的应用日志
docker compose exec mdcz tail -n 200 -F /data/logs/mdcz.log

# 运行自检工具（检查数据库路径、SQLite 版本、数据完整性及外键约束）
docker compose exec mdcz docker-entrypoint.sh node server.js doctor
```

`doctor` 命令仅输出系统自检状态，不会暴露密码或任何敏感配置。当容器处于停止状态时，也可通过独立容器运行自检：

```sh
docker compose run --rm --no-deps mdcz node server.js doctor
```

**优雅停机机制**：当执行 `docker compose stop` 时，程序会在 25 秒的缓冲期内依次平滑关闭前端推送长连接、中止正在执行的任务并安全断开数据库连接（Compose 预留了 30 秒停机缓冲）。若发生超时强制退出，下次启动时会自动恢复中断的任务。

## 备份与恢复

### 1. 数据库热备份（服务运行中直接备份）

```sh
docker compose exec mdcz docker-entrypoint.sh node server.js database backup /data/backups/manual.sqlite
docker compose exec mdcz docker-entrypoint.sh node server.js database verify /data/backups/manual.sqlite
```

备份命令基于 SQLite 官方 Backup API，可安全生成一致的快照副本。
> [!WARNING]
> **切勿在运行中直接 `cp` 拷贝数据库**：由于 SQLite 采用 WAL（预写日志）模式，在服务运行期间直接复制 `mdcz.sqlite` 主文件会导致数据不一致甚至损坏，请务必使用官方命令热备份。注意备份目标路径必须是一个尚未存在的新文件。

### 2. 完整整机备份（最推荐）
停止服务后，将宿主机上的整个数据持久化目录（即 `./data` 目录，包含 `config` 与 `data`）打包备份到其他独立的存储介质。仅备份数据库不包含账号凭据（`auth-state.json`）与自定义 TOML 配置。媒体库配置保存在各 TOML 档案的 `[[libraries]]` 中，随档案切换及导入导出；完整恢复库配置需要保留 `config` 目录。

### 3. 恢复数据库（需先停止服务）

```sh
# 1. 停止容器服务
docker compose stop mdcz

# 2. 执行恢复命令（必须带有 --confirm 参数）
docker compose run --rm --no-deps mdcz node server.js database restore /data/backups/manual.sqlite --confirm

# 3. 重新启动服务
docker compose up -d
```

恢复程序会自动校验备份文件的完整性与 MDCz 表结构，并在覆盖前**先将当前旧数据库自动备份为 `*.before-restore-*.sqlite`**。
注意：数据库恢复仅还原刮削历史、元数据与任务状态，**不会撤销或回滚磁盘上已经移动、重命名或生成的影片文件及海报**。

## 升级与版本

1. 停止当前服务：`docker compose stop mdcz`。
2. 备份数据持久化目录。
3. 修改 `.env` 中的 `MDCZ_VERSION` 为新版本号。
4. 拉取新镜像并启动：`docker compose pull && docker compose up -d`。
5. 查看日志与容器状态：`docker compose logs -f mdcz`。

> [!NOTE]
> 服务启动时会自动执行增量数据库迁移。如果升级后需要降级回滚，必须同时恢复升级前匹配的数据库备份，仅切换旧镜像可能因数据库结构向前不兼容而报错。生产部署建议锁定具体的版本号，避免使用 `latest` 引起非预期的破坏性更新。

`0011_libraries_to_config` 迁移会删除旧的数据库库配置表，不自动迁移库配置，升级后需要重新创建库。影片索引、任务记录及监听快照保留；待处理记录保留并解除旧库关联。升级前先停止服务，备份配置和数据库，再执行原有升级命令。没有新增环境变量或启动命令；回滚时同时恢复升级前的程序、配置和数据库。

若日志提示数据库无法升级到当前版本（通常是数据库来自过旧或不兼容的版本），服务会拒绝启动，日志中会给出带数据库路径的重建命令。确认后执行：

```sh
docker compose stop mdcz
docker compose run --rm --no-deps mdcz node server.js database rebuild /data/data/mdcz.sqlite --confirm
docker compose up -d
```

重建会把旧数据库重命名为同目录下的 `mdcz.sqlite.bak-*` 保留，下次启动时创建新数据库。媒体库索引、扫描与刮削历史会清空，可通过重新扫描恢复；账号凭据与 TOML 配置不受影响。

## 反向代理与网络设置

如果需要通过 Nginx 反向代理访问 MDCz，可参考以下配置：

```nginx
location / {
  proxy_pass http://127.0.0.1:3838;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
}

# SSE 实时任务事件流（必须禁用缓冲并保持长连接）
location /events/tasks {
  proxy_pass http://127.0.0.1:3838;
  proxy_http_version 1.1;
  proxy_buffering off;
  proxy_read_timeout 90s;
  proxy_set_header Host $host;
  proxy_set_header Connection "";
}
```

上述配置适用于 Nginx 部署在宿主机上的场景。如果 Nginx 同样运行在 Docker 容器中，请将它们接入同一个 Docker 网络，并将代理目标设置为 `http://mdcz:3838`。

> [!WARNING]
> **外部刮削代理配置注意**：如果在 WebUI 的网络设置中配置刮削代理（HTTP / SOCKS5），**请勿填写 `127.0.0.1` 或 `localhost`**（在容器内部它指向容器自己，无法访问到宿主机上的代理软件）。请填写宿主机的真实局域网 IP（例如 `http://192.168.1.100:7890`）或局域网中代理服务器的实际 IP。

