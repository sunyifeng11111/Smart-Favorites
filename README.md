# 智能收藏 / Smart Favorites

智能收藏是一款本地优先的 Chrome Manifest V3 扩展。它读取当前网页的有限信号和用户已有的收藏目录，请 JEV 选择最合适的目录；结果不够可信时由用户确认，没有合适目录或服务失败时则保存到唯一的待分类目录。

> [!IMPORTANT]
> 当前版本面向私有 beta。每位测试者必须提供自己的 JEV API 密钥。项目不包含共享开发者密钥、产品后端、账号系统、跨设备同步或远程遥测。

## 核心行为

- 高可信结果可以自动收藏，但会显示最终目录，并允许更改位置或撤销。
- 不确定结果显示三个候选目录和完整目录选择器。
- 重复收藏默认不做任何更改；移动历史收藏必须由用户明确确认。
- JEV 失败、没有匹配目录或没有可分类目录时，收藏会进入扩展管理的待分类目录，稍后可原地重试，不会创建第二份收藏。
- 设置、目录示例、最近记录和评估数据保留在本机。

## 环境要求

- Node.js 22
- pnpm 10.17.1
- Chromium 或 Google Chrome（加载和人工验证扩展）
- 测试者自己的 JEV API 密钥

## 安装依赖与本地开发

```bash
pnpm install --frozen-lockfile
pnpm dev
```

WXT 会在 `.output/` 下生成开发扩展。需要验证与发布一致的构建时运行：

```bash
pnpm build
```

然后在 Chrome 中：

1. 打开 `chrome://extensions`。
2. 开启“开发者模式”。
3. 选择“加载已解压的扩展程序”。
4. 选择 `.output/chrome-mv3`。
5. 固定“智能收藏”，在一个普通 HTTP/HTTPS 网页上打开扩展。

## API 密钥设置

1. 从扩展 popup 打开“设置”。
2. 阅读本地存储未加密的提示。
3. 允许 JEV 数据共享。
4. 输入自己的 JEV API 密钥并保存。
5. 使用“测试连接”验证密钥。

密钥保存在 `chrome.storage.local`，不会写入日志、最近记录、导出文件或 JEV 请求正文。清除浏览器扩展数据或卸载扩展会移除本地设置。

## 隐私边界

智能分类只会向 `https://api.typesafe.ai/*` 发送：

- 当前网页的标题、URL、域名、description、可见 H1，以及最多 4,000 个可见字符；
- 可分类目录的完整路径；
- 每个目录最多三个目录示例的标题和域名。

表单、输入值、密码字段、脚本、样式、导航和隐藏内容不会被采集。`file:`、`chrome:`、`data:` 等页面不会发送给 JEV；无痕窗口中智能收藏完全停用，也不会写入最近记录。最近记录最多保留 100 条和 30 天，且只在用户明确操作时导出到本地。

## 质量检查

常用的独立检查：

```bash
pnpm compile
pnpm lint
pnpm test
pnpm test:browser
pnpm package
```

`pnpm test:browser` 会先生成生产构建，再让 Playwright 启动兼容的 Chromium 并加载真实扩展。首次运行可能需要安装浏览器：

```bash
pnpm exec playwright install chromium
```

浏览器 smoke 覆盖 manifest、popup 到 Service Worker 的消息、设置持久化、动态页面捕获、完整分类/创建/更改目录/撤销、重复收藏警告，以及待分类失败/重试。缺少兼容 Chromium 时测试会失败，不会被标记为通过。

提交 beta 候选前运行完整确定性发布检查：

```bash
pnpm release:verify
```

GitHub Actions 会在 push 和 pull request 上分别执行确定性质量检查与必需的 Chromium smoke，并保存解压构建和版本化 ZIP 作为构建产物。

## Evaluation Set 与 beta 准入

真实 Evaluation Set 保存在本机，不应提交到 Git。它必须：

- 至少包含 100 个由人工标注正确目录的页面；
- 使用精确的 Chrome 目录节点 ID；
- 标记页面语言为 `zh` 或 `en`；
- 与目录示例完全隔离，同一网页不得通过不同 ID 伪装成示例；
- 在无合适目录时把待分类目录 ID 作为正确答案。

结构参考 [`evaluation/evaluation-set.schema.json`](evaluation/evaluation-set.schema.json) 和 [`evaluation/datasets/example.synthetic.json`](evaluation/datasets/example.synthetic.json)。运行真实准入检查：

```bash
JEV_API_KEY=你的密钥 pnpm evaluate:gate \
  evaluation/datasets/my-local-set.json \
  evaluation/results/private-beta-metrics.json
```

命令会输出中文、英文和整体三个分段的 Top-1、Top-3、自动收藏精确率与自动收藏覆盖率，并写入可选的 JSON 报告。整体 beta 门槛为：

| 指标 | 最低要求 |
| --- | ---: |
| Top-1 accuracy | 80% |
| Top-3 accuracy | 95% |
| Automatic Save Precision | 95% |

自动收藏覆盖率始终报告但不设最低门槛；若没有任何页面进入自动收藏，精确率不可计算，准入检查会失败。

## 构建私有测试包

先在 `package.json` 中设置本次候选版本，再运行：

```bash
pnpm package
```

该命令会生成并验证两种产物：

- `.output/chrome-mv3/`：可直接加载的解压构建；
- `.output/smart-favorites-<version>-chrome.zip`：供 Chrome Web Store Private testing 使用的版本化 ZIP。

验证会检查 ZIP 非空、关键入口存在，并确认打包后的 manifest 仍然只申请：

- `bookmarks`
- `storage`
- `activeTab`
- `scripting`
- `https://api.typesafe.ai/*` host access

## Trusted tester 验证清单

仅在 `pnpm release:verify` 和真实 Evaluation Set 的 `pnpm evaluate:gate` 都通过后分发：

- 用全新 Chrome profile 加载解压构建，确认扩展名称、popup 和设置页可打开。
- 使用测试者自己的密钥完成同意、连接测试和一次普通智能收藏。
- 验证自动收藏、候选选择、更改目录、撤销、重复收藏、待分类及重试路径。
- 确认历史收藏不会被自动移动或删除，重试不会生成重复收藏。
- 在 DevTools Network 中确认扩展没有遥测或产品后端请求，智能分类只访问批准的 JEV host。
- 检查最近记录的删除、清空和显式导出，并确认导出不含 API 密钥或网页正文。
- 将版本化 ZIP 上传到 Chrome Web Store 的 Private trusted-tester 渠道；本流程不包含公开商店发布。

## 项目结构

```text
entrypoints/          Chrome Service Worker、popup 和 options 入口
src/application/      Smart Save 应用服务与领域类型
src/adapters/         Chrome API、页面捕获与 JEV 适配器
src/evaluation/       Evaluation Set 计算与 beta gate
src/release/          manifest 与产物验证
e2e/                  Playwright 生产扩展 smoke
evaluation/           schema、示例与本地评估说明
```

架构约束与术语见 [`CONTEXT.md`](CONTEXT.md) 和 [`docs/adr/0001-local-first-byok-jev-integration.md`](docs/adr/0001-local-first-byok-jev-integration.md)。
