# FlareTune 官方插件

本仓库维护 FlareTune 的官方插件源码、可重复生成的插件包及插件目录。插件代码与宿主分开维护；安装、更新或卸载后，由站点管理员选择手动或自动重新构建并部署。

首批目录：`ai-gateway`、`assistant`、`lyrics-workbench`、`roam`、`xiaomi-speaker`、`youtube-music`。实际可用状态以目录发布及宿主兼容性验证为准。当前拆分尚在联调，不能仅凭源码或本地包存在视为已发布。

## 布局

- `plugins/<id>/manifest.json`：稳定 ID、版本、语言、页面、角色和依赖声明。
- `plugins/<id>/{client,server,shared}/`：插件拥有的业务源码；SDK 和声明的跨插件服务由宿主提供。
- `artifacts/<id>/<version>/<sha256>.json`：按文件完整字节摘要命名的不可变 v2 包。
- `repository.json`：schemaVersion 1 官方目录；每个产物 URL 固定到已有 Git 提交。

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

4. 复核目录 manifest 与产物一致，URL 不含分支或可变 tag，且每个 SHA256 与下载字节一致。将目录作为后续提交发布。
5. 回读公共目录和每个固定提交 URL，再在测试 Worker 验证安装、更新、卸载与构建激活。

公共官方目录入口预定为 `https://raw.githubusercontent.com/arctan303/FlareTune-Plugins/main/repository.json`。目录可以更新；其中的产物链接必须保持不可变。不要在此仓库保存站点配置、部署 Hook、Cloudflare 凭据、构建访问密钥或用户数据。

## 宿主接口

插件声明 `hostApiVersion: 2`。`client/index.jsx` 提供前端入口，`server/index.js` 提供服务端入口；产物的 `exports` 将原始公开路径映射至实际预打包文件；CSS 和 JSON 保留原始公开文件键。跨插件服务只支持声明的 JavaScript 模块，JSON 数据文件不构成服务入口。SDK 与服务导入采用 `@flaretune/plugin-sdk...` 及 `@flaretune/plugin-service/<id>/<publicKey>`。

此版本不实现热加载或不可信代码沙箱。管理员确认信任来源后，插件作为站点代码运行；摘要校验不能代替信任发布者。

## 许可

FlareTune 插件业务源码使用 MIT，见 [LICENSE](LICENSE) 和 [NOTICE](NOTICE)。预打包依赖各自保留原许可，不因打包而更改许可。`@bufbuild/protobuf@2.17.0` 的 npm 包未附独立许可文件，因此在 `tooling/licenses/bufbuild-protobuf-2.17.0/` 保留同版本上游 Apache 文本及包内 BSD 完整头，并记录来源；发布器核对版本和文本 SHA256，升级后需重新审查。