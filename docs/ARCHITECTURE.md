# 架构与接口

```mermaid
flowchart LR
    Browser[浏览器界面] -->|同源 HTTP API| Server[Node.js 24 服务]
    Server --> DB[(SQLite 对局数据库)]
    Server --> Engine[本地五子棋引擎]
    Server --> Agent[对战与分析 Agent]
    Agent --> Engine
    Agent -. 可选 .-> Provider[OpenAI 兼容 AI 接口]
    Server --> Export[JSON / SGF 棋谱]
```

前端采用原生 HTML、CSS 和 JavaScript；服务端采用 Node.js HTTP 模块，使用内置 `node:sqlite` 持久保存对局。前后端由同一进程同源提供，无需跨域配置或独立前端构建。

## 数据与规则

棋盘是 `board[y][x]` 的 15 × 15 数组：`0` 为空位，`1` 为黑，`2` 为白。坐标从零开始，合法范围为 `0..14`。黑先白后，横、竖、两条斜线任一方向连续至少五子获胜；采用自由规则，不含三三、四四、长连禁手。

对局对象包含 ID、模式、难度、人类执子、当前行棋方、状态、胜者、创建时间、更新时间和有序落子列表。落子记录包含坐标、颜色、手数和分析信息。数据库是服务端状态来源，刷新页面不会丢失已经保存的落子。

每个浏览器通过随机匿名会话 Cookie 拥有自己的对局。Cookie 设置 `HttpOnly` 和 `SameSite=Lax`，数据库保存令牌的 SHA-256 散列；读取或修改其他会话的对局返回 404。清除 Cookie 后没有账号恢复途径，数据库中的棋局仍存在，但原会话访问权限丢失。

本地引擎优先处理立即取胜和阻止对手取胜，再对有限候选进行棋形与局势评估。评分为启发式相对指标，不表示统计胜率。难度影响候选或搜索策略；引擎不承诺专业竞赛棋力。

## Agent 与自接入 AI

Agent 围绕实际棋盘执行「读取状态 → 分析威胁与候选 → 可选调用远程模型 → 校验行动 → 落子或给出建议」。工具执行信息供界面展示，帮助解释选择来源。

远程模型通过 OpenAI 兼容 Chat Completions 接口接入。应用不信任模型生成的坐标，落子前仍由后端校验棋盘边界、空位、回合与终局状态。超时、不可解析结果、非法落子或服务失败时回退本地引擎。

默认需要用户在当前页面输入自己的临时 Key；只有明确设置 `ALLOW_SHARED_AI=true` 时才使用服务器的共享 `AI_API_KEY`。服务端配置状态接口不返回密钥。默认阻止私有网络 AI 地址；只有自用环境显式启用 `ALLOW_PRIVATE_AI_ENDPOINTS` 才允许连接本地模型。

本地点评记录最佳候选和当前落子的评分差，并给出优秀、良好、不够精确或失误等解释；该分类依赖启发式引擎。语言模型用于补充解释，也可能产生错误，不能替代规则校验。

## HTTP API

请求和正常响应使用 JSON。导出接口返回下载文件。接口路径中的 `:id` 是对局 ID。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/health` | 服务健康检查 |
| GET | `/api/config` | 棋盘规则和 AI 配置状态，不返回 Key |
| GET | `/api/games` | 历史对局列表 |
| POST | `/api/games` | 创建对局，参数 `mode`、`difficulty`、`humanColor` |
| GET | `/api/games/:id` | 读取对局 |
| POST | `/api/games/:id/moves` | 提交人类落子 `{x,y}` |
| POST | `/api/games/:id/agent` | 请求 Agent 落子 |
| POST | `/api/games/:id/undo` | 悔棋 |
| POST | `/api/games/:id/hint` | 获取建议和局面分析 |
| POST | `/api/games/:id/analyze` | 分析当前局面或指定 `moveNumber` 的局面 |
| GET | `/api/games/:id/export?format=json` | 下载 JSON 棋谱 |
| GET | `/api/games/:id/export?format=sgf` | 下载 SGF 棋谱 |

`mode` 为 `ai` 或 `local`；`difficulty` 为 `easy`、`standard`、`hard`；`humanColor` 为 `1` 或 `2`。AI 相关 POST 可携带临时 `ai: {baseUrl,apiKey,model}` 配置。Key 不写入棋谱和数据库。

人类落子和 Agent 落子是两个明确的请求：前端先保存人类落子，再请求 AI 回复。这样刷新或断网后仍可恢复已完成的落子，并且界面可以显示 Agent 思考状态。

## 交付和扩展

GitHub Actions 负责语法检查与测试，GitHub Pages 发布介绍页，Docker / Render 运行完整服务。持久 SQLite 适合单实例部署；在线远程双人匹配、可恢复的注册账号、团队权限和多实例扩展需要后续加入对应服务与数据库迁移，不应仅通过增加容器副本实现。
