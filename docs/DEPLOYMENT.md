# 部署指南

## 三个部分

| 部分 | 托管位置 | 内容 |
| --- | --- | --- |
| 源码和迭代记录 | GitHub 公开仓库 | 前后端、测试、提交历史、CI |
| 项目介绍页 | GitHub Pages | 功能介绍、源码与完整应用入口 |
| 完整 Web 应用 | Render 或自建 Docker 服务器 | Node.js 后端、同源前端、持久 SQLite |

GitHub Pages 托管静态文件，不能运行本项目的 Node.js 服务和 SQLite 数据库。本仓库因此单独生成项目介绍页；完整对局界面由后端服务提供。[GitHub Pages 官方说明](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)

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

## GitHub Pages：项目介绍页

1. 打开仓库 **Settings → Pages → Build and deployment**，选择 **GitHub Actions**。
2. 在 **Actions** 中运行 **Project page**。工作流生成独立静态介绍页，不会发布需要后端的 `public/` 目录。
3. 完整应用上线后，在 **Settings → Secrets and variables → Actions → Variables** 添加仓库变量 `LIVE_APP_URL`，值为完整应用的 HTTPS 地址。
4. 再次手动运行 **Project page**，介绍页会更新「开始对弈」链接。变量为空时页面明确显示在线服务待配置。

工作流需要 `contents: read`、`pages: write` 和 `id-token: write`。如果组织策略禁止 Pages 或 Actions，需由仓库管理员调整。不要把 AI Key 填进 `LIVE_APP_URL`。[自定义 Pages 工作流](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)

## 数据与密钥

数据库文件位于 `$DATA_DIR/gomoku.sqlite`。数据库与实际 Key 不应提交到 Git。备份 SQLite 时，应停止应用再复制数据库目录，或使用 SQLite 一致性备份工具；运行中仅复制主文件可能遗漏 WAL 中的数据。

浏览器手动输入的 Key 只在当前页面内存中保存，但会在使用 AI 功能时发送给本应用后端，再传给所选 AI 服务。请只向可信部署输入自己的 Key，并使用 HTTPS。服务端 `AI_API_KEY` 仅在 `ALLOW_SHARED_AI=true` 时向访客开放共享调用；启用前应考虑供应商额度与费用。

棋局按匿名浏览器会话隔离，使用 `HttpOnly`、`SameSite=Lax` Cookie 标识访问权限；数据库保存会话标识的散列。没有注册和密码找回功能，清除 Cookie、使用无痕窗口或更换浏览器会失去对原棋局的访问，请先导出棋谱。

外部 AI 默认只允许公开网络的 HTTPS 地址；自建本地模型需要显式开启 `ALLOW_PRIVATE_AI_ENDPOINTS`。仅在自己控制的私有环境中使用该选项。

## 验收与故障排查

- **空页面或接口 404**：确认访问的是完整服务地址，而不是 GitHub Pages 项目介绍页；不要直接双击 `public/index.html`。
- **记录在部署后丢失**：检查持久磁盘是否已挂载，以及 `DATA_DIR` 是否指向该挂载目录。
- **远程 AI 回退本地引擎**：检查兼容接口 Base URL、模型名、Key 权限、服务余额及网络连接；本地对战仍可继续。
- **CI 失败**：查看 `CI → Run engine and API tests`，在 Node.js 24 环境运行 `node --test` 重现。
- **Pages 工作流失败**：先在 Settings 启用 GitHub Actions 发布源，并确认仓库 Pages 权限与组织策略允许部署。

以上配置是可重复部署的交付文件；只有平台显示部署成功并通过真实访问验证后，才应将服务标记为已上线。
