# 第三方来源与许可

核心代码为独立实现，没有复制其他桥接项目代码；星渡图标作为项目资产集成，随本项目MIT许可提供。MIT仅约束本项目代码，各第三方仍适用其自己的许可证，不构成OpenAI授权或商标背书。

桌面 IPC 实验及可选固定回声模块参考 [Destiny-Rul/codex-desktop-control](https://github.com/Destiny-Rul/codex-desktop-control/tree/ed5bbc505cb77e2d15fbc4b63b51b1b90722f98d)（MIT，固定提交）及 [melompeel/codex-desktop-remote](https://github.com/melompeel/codex-desktop-remote)（MIT）的协议说明。均为独立实现，不捆绑其代码、不运行其安装或认证流程；不是 OpenAI 公开稳定 API。可选插件入口默认关闭，仅供明确授权的固定文本实验。

| 组件 | 当前锁定版本 | 许可证 / 官方来源 |
| --- | --- | --- |
| MCP SDK server / node | 2.3.1 / 2.1.1 | Apache-2.0 · [TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) |
| better-sqlite3 | 13.0.3 | MIT · [WiseLibs](https://github.com/WiseLibs/better-sqlite3)；SQLite有独立声明 |
| Fastify | 5.12.5 | MIT · [Fastify](https://github.com/fastify/fastify) |
| ipaddr.js | 2.2.0 | MIT · [ipaddr.js](https://github.com/whitequark/ipaddr.js) |
| standardwebhooks | 1.0.0 | MIT · [Standard Webhooks](https://github.com/standard-webhooks/standard-webhooks) |
| Zod | 4.6.5（lockfile解析） | MIT · [Zod](https://github.com/colinhacks/zod) |
| Node.js | 24.21.0 | [Node](https://nodejs.org/dist/v24.21.0/)官方压缩包LICENSE，包含运行时及嵌入第三方完整声明 |
| tunnel-client 本地修改版 | 0.0.17-local-refusal.1 | Apache-2.0 · 基于[官方 v0.0.17](https://github.com/openai/tunnel-client/releases/tag/v0.0.17)，保留 LICENSE、NOTICE、licenses.txt 与 SPDX；此 EXE 不是官方原版 |

精确直接及传递依赖版本见 package-lock.json。发布构建从安装后的生产包读取每个npm包的license和许可文件位置，生成 `licenses/npm-inventory.json`，原LICENSE/NOTICE保留在对应node_modules目录；声明或许可文件缺失时构建失败。开发依赖TypeScript、tsx、@types及其传递依赖不进入安装包，源码构建时按各npm包许可使用。

Windows包内 `runtime/node-v24.21.0-win-x64/LICENSE` 保留Node声明，`vendor/tunnel-client-v0.0.17-local-refusal.1-windows-amd64/` 保留官方许可、NOTICE、依赖清单及 cloudflared 伴随文件，tunnel-client.exe 替换为明确标识的本地修改版。构建核对官方Tunnel ZIP SHA256，不替换第三方原文。源码仓库不提交运行时、node_modules或Tunnel二进制，分发校验见 `scripts/check-package.ps1`。

生产 npm 包 abstract-logging 2.0.1 与 standardwebhooks 1.0.0 缺少独立许可正文，本项目补收录其上游原文。abstract-logging README 指向作者 MIT 许可网页，保留完整网页原文件；standardwebhooks 使用固定发布 gitHead 的 libraries/LICENSE（MIT），不混用仓库根的 Apache 许可。来源见 licenses/supplemental.json。

Windows Setup.exe 使用 Inno Setup 7.1.0 编译。构建工具来自官方不可变发布，校验发布摘要和 Pyrsys B.V. Authenticode 签名；不随软件分发编译器。安装引擎保留 Jordan Russell 与 Martijn Laan 的原版权及网站信息，遵循 [Inno Setup License](https://jrsoftware.org/files/is/license.txt)。本项目未修改安装引擎。

Tunnel 修改固定基于上游提交 `a248b7f725fc989c1eb26680cf4351ee33421f61`。修改涉及连接拒绝分类、启动发现重试和对应测试；补丁见 [refusal-recovery.patch](third-party/tunnel-client/refusal-recovery.patch)，构建入口见 [build.ps1](third-party/tunnel-client/build.ps1)。修改文件通过该独立补丁明确标识。原有 Apache-2.0 许可与上游 NOTICE 保持原文；包内 local-patch.json 标明版本、来源及二进制摘要。上游 SPDX 描述未变的依赖，不冒充本地修改二进制的官方签名或背书。