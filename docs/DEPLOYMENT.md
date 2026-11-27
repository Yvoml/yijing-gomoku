# 部署指南

## 两种运行方式

| 部分 | 托管位置 | 内容 |
| --- | --- | --- |
| 源码和迭代记录 | GitHub 公开仓库 | 前后端、测试、提交历史、CI |
| 直接在线对弈 | GitHub Pages | 浏览器本地引擎、IndexedDB 保存、复盘与导出 |
| 带服务端数据库的应用 | 本地 Node.js、Render 或自建 Docker 服务器 | Node.js 后端、同源前端、持久 SQLite |

直接打开 [五子棋网页版](https://yvoml.github.io/yijing-gomoku/) 即可对弈，无需安装、启动本地服务或购买云端后端。网页版使用与服务端相同的规则和棋力引擎，支持先后手、难度、双人对局、提示、分析、悔棋、历史复盘，以及 JSON／SGF 下载。

GitHub Pages 托管静态文件，不能运行 Node.js 和 SQLite；因此在线版把运行和存储放在当前浏览器中。原有 Node.js + SQLite 版本仍然保留。[GitHub Pages 官方说明](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)

## GitHub Pages：可直接对弈的网页版

1. 打开仓库 **Settings → Pages → Build and deployment**，选择 **GitHub Actions**。
2. 在 **Actions** 中运行 **网页发布**。相关源码推送至主分支时也会自动运行。
3. 工作流先执行测试，再运行 `node scripts/build-pages.mjs`，生成 `_site/` 并发布到 Pages。
4. 等待部署成功，打开网站，落子、刷新恢复对局，再检查复盘和导出。

构建复制前端、浏览器运行层和共享棋力引擎；不会发布服务端文件、数据库、`.env` 或其他密钥文件。资源使用相对路径，适配 `/yijing-gomoku/` 项目路径；生成的脚本和依赖引用附带内容版本，减少更新后的旧缓存问题。不要直接双击 HTML，请通过 Pages 或 HTTP 静态服务器访问。

构建脚本可重复运行，默认输出到 `_site/`。自定义输出目录必须位于项目内，且不能覆盖源码；已有目录只有带有本脚本标记时才会被替换。

工作流需要 `contents: read`、`pages: write` 和 `id-token: write`。如果组织策略禁止 Pages 或 Actions，需由仓库管理员调整。[自定义 Pages 工作流](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)

## 网页版存储与 AI 接入

棋谱保存在当前浏览器的 IndexedDB。刷新页面后可继续对局；换设备、换浏览器或清除该网站数据不会同步旧棋谱，请先导出需要保留的记录。浏览器禁止持久存储时，界面会明确显示临时存储，关闭页面后记录可能丢失；存储空间不足时会显示保存错误。

未配置模型时，本地引擎可以完成对战、提示与分析。设置中的 API Key 仅保留在当前页面内存，刷新后清除。在线版直接把 AI 请求发给你填写的 HTTPS 服务商，服务商必须允许网页的跨域请求（CORS）。不支持跨域、超时或返回无效落子时，会显示原因并使用本地引擎。在线版不会使用服务器共享 Key，也不经过第三方公共代理。

## Render：完整应用

1. 将本项目推送到 GitHub 公开仓库。
2. 登录 Render，选择 **New → Blueprint**，连接此仓库，使用根目录的 `render.yaml`。
3. 检查服务和费用，再应用 Blueprint。配置使用 Docker、`starter` 方案、新加坡区域、1 GB 持久磁盘；需要你自己的 Render 账号。Render 的持久磁盘仅支持付费服务，具体价格以创建页面为准。[官方持久磁盘文档](https://render.com/docs/disks)
4. 不使用远程 AI 时无需设置 Key。用户可以在应用设置里临时输入自己的 Key。需要共享服务器 AI 时，在服务的 **Environment** 中添加 `AI_API_KEY` 和 `ALLOW_SHARED_AI=true`，并按服务商调整 `AI_BASE_URL` 与 `AI_MODEL`；默认不开放服务器 Key。
5. 等待部署成功，打开 Render 提供的 HTTPS 地址。访问 `/api/health` 应返回成功状态；创建一局、落子、导出棋谱，再刷新确认记录仍然存在。
6. 运行一次重新部署后，再确认原有棋局仍可读取。只有 `/var/data` 内的数据会保留，`DATA_DIR` 必须保持 `/var/data`。

Blueprint 的 `healthCheckPath` 为 `/api/health`，`autoDeployTrigger: checksPass` 表示关联分支检查通过后自动发布。可在 Render 控制台检查关联的默认分支及自动部署状态。[Blueprint 参考](https://render.com/docs/blueprint-spec)

SQLite 采用单个服务实例与单块持久磁盘，不要直接扩展到多实例。迁移数据库前先备份；不要用临时目录存放需要长期保留的对局。

## Docker：本地或自己的服务器

安装 Docker 后在仓库根目录执行：

```sh
docker build -t yijing-gomoku .
docker volume create gomoku-data
docker run -d --name gomoku -p 3000:3000 --mount source=gomoku-data,target=/var/data yijing-gomoku
```

打开 `http://localhost:3000`。命名卷保存数据库；替换容器时继续挂载同一个卷。公网部署应通过反向代理配置 HTTPS。

升级：拉取新源码并重新构建镜像，停止并替换旧容器，保留 `gomoku-data` 卷。不要执行删除卷的命令。

## 服务端数据与密钥

数据库文件位于 `$DATA_DIR/gomoku.sqlite`。数据库与实际 Key 不应提交到 Git。备份 SQLite 时，应停止应用再复制数据库目录，或使用 SQLite 一致性备份工具；运行中仅复制主文件可能遗漏 WAL 中的数据。

Node.js 版本中，浏览器手动输入的 Key 只在当前页面内存中保存，但会在使用 AI 功能时发送给本应用后端，再传给所选 AI 服务。请只向可信部署输入自己的 Key，并使用 HTTPS。服务端 `AI_API_KEY` 仅在 `ALLOW_SHARED_AI=true` 时向访客开放共享调用；共享 Key 固定使用服务端配置的接口和模型，访客不能重定向它。启用前应考虑供应商额度与费用。

棋局按匿名浏览器会话隔离，使用 `HttpOnly`、`SameSite=Lax` Cookie 标识访问权限；数据库保存会话标识的散列。没有注册和密码找回功能，清除 Cookie、使用无痕窗口或更换浏览器会失去对原棋局的访问，请先导出棋谱。

外部 AI 默认只允许公开网络的 HTTPS 地址；自建本地模型需要显式开启 `ALLOW_PRIVATE_AI_ENDPOINTS`。仅在自己控制的私有环境中使用该选项。

## 验收与故障排查

- **网页空白或资源 404**：确认访问 Pages 发布地址，检查 **网页发布** 是否成功；不要直接双击 `public/index.html`。
- **网页版记录不可见**：确认使用同一浏览器和网站地址；清除站点数据或无痕会话结束会删除浏览器记录。
- **服务端记录在部署后丢失**：检查持久磁盘是否已挂载，以及 `DATA_DIR` 是否指向该挂载目录。
- **远程 AI 回退本地引擎**：检查兼容接口 Base URL、模型名、Key 权限、服务余额及网络；Pages 在线版还需要服务商支持 CORS，本地对战仍可继续。
- **CI 失败**：查看 `CI → 验证引擎、接口与网页版`，在 Node.js 24 环境运行 `node --test` 重现。
- **Pages 工作流失败**：先在 Settings 启用 GitHub Actions 发布源，并确认仓库 Pages 权限与组织策略允许部署。

以上配置是可重复部署的交付文件；只有平台显示部署成功并通过真实访问验证后，才应将服务标记为已上线。
