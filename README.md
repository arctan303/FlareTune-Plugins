# FlareTune 官方插件

本仓库维护 FlareTune 的官方插件源码、可重复生成的插件包及插件目录。插件代码与宿主分开维护；安装、更新或卸载后，由站点管理员选择手动或自动重新构建并部署。

官方插件：`ai-gateway`、`assistant`、`lyrics-workbench`、`roam`、`xiaomi-speaker`、`youtube-music`。实际可用状态以目录发布及对应宿主兼容性验证为准，源码或本地包存在不代表已在你的站点安装。

## 布局

- `plugins/<id>/manifest.json`：稳定 ID、版本、语言、页面、角色和依赖声明。
- `plugins/<id>/{client,server,shared}/`：插件拥有的业务源码；SDK 和声明的跨插件服务由宿主提供。
- `artifacts/<id>/<version>/<sha256>.json`：按文件完整字节摘要命名的不可变 v2 包。
- `repository.json`：schemaVersion 1 官方目录；每个产物 URL 固定到已有 Git 提交。

## 分支、目录与兼容范围

本仓库长期保留 `main`、`dev`：日常开发在 `dev`，验收后将稳定范围合入 `main`；临时任务分支用完后删除。删除分支前先保留未整合改动和必要恢复证据。分支名不作为产物身份，每个 artifact 链接始终固定完整提交 SHA 和文件 SHA256。

- 稳定源固定为 `https://raw.githubusercontent.com/arctan303/FlareTune-Plugins/main/repository.json`。保留已发布的旧版条目，供宿主按最低 API 和依赖选择；新版加入目录不强制更新已安装插件。
- 开发源固定为 `https://raw.githubusercontent.com/arctan303/FlareTune-Plugins/dev/catalogs/development.json`，用于已验证的增强宿主和测试组合。它与稳定源分开，不通过临时分支名分发。
- `main` 的当前源码组合为 Gateway 0.2.1、Assistant 0.2.0、Lyrics Workbench 0.2.1、Roam 0.1.1、Xiaomi Speaker 1.1.1、YouTube Music 0.1.1；前三项最低宿主 API 3，其余最低 API 2，旧版 API 2 条目继续保留。
- `dev` 的工作台 0.3.x／YT 0.2.x 依赖增强歌词宿主的来源链及 `preferredAutomaticDocument`、`reliableAutomaticMatch` 等接口，普通 API 3 宿主并不具备这些能力。开发包只用于对应已验证增强宿主，不能仅凭 `hostApiVersion: 3` 认定兼容，也不纳入当前稳定目录。

`catalogs/health-ai-ownership-20261111.json` 保留历史测试输入；新增开发配置使用永久开发源。

## 本地验证

使用 package.json 声明的 Node 版本和仓库锁文件：

```sh
npm ci --ignore-scripts
npm test
npm run artifacts:build
```

测试命令同时运行发布器回归与独立插件的真实源码行为测试；可用 `npm run test:publisher`、`npm run test:plugins` 分别执行。插件测试仅替换明示的宿主 SDK，声明的跨插件服务指向真实提供者。

发布器将文本转换为 LF、排序对象键、预打包锁定的第三方依赖，并保留每个业务模块的公开路径映射。React、Lucide、精确 SDK 与插件服务接口由宿主提供，安装插件时不运行 npm 或包脚本。每个包包含 `shared/NOTICE.json`，保留实际打包依赖的许可文本。

v2 包最大 4 MiB，单文本最大 2 MiB；仅服务端允许 WASM，最多 2 MiB，包含 base64、字节数和 SHA256。测试、fixture、隐藏文件及凭据 JSON 不进入包。CSS 入口和 WASM 的相对引用也由发布器处理。客户端、服务端与中立共享源码分别预打包，生成块只留在对应目录；锁定的 YouTube Worker 供应商先单入口预打包，保留其循环模块初始化顺序及当前锁中的依赖许可；共享源码不得反向导入客户端或服务端，WASM 不进入客户端或共享块。

## 发布顺序

发布前必须完成宿主集成、包安装冒烟和独立审查；此工具不推送 Git、不创建 Release，也不部署 Worker。

1. 在清晰的变更范围中生成并审查源码、锁文件和所有产物。
2. 提交产物，取得该提交的完整 40 位 SHA；该提交必须已包含对应 artifact 文件。
3. 基于该 SHA 生成目录：

```sh
npm run catalog:build -- --artifact-ref <artifact-commit-sha>
```

4. 将新候选条目与稳定目录历史条目合并，复核 manifest 与产物一致、URL 不含分支或可变 tag、每个 SHA256 与下载字节一致。已发布的同一 `id/version` 必须保留原 entry 全文及 SHA，不能同版本换包；源码或依赖改变需要先升插件版本。将目录作为后续提交发布。
5. 回读公共目录和每个固定提交 URL，再在测试 Worker 验证安装、更新、卸载与构建激活。

公共官方目录入口固定为上述 `main/repository.json`。目录可以更新，其中的产物链接必须保持不可变。`catalog:build` 只生成当前源码组合，不自动保留历史版本，提交前须完成上面的条目合并与身份核对。不要在此仓库保存站点配置、部署 Hook、Cloudflare 凭据、构建访问密钥或用户数据。

## 宿主接口

插件通过各自 manifest 的 `hostApiVersion` 声明最低宿主要求；API 2／3 可在同一稳定目录中并存，开发包仍受上面的增强能力边界约束。`client/index.jsx` 提供前端入口，`server/index.js` 提供服务端入口；产物的 `exports` 将原始公开路径映射至实际预打包文件；CSS 和 JSON 保留原始公开文件键。跨插件服务只支持声明的 JavaScript 模块，JSON 数据文件不构成服务入口。SDK 与服务导入采用 `@flaretune/plugin-sdk...` 及 `@flaretune/plugin-service/<id>/<publicKey>`，`_private` 模块不作为跨插件公开服务。

此版本不实现热加载或不可信代码沙箱。管理员确认信任来源后，插件作为站点代码运行；摘要校验不能代替信任发布者。

## 许可

FlareTune 插件业务源码使用 MIT，见 [LICENSE](LICENSE) 和 [NOTICE](NOTICE)。预打包依赖各自保留原许可，不因打包而更改许可。`@bufbuild/protobuf@2.17.0` 的 npm 包未附独立许可文件，因此在 `tooling/licenses/bufbuild-protobuf-2.17.0/` 保留同版本上游 Apache 文本及包内 BSD 完整头，并记录来源；发布器核对版本和文本 SHA256，升级后需重新审查。
