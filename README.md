# 弈境 · Gomoku Studio

一个包含前端、后端与 SQLite 数据库的五子棋 Web 应用。支持 AI 对战、同屏双人、落子点评、局面分析、历史对局复盘，以及 JSON / SGF 棋谱导出。

[直接在线对弈](https://yvoml.github.io/yijing-gomoku/) · [公开仓库](https://github.com/Yvoml/yijing-gomoku) · [迭代记录](CHANGELOG.md)

[桌面截图](docs/screenshots/desktop.png) · [手机截图](docs/screenshots/mobile.png) · [验证记录](docs/VALIDATION.md)

界面使用用户提供的红梅雪景原图，搭配随风飘动的梅瓣与雪花、水墨棋盘渐显和冷灰宣纸面板。右上角可暂停风雪；系统开启「减少动态效果」时默认保持静止。

打开上面的在线地址即可对弈，无需安装或启动服务器。GitHub Pages 版使用浏览器本地引擎和 IndexedDB 保存棋谱；清除网站数据或更换浏览器不会自动同步，重要对局请导出。

同时保留 Node.js + SQLite 的完整后端版本，适合本地使用或部署到自己的服务器。两种版本支持相同的五子棋规则、对局模式、复盘和 JSON / SGF 导出。

## 启动

安装 **Node.js 24**，在项目目录运行：

```sh
node server.js
```

打开 <http://localhost:3000>。项目使用 Node.js 内置模块，没有第三方运行依赖，无需安装数据库服务。首次运行自动创建 `data/gomoku.sqlite`。

```sh
node --test
```

## 功能

- 15 × 15 自由五子棋，横、竖、斜连续五子或以上获胜，无禁手。
- 人机对战可选择先后手与难度；同屏双人轮流落子。
- 本地引擎提供合法落子、威胁识别和提示，不配置 API Key 也能使用。
- Agent 结合棋盘状态、本地候选和可选远程 AI 生成行动，并校验落子；远程服务不可用时回退本地引擎。
- 对局自动存入 SQLite，可继续未完成对局、逐步复盘，并查看落子评价。记录按当前浏览器的匿名会话隔离。
- 导出 JSON 棋谱（结构化对局数据）和 SGF 棋谱（文本棋谱）；不含 API Key。
- 可在设置中接入支持 Chat Completions 的 OpenAI 兼容服务。浏览器输入的 Key 只保留在当前页面内存中，刷新后需重新输入。
- 棋盘支持鼠标、触屏与方向键 / Enter；布局适配桌面和手机。

局面评分与落子评价来自启发式算法，适合学习和辅助分析；不是专业棋力等级，也不保证最佳着法。远程 AI 的解释同样可能出错。

## 接入自己的 AI

在应用的「设置」中填写 Base URL、模型名和 API Key。Base URL 是兼容服务的 API 根路径，例如 `https://api.openai.com/v1`，不包含 `/chat/completions`。Key 不写入棋谱或数据库。

在线网页版由浏览器直接连接填写的 HTTPS 接口，需要服务商允许跨域（CORS）请求。密钥只保留在当前页面内存中，不写入 IndexedDB 或 Web Storage；页面刷新后需重新输入。服务不可用时自动回退到本地 AI。Node.js 版本通过本应用后端转发请求。

也可以给后端配置环境变量：

| 变量 | 默认值 / 用途 |
| --- | --- |
| `HOST` | `0.0.0.0`，监听地址 |
| `PORT` | `3000`，监听端口 |
| `DATA_DIR` | `./data`，SQLite 文件目录 |
| `AI_BASE_URL` | `https://api.openai.com/v1` |
| `AI_MODEL` | `gpt-4o-mini`；请替换为服务支持的模型 |
| `AI_API_KEY` | 可选；设置后由服务器提供远程 AI 能力 |
| `ALLOW_SHARED_AI` | 默认关闭；设为 `true` 才允许访客使用服务端配置的共享 AI Key |
| `ALLOW_PRIVATE_AI_ENDPOINTS` | 默认关闭；仅自用可信环境连接本地模型时开启 |

不要把真实 Key 写入源码、棋谱、Git 提交或 GitHub Actions 日志。部署时使用平台的 Secret / 环境变量设置。

本地可以参考 `.env.example` 创建 `.env`，然后运行 `node --env-file-if-exists=.env server.js` 读取文件。直接执行 `node server.js` 使用当前进程的环境变量。

对局归属于浏览器的匿名会话 Cookie，无需注册账号。清除 Cookie 或换浏览器后无法访问原会话的棋局，请及时导出需要保留的棋谱。

## 部署

GitHub 保存源码、提交历史和 CI 结果；GitHub Pages 发布可以直接对弈的浏览器版。需要服务端 SQLite 时，可把 Node.js 版本部署到支持 **Node.js 24 + 持久磁盘** 的平台。

仓库提供 Dockerfile 和 Render Blueprint。Render 配置采用付费 `starter` 服务及 1 GB 持久磁盘，应用 Blueprint 前请在平台查看实际费用。源码推送本身不会创建付费服务。

详见 [部署指南](docs/DEPLOYMENT.md) 和 [架构说明](docs/ARCHITECTURE.md)。推送网页、浏览器引擎或构建脚本变更后，「网页发布」工作流会先执行测试，再部署在线对弈页面。

## 迭代方式

每次完成一项可验证改进后，先运行测试，再独立提交并推送。GitHub Actions 在每次主分支推送和 Pull Request 中执行测试；Render 配置为检查通过后自动部署。提交历史与 `CHANGELOG.md` 记录实际改动，不制造虚假的开发时间或测试结果。
