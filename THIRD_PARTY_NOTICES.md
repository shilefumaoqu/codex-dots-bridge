# 第三方来源与许可

核心代码为独立实现，没有复制其他桥接项目代码；星渡图标作为项目资产集成，随本项目MIT许可提供。MIT仅约束本项目代码，各第三方仍适用其自己的许可证，不构成OpenAI授权或商标背书。

| 组件 | 当前锁定版本 | 许可证 / 官方来源 |
| --- | --- | --- |
| MCP SDK server / node | 2.3.1 / 2.1.1 | Apache-2.0 · [TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) |
| better-sqlite3 | 13.0.3 | MIT · [WiseLibs](https://github.com/WiseLibs/better-sqlite3)；SQLite有独立声明 |
| Fastify | 5.12.5 | MIT · [Fastify](https://github.com/fastify/fastify) |
| ipaddr.js | 2.2.0 | MIT · [ipaddr.js](https://github.com/whitequark/ipaddr.js) |
| standardwebhooks | 1.0.0 | MIT · [Standard Webhooks](https://github.com/standard-webhooks/standard-webhooks) |
| Zod | 4.6.5（lockfile解析） | MIT · [Zod](https://github.com/colinhacks/zod) |
| Node.js | 24.21.0 | [Node](https://nodejs.org/dist/v24.21.0/)官方压缩包LICENSE，包含运行时及嵌入第三方完整声明 |
| OpenAI tunnel-client | 0.0.16 | Apache-2.0 · [官方发布](https://github.com/openai/tunnel-client/releases/tag/v0.0.16)，随完整包保留LICENSE、NOTICE、licenses.txt与SPDX清单 |

精确直接及传递依赖版本见 package-lock.json。发布构建从安装后的生产包读取每个npm包的license和许可文件位置，生成 `licenses/npm-inventory.json`，原LICENSE/NOTICE保留在对应node_modules目录；声明或许可文件缺失时构建失败。开发依赖TypeScript、tsx、@types及其传递依赖不进入安装包，源码构建时按各npm包许可使用。

Windows包内 `runtime/node-v24.21.0-win-x64/LICENSE` 保留Node声明，`vendor/tunnel-client-v0.0.16-windows-amd64/` 保留官方整包及cloudflared伴随文件。构建核对官方Tunnel ZIP SHA256，不替换第三方原文。源码仓库不提交运行时、node_modules或Tunnel二进制，分发校验见 `scripts/check-package.ps1`。

生产 npm 包 abstract-logging 2.0.1 与 standardwebhooks 1.0.0 缺少独立许可正文，本项目补收录其上游原文。abstract-logging README 指向作者 MIT 许可网页，保留完整网页原文件；standardwebhooks 使用固定发布 gitHead 的 libraries/LICENSE（MIT），不混用仓库根的 Apache 许可。来源见 licenses/supplemental.json。
