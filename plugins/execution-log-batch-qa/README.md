# A3 执行记录 · 批量下载问答

在 [Agent 中心 → 执行记录](https://a3-lib.a3database.cn/ai/agent-center/execution-log) 勾选多行，一键把每条「下载问答」的 `.txt` 打成一个 ZIP。

> 浏览器插件（userscript / Chrome MV3），**不改** A3 产品仓库。鉴权复用当前登录态与 AUTO Token，仓库内无任何密钥。

**v1.0.4：** 修复 ISOLATED 扩展读不到页面鉴权 → `/me/auto` 401。增加 **MAIN-world `page-bridge.js`**：读取 `localStorage.token`、旁路捕获 Agent `Authorization`、页面上下文换取 AUTO Token；失败时提示先点一次「下载问答」。

**v1.0.3：** ZIP 内文件名改为列表列 **用户_最近一轮.txt**（只读表头/单元格，不改表格 DOM）。

**v1.0.2 安全模式：** UI 仍在 ISOLATED；不改 Ant Table DOM；不用 MutationObserver / history 劫持。右下角浮动面板 + 轮询读取 `tr[data-row-key]`。MAIN 桥接仅做鉴权观察（轻量 fetch observe，不改响应）。

若页面只剩骨架屏：先在 `chrome://extensions` **禁用/移除本扩展** 并硬刷新即可恢复。

## 行为

| 能力 | 说明 |
|------|------|
| 勾选 / 全选本页 | 右下角面板列出本页 `data-row-key`（只读页面表格，不改 DOM 结构） |
| 「批量下载问答」 | 对勾选会话逐个拉取与单行「下载问答」相同的 payload |
| 打包 | `execution-qa-YYYYMMDD-HHmmss.zip` |
| 条目命名 | `{用户}_{最近一轮}.txt`（从列表列读取；非法字符清洗；重名追加短 session 后缀） |

「下载全部」（`variant=detail`）不在本插件范围内。

## 接口（从线上 JS 还原）

生产环境（`a3-lib.a3database.cn`）：

```http
GET https://api.a3database.cn/api/v1/sys/user-tokens/me/auto
  Cookie: <页面登录态>

GET https://agent.a3database.cn/scope/admin/conversations/{sessionId}/download?variant=brief
  Authorization: Bearer <AUTO token>
```

Host 映射与页面一致：

| 前端 host | API | Agent |
|-----------|-----|-------|
| `a3-lib.a3database.cn` | `https://api.a3database.cn` | `https://agent.a3database.cn/scope` |
| `a3-pre-lib.a3database.cn` | `https://pre-api.a3database.cn` | `https://agent.a3database.cn/scope` |
| `a3-test-lib.a3database.cn` | `https://test-api.a3database.cn` | `https://agent-test.a3database.cn/scope` |

鉴权优先级：页面真实 Agent `Authorization`（点过「下载问答」或列表请求）→ MAIN 桥接读取的 `localStorage.token` 换 `/me/auto` → 登录 token 直打 Agent（兜底）。仓库不保存、不提交任何 token。

Chrome：**ISOLATED** `content.js`（UI）+ **MAIN** `page-bridge.js`（鉴权桥）。

## 安装

站内「下载与配置 / 技能下载」页面向的是 Agent Skill 包，与本浏览器插件不是同一通道。请用下列方式之一安装。

### 方式 A：Tampermonkey / Violentmonkey（推荐）

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 或 Violentmonkey。
2. 打开本仓库文件：[`userscript/a3-execution-log-batch-qa.user.js`](./userscript/a3-execution-log-batch-qa.user.js)  
   - GitHub：点 **Raw**，油猴一般会提示安装；或复制全文 → 油猴「添加新脚本」粘贴保存。
3. 打开执行记录列表页并刷新。
4. 表格左侧出现勾选框，上方出现「批量下载问答」。

### 方式 B：Chrome / Edge MV3 扩展（开发者模式）

1. 打开 `chrome://extensions`（Edge：`edge://extensions`），开启「开发者模式」。
2. 「加载已解压的扩展程序」，选本目录下的 [`extension/`](./extension/) 文件夹。
3. 打开执行记录列表页并刷新。

## 目录

```text
plugins/execution-log-batch-qa/
├── README.md
├── shared/batch-qa-core.js          # 共用逻辑（ZIP STORE、鉴权、UI）
├── userscript/a3-execution-log-batch-qa.user.js
└── extension/
    ├── manifest.json                # MV3：MAIN bridge + ISOLATED UI
    ├── page-bridge.js
    └── content.js
```

## 使用注意

- 须已登录 A3，且 AUTO Token 可用（页面能点「下载问答」即可）。
- 仅列表视图生效；点进单会话详情后工具条会隐藏。
- 大批量时串行请求，避免打爆接口；失败会话会在状态栏/控制台提示，成功的仍会进 ZIP。

## 验证建议

1. 登录生产/测试执行记录页，确认单行「下载问答」正常。
2. 启用插件后刷新，勾选 2～3 行 →「批量下载问答」。
3. 解压 ZIP，条目内容应与分别点「下载问答」一致。
