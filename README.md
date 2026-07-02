# translate.openai.js — 为 translate.js 接入自定义 OpenAI 兼容翻译 API

> 让任何使用 [translate.js](https://github.com/xnx3/translate) 的网页/游戏，都能接入 OpenAI 兼容的大模型翻译 API（DeepSeek、智谱、通义、OpenAI 官方、本地 Ollama、OneAPI 等），获得远超机器翻译的翻译质量，并具备本地持久化缓存、上下文增强、自动降级容错等能力。

---

## 致敬

本项目基于管雷鸣（[xnx3](https://github.com/xnx3)）开源的 **translate.js** 网页自动翻译组件构建。translate.js 是一个优秀的开源国际化翻译方案，以其轻量、零依赖、即插即用的特性，让无数网页轻松实现多语言切换。

- **translate.js 开源仓库**：https://github.com/xnx3/translate
- **translate.js 官方文档**：https://translate.zvo.cn
- **translate.js 作者**：管雷鸣

本插件 `translate.openai.js` 是 translate.js 的**第三方扩展插件**，不修改原库任何代码，通过 monkey-patch 方式挂载，保持与原库的完全兼容，可随时升级 translate.js 版本。

感谢管雷鸣为开源社区贡献的优秀作品。

---

## 作用

在原版 translate.js 中，翻译通道只有几种选择：
1. `client.edge` — Edge 浏览器内置机器翻译（免费，但翻译质量一般）
2. `translate.service` — 官方私有部署翻译服务（需付费授权）
3. `giteeAI` / `siliconflow` — 特定云平台

**本插件新增第四种通道：`openai`** — 接入任意 OpenAI 兼容的大模型翻译 API。

你只需提供：
- 一个 API 端点 URL（如 `https://api.deepseek.com/v1/chat/completions`）
- 一个 API Key
- 一个模型名（如 `deepseek-chat`）

插件就会接管 translate.js 的翻译请求，用大模型完成翻译，并在本地持久化缓存翻译结果。

---

## 功能一览

### 核心翻译

| 功能 | 说明 |
|---|---|
| **OpenAI 兼容 API** | 支持任何符合 OpenAI Chat Completions 格式的端点 |
| **自定义提示词** | 可自定义翻译提示词模板，指定翻译场景（游戏、论文、小说等） |
| **术语库兼容** | 完全兼容 translate.js 原有的自定义术语库（`translate.nomenclature`） |

### 智能分批与并行

| 功能 | 说明 |
|---|---|
| **自适应分批** | 按条数上限和字符上限双重控制，长文本自动少分几条，短文本可多分几条 |
| **并行翻译** | 多批同时发起请求，受并发上限控制，大幅缩短翻译总耗时 |
| **JSON 输出格式** | 默认用 JSON 数组格式返回，几乎不会格式异常，支持大批量翻译 |
| **分隔符模式** | 可切换为分隔符模式，兼容个别对 JSON 不友好的模型 |

### 容错与降级

| 功能 | 说明 |
|---|---|
| **自动修复切分** | 模型回复格式不规范时（多了说明文字、代码块包裹等），自动修复后再判定 |
| **降级前重试** | 格式异常时用更严格的提示词重试 1 次，避免不必要的降级 |
| **并行降级** | 修复+重试仍失败时，降级为逐条翻译，但改为并行而非串行，大幅缩短降级耗时 |
| **自动降级到 Edge** | 连续失败超过阈值或 API Key 无效时，自动切回 Edge 浏览器翻译 |
| **自动探测恢复** | 降级后每 60 秒自动探测 OpenAI 端点，恢复后自动切回大模型 |
| **状态徽章** | 右下角常驻状态指示：绿点"大模型翻译中" / 红点"已降级·质量下降" |

### 上下文增强

| 功能 | 说明 |
|---|---|
| **同场景上下文** | 将同一次翻译请求中的其它文本作为上下文一并发给模型，帮助理解整体语境 |
| **带编号列表** | 上下文以 `[1] xxx [2] xxx` 编号列表格式提供，模型清晰区分上下文与待翻译内容 |
| **字符上限控制** | 全量上下文超过字符上限时，自动改为取当前批前后各 N 条 |
| **单条截断** | 单条上下文超 200 字符自动截断，防止一条巨长文本撑爆上下文 |

### 本地持久化缓存

| 功能 | 说明 |
|---|---|
| **文件持久化** | 翻译结果自动写入本地文件 `{userData}/TranslateCache/{语种}.json`，跨会话保留 |
| **重启即加载** | 启动时自动扫描所有缓存文件并灌入 localStorage，已翻译内容立即显示、不调 API |
| **防抖写入** | 翻译完成后防抖 3 秒写入文件，避免频繁 IO |
| **关窗强制写** | 窗口关闭时同步强制写入，防止数据丢失 |
| **原子写入** | 先写 `.tmp` 再 rename，避免进程退出导致文件损坏 |
| **按语种分文件** | 每种目标语言一个缓存文件，互不干扰 |
| **导出缓存** | 一键导出缓存为 JSON 文件，方便备份或分享给朋友 |
| **导入缓存** | 一键从 JSON 文件导入缓存，合并到本地 |
| **清空缓存** | 二次确认后清空当前语种缓存（删文件 + 清 localStorage） |
| **缓存统计** | 设置面板实时显示已缓存条数和文件大小 |

### 设置面板

| 功能 | 说明 |
|---|---|
| **齿轮按钮** | 右下角浮动齿轮，随时调出设置 |
| **测试连接** | 填完配置后一键测试，显示成功/失败 + 响应耗时 |
| **所有参数可视化** | 端点、Key、模型、批量大小、并发、上下文、提示词等全部可视化配置 |
| **配置持久化** | 配置存入 localStorage，重启自动读取 |

---

## 特色与特点

### 1. 零侵入原库
不修改 translate.js 任何一行代码，通过 monkey-patch `translate.request.post` 实现拦截。translate.js 升级时只需替换 translate.js 文件，插件无需改动。

### 2. Electron 友好
优先使用 Node.js 的 `https`/`http` 模块发请求（Electron `nodeIntegration:true` 环境），**完全绕过 CORS 限制**，可对接任何 OpenAI 兼容端点。非 Electron 环境自动降级为 `fetch`。

### 3. 玩着玩着就翻译完了
缓存系统的核心理念：**第一次玩到某个场景时用大模型翻译并缓存，之后再玩到同一个场景直接用缓存**。玩遍全游戏后，本地缓存文件就是一本完整的译本，可以导出分享给朋友，朋友导入后无需再调 API。

### 4. 翻译质量与速度兼顾
- 上下文增强让翻译更准确（模型理解整体语境）
- JSON 输出 + 自适应分批 + 并行请求让翻译更快
- 自动修复 + 重试 + 并行降级让容错更强

### 5. 自动降级保底
大模型 API 不通时自动切回 Edge 浏览器翻译，翻译质量下降但功能不中断，徽章变红提示用户，恢复后自动切回。

---

## 默认配置

| 参数 | 默认值 | 说明 |
|---|---|---|
| `batchSize` | 10 | 每批文本条数上限 |
| `batchCharLimit` | 1000 | 每批字符上限（与条数上限取较小者） |
| `maxConcurrency` | 5 | 并行请求上限 |
| `requestTimeout` | 60000 | 单请求超时（毫秒） |
| `scene` | 游戏文本翻译 | 翻译场景，注入提示词 |
| `temperature` | 0.3 | 模型温度 |
| `outputFormat` | json | 输出格式（json / separator） |
| `progressiveOutput` | false | 渐进式输出（实验性，默认关） |
| `contextEnabled` | true | 上下文增强开关 |
| `contextLimit` | 300 | 全量上下文字符上限 |
| `contextWindow` | 5 | 超限时当前批前后各取条数 |
| `retryOnFormatError` | true | 格式异常时重试 1 次 |
| `degradeParallel` | true | 降级时并行逐条 |
| `autoRecoverInterval` | 60000 | 降级后探测恢复间隔（毫秒） |
| `degradeThreshold` | 3 | 连续失败触发降级的阈值 |

以上参数均可在设置面板中调整，保存后立即生效。

---

## 安装与使用（以 TiTS 游戏为例）

### 前提条件

- 已有 translate.js（v3.x）集成
- 一个 OpenAI 兼容的 API 端点（如 DeepSeek、智谱、通义等）

### 步骤

#### 1. 放置插件文件

将 `translate.openai.js` 与 `translate.js` 放到` index.html` 同目录下（一般在app文件夹）。

#### 2. 引入插件脚本

在 HTML 页面中，**在 `translate.js` 之后**引入插件：

```html
<!-- 第一步：引入 translate.js 库 -->
<script src="./translate.js"></script>

<!-- 第二步：引入自定义术语库（如有） -->
<script src="./custom_translation_terms.js"></script>

<!-- 第三步：引入 OpenAI 兼容翻译插件 -->
<script src="./translate.openai.js"></script>

<!-- 第四步：初始化配置 -->
<script>
window.addEventListener('load', function() {
    setTimeout(function() {
        // 读取已保存的 OpenAI 翻译配置
        var openaiCfg = null;
        try {
            var raw = localStorage.getItem('translate_openai_config');
            if (raw) openaiCfg = JSON.parse(raw);
        } catch(e) { console.warn('读取翻译配置失败', e); }

        if (openaiCfg && openaiCfg.endpoint && openaiCfg.apiKey) {
            // 已配置 → 启用大模型翻译
            translate.service.openai.use(openaiCfg);
        } else {
            // 未配置 → 降级使用 Edge 并弹出设置引导
            translate.service.use('client.edge');
            translate.service.openai.settingsUI.buildGearButton();
            translate.service.openai.settingsUI.show();
        }

        // 开启页面元素动态监控
        translate.listener.start();
        // 执行翻译初始化操作
        translate.execute();
    }, 1000);
});
</script>
```

#### 3. 首次配置

1. 启动应用，右下角自动弹出设置面板（因未配置）
2. 填写：
   - **API 端点**：如 `https://api.deepseek.com/v1/chat/completions`
   - **API Key**：如 `sk-xxxxxxxx`
   - **模型**：如 `deepseek-chat`
3. 点击「测试连接」→ 显示 ✅ 成功 + 耗时
4. 点击「保存」→ 大模型翻译立即生效

#### 4. 日常使用

- 右下角齿轮 ⚙ 随时调出设置
- 齿轮旁徽章显示翻译状态：
  - 🟢 **大模型翻译中** — 正常工作
  - 🔴 **已降级·质量下降** — API 不通，已自动切 Edge，将自动探测恢复

---

## 如何用在其他游戏/网页里

本插件适用于**任何已集成 translate.js 的网页或 Electron 应用**。以下是通用接入步骤：

### 场景一：Electron 游戏（如 TiTS）

1. 找到游戏的 HTML 入口文件（通常是 `index.html` 或打包在 `resources/app/` 下）
2. 确认 `translate.js` 已被引入
3. 将 `translate.openai.js` 复制到同目录
4. 在 HTML 中按上方步骤 2 引入脚本和初始化代码
5. 确认 Electron 的 `nodeIntegration: true`（这样插件能用 Node https 绕过 CORS）
6. 启动游戏，首次会弹设置面板，填入 API 配置即可

### 场景二：普通网页

1. 在页面 `<head>` 或 `<body>` 底部引入 `translate.js` 和 `translate.openai.js`
2. 加入初始化代码（同上）
3. 注意：普通网页环境下插件会降级使用 `fetch` 发请求，**要求 API 端点支持 CORS**（大多数 OpenAI 兼容服务都支持）
4. 缓存文件功能在普通网页下不可用（无 Node fs），仅用 localStorage 缓存

### 场景三：已有 translate.js 的项目升级

如果你已经在用 translate.js（如 `client.edge` 或 `translate.service`），只需：

1. 在 `translate.js` 之后加一行 `<script src="./translate.openai.js"></script>`
2. 把初始化代码里的 `translate.service.use('client.edge')` 替换为上方的智能初始化逻辑
3. 原有的 `custom_translation_terms.js`（术语库）完全保留，无需改动

### 兼容的 API 端点示例

| 服务 | 端点 URL | 模型示例 |
|---|---|---|
| DeepSeek | `https://api.deepseek.com/v1/chat/completions` | `deepseek-chat` |
| 智谱 AI | `https://open.bigmodel.cn/api/paas/v4/chat/completions` | `glm-4-flash` |
| 通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions` | `qwen-turbo` |
| OpenAI 官方 | `https://api.openai.com/v1/chat/completions` | `gpt-4o-mini` |
| 本地 Ollama | `http://localhost:11434/v1/chat/completions` | `qwen2.5:7b` |
| OneAPI / NewAPI | `https://你的OneAPI地址/v1/chat/completions` | 自定义 |

---

## 缓存文件说明

### 文件位置

```
Windows: %APPDATA%/{应用名}/TranslateCache/{语种}.json
```

例如 TiTS 游戏：
```
C:\Users\{用户名}\AppData\Roaming\TiTS\TranslateCache\chinese_simplified.json
```

### 文件格式

```json
{
  "version": 1,
  "to": "chinese_simplified",
  "updatedAt": 1730000000000,
  "count": 12345,
  "entries": {
    "1234567": "你好",
    "7654321": "世界"
  }
}
```

- key = 原文 hash（translate.js 的 DJB2-like 哈希算法）
- value = 译文
- 跨会话、跨版本更新均有效（只要游戏文本不变，hash 就不变，缓存就命中）

### 导出与分享

1. 打开设置面板（齿轮按钮）
2. 点击「导出缓存到文件」→ 选择保存位置 → 得到 `chinese_simplified_cache_20260702.json`
3. 分享给朋友
4. 朋友打开设置面板 → 点击「从文件导入缓存」→ 选择该 JSON 文件 → 立即生效，无需再调 API

---

## 工作原理

### 翻译流程

```
translate.js 扫描 DOM → 提取文本数组
  ↓
translate.request.post 被插件拦截
  ↓
translate.service.openai.translate()
  ├─ 自适应分批（按条数 + 字符上限）
  ├─ 并发池控制（maxConcurrency）
  ├─ 每批构造提示词（含上下文 + JSON 格式指令）
  ├─ 调用 OpenAI 兼容 API
  ├─ 解析回复（JSON.parse / 分隔符切分）
  ├─ 格式异常 → 自动修复 → 重试 1 次 → 并行降级
  └─ 每批完成立即 cache.record()
  ↓
全部完成 → func() 回调 translate.js → 渲染译文
  ↓
防抖 3 秒 / 关窗 → 写入缓存文件
```

### 降级与恢复

```
正常工作（🟢 大模型翻译中）
  ↓ 连续失败 ≥ 3 次 / API Key 无效
自动降级到 Edge（🔴 已降级·质量下降）
  ↓ 每 60 秒自动探测
探测成功 → 自动恢复（🟢 大模型翻译中）
探测失败 → 继续探测
```

### 缓存命中

```
translate.js 翻译前查 localStorage['hash_{to}_{hash}']
  ↓ 命中 → 直接用缓存，不调 API
  ↓ 未命中 → 调 OpenAI API → 翻译结果写入 localStorage + 缓存文件
```

---

## 文件清单

| 文件 | 说明 | 是否需要 |
|---|---|---|
| `translate.js` | 原版翻译库（管雷鸣 开源） | 必需（不修改） |
| `translate.openai.js` | 本插件 | 必需 |
| `custom_translation_terms.js` | 自定义术语库（游戏专有名词翻译） | 可选 |

---

## 常见问题

### Q: 重启后缓存没有加载？

A: 检查控制台是否有 `[translate.openai] loadAll: 已加载 xxx 缓存 N 条`。如果没有：
1. 确认缓存文件存在：`%APPDATA%/{应用名}/TranslateCache/*.json`
2. 确认 `use()` 在 `translate.execute()` 之前调用
3. 如果缓存文件为空，说明上次翻译时没写盘——检查关窗时是否有 `[translate.openai] 关窗强制写入缓存完成` 日志

### Q: 翻译很慢？

A: 调整设置面板中的参数：
- 增大「并发上限」（如 8-10）
- 增大「每批字符上限」（如 2000-4000）
- 确认「输出格式」为 JSON（比分隔符快）
- 确认「渐进式输出」关闭（避免状态冲突）

### Q: 格式异常频繁降级？

A:
- 确认「输出格式」为 JSON
- 尝试更换更遵循指令的模型
- 在高级设置里检查提示词模板是否被误改

### Q: API Key 无效一直降级？

A: 徽章会变红显示"已降级·质量下降"。打开设置面板，修改正确的 API Key 后保存，插件会立即尝试恢复。

### Q: 想分享翻译缓存给朋友？

A: 设置面板 → 「导出缓存到文件」→ 发给朋友 → 朋友「从文件导入缓存」即可。

### Q: 可以用在非 Electron 的普通网页吗？

A: 可以，但有两个限制：
1. 缓存文件持久化不可用（无 Node fs），仅用 localStorage
2. API 端点必须支持 CORS

---

## 技术细节

### Monkey-patch 拦截

插件通过覆写 `translate.request.post` 实现拦截，当 `translate.service.name === 'openai'` 时：
- 翻译请求 → 转给 `translate.service.openai.translate()`
- 语种列表 → 返回插件内置的 30 种常用语种
- init/connectTest/ip 请求 → 直接忽略（OpenAI 模式不需要）

### Node https 规避 CORS

在 Electron `nodeIntegration:true` 环境下，插件用 `require('https')` / `require('http')` 发请求，完全绕过浏览器的 CORS 限制。非 Electron 环境降级为 `fetch`。

### 缓存与 translate.js 的关系

translate.js 本身就用 `localStorage['hash_{to}_{hash}']` 做翻译缓存。插件做的只是：
1. 启动时把本地文件里的缓存灌入 localStorage（让 translate.js 命中）
2. 翻译完成后把新结果额外写入本地文件（持久化）

所以缓存命中逻辑完全由 translate.js 原生处理，插件不干预。

---

## 许可证

本插件 `translate.openai.js` 可自由使用、修改、分发。

translate.js 本身遵循其原作者的开源协议，详见 https://github.com/xnx3/translate 。

---

## 致谢

- **translate.js** 作者 **管雷鸣**（[xnx3](https://github.com/xnx3)）— 感谢这个优秀的开源翻译组件
- **translate.js 开源社区**的所有贡献者
- 所有 OpenAI 兼容 API 服务的提供者

> "站在巨人的肩膀上。" — 本插件只是为 translate.js 这棵大树嫁接了一根新枝，让它能接入大模型翻译的能力。所有的根基都是 translate.js 打下的。
