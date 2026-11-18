# A3GEO 全部负面文章导出（Chrome / Edge 扩展）

一键导出 A3GEO **品牌舆情追踪 → 负面文章排行 →「全部负面文章」** 的完整列表（按当前筛选条件分页拉取，不是首页预览表那几行）。

目标页：`https://geo.a3database.cn/monitor/sentiment`

## 功能

- Manifest V3，可「加载已解压的扩展程序」，也可打 zip 分享
- 优先调用站点自有 API：`POST /dso/api/geo/resource/negative_article_rank`（复用当前登录态与页面签名脚本）
- 支持导出 **CSV** 与 **Excel（.xls / SpreadsheetML）**
- 跟随当前页筛选：品牌/计划、平台、问题、日期
- 舆情页右下角提供浮动按钮，也可点扩展图标导出

## 安装（本机）

当前版本：**1.0.1**（若你装过旧版，请在扩展页点「重新加载」，然后**刷新**舆情页面再试）。

### Chrome

1. 打开 `chrome://extensions`
2. 打开右上角「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择本目录：`extensions/a3geo-negative-articles-export`
5. 打开舆情页后，右下角应出现绿色按钮「导出全部负面文章」；点扩展图标也可导出

### Edge

1. 打开 `edge://extensions`
2. 打开「开发人员模式」
3. 「加载解压缩的扩展」→ 选择同上目录

## 使用

1. 用浏览器登录 [A3GEO](https://geo.a3database.cn/)
2. 进入 **品牌监测 → 品牌舆情追踪**（`/monitor/sentiment`）
3. 选好品牌/计划、平台、问题、日期，等页面数据加载完成
4. 点击扩展图标 → **一键导出全部负面文章**  
   或点击页面右下角 **导出全部负面文章**
5. 按提示保存 CSV / Excel 文件

## 导出字段

| 字段 | 说明 |
| --- | --- |
| 文章名称 | `title` |
| 发布时间 | `publish_time` |
| 发布站点 | `site_name` |
| 站点域名 | `domain_name` |
| 站点类型 | `category` |
| 文章负面词 | `negative_mentions_count` |
| 引用AI平台数 | `platform_count` |
| 引用AI平台 | `platforms`（平台代码，逗号拼接） |
| 引用AI问题数 | `prompt_count` |
| 引用次数 | `article_quote_count` |
| 原文链接 | `url` |
| 文章ID | `source_id` |

列表接口已返回上述字段，导出时**不会**再逐行打开详情弹窗。

## 分享给同事

在本目录的上一级执行：

```bash
cd extensions
zip -r a3geo-negative-articles-export.zip a3geo-negative-articles-export \
  -x "*.DS_Store" -x "**/.git/**"
```

把 `a3geo-negative-articles-export.zip` 发给对方。对方解压后，按「安装」步骤选择**解压后的文件夹**加载即可（Chrome/Edge 一般不能直接装 zip，需解压）。

也可直接把整个 `a3geo-negative-articles-export` 文件夹拷贝过去。

## 限制与说明

- 必须已在该浏览器登录 A3GEO；扩展不保存、不传输账号密码
- 仅在 `geo.a3database.cn` 舆情相关流程使用；不会抓取无关页面
- 导出结果 = **当前筛选条件下** 的全部负面文章；换筛选需重新导出
- 日期需已选择；未选品牌/日期时会提示
- `platforms` 为站点内部平台代码（如 `DP`、`XHSA_DD`），与页面图标对应
- Excel 文件为 SpreadsheetML（扩展名 `.xls`），可用 Excel / WPS 直接打开；若需严格 OOXML `.xlsx`，可用 Excel「另存为」

## 目录结构

```
a3geo-negative-articles-export/
  manifest.json
  popup.html / popup.js / popup.css
  content.js
  injected.js          # 页面主世界：读筛选 + 签名请求 + 分页
  background.js
  lib/export-utils.js  # CSV / Excel 生成
  icons/
  README.md
```

## 隐私

- 请求只发往 `geo.a3database.cn` / `api.aidso.com`
- 不收集、不上报账号或导出内容
- 源码中不含任何测试账号或密钥
