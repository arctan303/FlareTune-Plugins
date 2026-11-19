# AI Gateway 0.2.3 / AI 网关 0.2.3

开发候选，尚未发布。最低宿主能力为 API 6，服务接口版本仍为 1，数据版本仍为 0。旧消费者继续使用实时授权；仅明确选择的新请求授权模式复用入口已核准的请求上下文，避免长歌词处理期间反复轮询权限与配置。模型、来源及站点配置权限不变。

配合歌词工作台 1.1.0 使用。旧消费者声明的 `^0.2.0` 仍兼容本版本；新工作台要求 `^0.2.3`。旧包、稳定目录、连接配置和凭据不由本说明改写；升级此候选前需要支持 API 6 的宿主。

Development candidate; not published. Requires host API level 6. Service API version remains 1 and data version remains 0. Existing consumers keep live authorization checks. The new, explicitly selected request authorization mode reuses the context approved at entry, avoiding repeated permission and configuration polling during a long lyric operation. Model, source and site configuration permissions are unchanged.

Pairs with Lyrics workspace 1.1.0. Existing consumers declaring `^0.2.0` remain compatible; the new workbench requires `^0.2.3`. This note does not alter old packages, the stable catalog, connections or credentials. Upgrade the host to API 6 before selecting this candidate.
