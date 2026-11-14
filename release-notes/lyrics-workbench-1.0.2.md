# 歌词工作台 1.0.2 / Lyrics Workbench 1.0.2

状态 / Status：**1.0.2 正式版 / Stable release.** 复用已审且完成 dev 实测的同一不可变包。 / This release promotes the exact reviewed, dev-validated immutable package.

## 中文

本版整合开发候选中的请求读取优化及旧译文兼容修复；正式稳定源由 1.0.0 直接提供 1.0.2，1.0.1 仍保留为开发候选，不另发稳定包。

- 同一次歌词请求复用已取得的读取结果，减少重复数据库与权限元数据读取；不跨请求缓存权限。写入及响应发布继续核对当前会话、插件安装和配置。
- 已有原词未变化时，不再仅为记录来源已评估而重写资产，保留原 ETag、来源归属、正文、时间轴及译文。
- 历史来源译文没有显式语言字段时，沿用宿主既有来源语言契约进行返回值规范化。有效的旧酷狗等中文译文继续复用，不因字段缺失误报无译文或启动 AI；不回写修改原资产。

候选评分、来源顺序、主要语言判断、AI 开关及客户端接口不变。目标语言、模型选择、供应商连接与凭据、安装身份和已有歌词继续保留；发布不重置配置或恢复已卸载插件。

**最低宿主能力兼容编号仍为 5，数据版本仍为 0。** 优化宿主组合已完成完整本地验证、独立 R2 复核和 dev 实测；具体性能取决于宿主、歌词和模型，不能把一次缓存命中结果当作所有请求的固定开销。

官方稳定入口仍是 [main/repository.json](https://raw.githubusercontent.com/arctan303/FlareTune-Plugins/main/repository.json)。旧条目全文及不可变包保留；管理员需从现有来源选择并按本站正常构建／激活流程应用。本次插件发布不代表宿主 1.3.0 已正式发布，不会自动升级生产站点。

恢复前保留现有歌词和配置，再核对目标宿主／插件兼容性。代码回退不会撤销已经保存的歌词或设置，不盲目降宿主能力或删除原词、缓存、凭据来恢复兼容。

## English

This release combines request-read optimizations and legacy translation compatibility fixes from the development candidates. The stable source advances from 1.0.0 directly to 1.0.2. Version 1.0.1 remains a development candidate and is not separately released as stable.

- Reuses reads within one lyric request to reduce repeated database and authority-metadata reads. Authorization is not cached across requests. Writes and response publication continue to check the current session, plugin installation and configuration.
- Avoids rewriting an unchanged original merely to record source assessment. The existing ETag, provenance, lyrics, timing and translation are preserved.
- Uses the host's existing source-language contract when historical provider translations omit an explicit language field. Valid legacy Chinese translations, including Kugou, remain usable without unnecessary AI. Normalization affects the response without rewriting the stored asset.

Candidate scoring, source order, predominant-language policy, the AI switch and client APIs are unchanged. Target language, selected model, provider connection and credentials, installation identity and existing lyrics are retained. Publishing does not reset settings or restore removed plugins.

**Minimum host capability remains 5; data version remains 0.** The package and optimized host combination passed local tests, independent R2 review and dev validation. Actual performance depends on the host, lyrics and model; a measured cache hit is not a fixed cost for every request.

The official stable source remains [main/repository.json](https://raw.githubusercontent.com/arctan303/FlareTune-Plugins/main/repository.json). Previous entries and immutable packages remain available. Administrators select the update from their existing source and apply it through the site's normal build and activation flow. This plugin release does not formally release the FlareTune 1.3.0 host or automatically upgrade production sites.

For recovery, preserve existing lyrics and settings, then verify host and plugin compatibility. Rolling back code does not undo saved assets or settings. Do not blindly downgrade host capabilities or delete original lyrics, caches or credentials to restore compatibility.
