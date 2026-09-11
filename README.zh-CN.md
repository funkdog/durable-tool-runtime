# Durable Tool Runtime

**恢复任务，而不只是恢复对话。**

这是一个 MIT 许可的本地参考实现，研究 Agent 工具执行中的持久受理、权限隔离、副作用对账、取消补偿，以及调度器冷启动。它不是生产工作流平台，也不提供任意外部接口的 exactly-once 保证。

## 快速运行

需要 Git、Node.js ≥24.16.0，内置 SQLite ≥3.51.3。进程控制面面向 POSIX；不支持 Windows。

```sh
git clone https://github.com/funkdog/durable-tool-runtime.git
cd durable-tool-runtime
npm ci --ignore-scripts --include=dev
npm run check
npm run demo
```

以上命令不需要模型、账号凭据或 Codex。它会启动真实的本地 MCP/HTTP 服务、独立 worker 和 SQLite 数据库，走过预留、丢响应、杀进程、接管、取消与未知结果场景。正常结尾为 `PASSED`，并打印本次生成的证据目录。

预期业务过程是：库存10→7，worker被杀后仍只预留一次；请求取消后7→10，释放一次。原执行事实与取消结果分别保存。

## 如何阅读

1. [架构](docs/architecture.md)：Task、Run、Grant、Operation和业务回执分别负责什么。
2. [契约](docs/contracts.md)：状态机、不变量及对应测试；这是本项目的行为约定。
3. [完整案例](docs/walkthrough.md)：从一次真实提交到中断、恢复与补偿。
4. [Agent接入](docs/agent-integration.md)：默认无模型、原生运行时模拟模型、真实API三种入口。
5. [实验结果](docs/experiments.md)：历史实验证据与公开版验证分开，保留失败与未知边界。
6. [安全边界](SECURITY.md)：为什么不能直接把本地示例作为公网生产服务。

## 核心判断

- `ACCEPTED`只是平台接下责任，不是业务已经成功。
- 工具超时不代表副作用没发生；先查询/对账，再根据能力决定是否重试。
- Agent授权换代与worker执行换代是两件事，不能混为一把锁。
- 取消有独立操作和结果，不能把过去的成功抹掉。
- Checkpoint是引用入口，恢复时仍须查当前事实和当前权限。
- 原生Codex测试与核心CI分开；真实模型调用必须显式启用并提供专用API key和预算，不读取现有应用登录信息。

本项目提供工程机制与可复现实验，不把一次补验通过当作稳定成功率。MIT原文见[LICENSE](LICENSE)，贡献约定见[CONTRIBUTING](CONTRIBUTING.md)。
