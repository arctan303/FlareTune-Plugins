# 歌词工作台 1.0.0 / Lyrics workspace 1.0.0

状态 / Status：**候选与发布准备中，尚未正式发布 / Release candidate; not yet formally released.** 正式发布须先完成 dev 实测、完整验证及独立复核；本说明不是已上线或全部测试通过的声明。

## 中文

这是歌词工作台首个正式版本的候选。保留歌词查看、候选选择、编辑、时间调整、导入、导出及恢复能力，简化自动获取与 AI 补译链路；客户端继续只消费现有歌词接口，不承担语言或翻译资格判断。

### 歌词与翻译

- 纯音乐标签在服务端直接短路，不搜索歌词、不调用歌词 AI。
- 获取并选择合适歌词后，已有可用的目标语言来源译文直接保存、复用，不再经过 AI。例如目标为中文、来源提供有效中文译文时，直接使用。
- 没有可用译文时，先依据歌曲语言标签判断；缺少标签时，由 AI 按固定语言表与符合度阈值判断主要演唱语言。主要语言已与目标一致时，不为少量外语插句额外翻译；例如中文为主的歌曲在目标为中文时无需翻译。目标为其他语言时仍按主要语言与目标的关系处理。
- 同一个已配置的歌词 AI 模型承担“主要语言打标”和“翻译”两个角色，不增加第二份模型配置。
- 需要翻译时，先返回原歌词和翻译情况，后台异步生成并保存。客户端后续请求复用正在进行的任务或现有结果，不重复生成。
- 有效译文与无需翻译的判断均可复用；原文或目标语言等相关依据变化后重新判断。符合度不足、模型异常或生成失败不会被永久当作无需翻译：原文保留，并提供受控重试。
- 普通自动补译不清理演唱正文，不改行时间或逐字时间；工作台明确选择的清理、草稿和最终保存继续遵守原权限及并发保护。

### 升级前请检查 AI 开关

歌词 AI 现在只有“启用／关闭”，不再提供“仅手动／自动补译”模式。目标语言和已有模型配置继续保留。

| 升级前配置 | 1.0.0 行为 |
| --- | --- |
| AI 已开启，旧模式为仅手动 | 开启；缺标时按需打标，需要时自动异步补译 |
| AI 已开启，旧模式为自动补译 | 开启；按同一流程处理 |
| AI 明确关闭 | 继续关闭，不调用歌词 AI |
| 旧翻译开关明确关闭 | 继续关闭，不因模式精简开启 AI |

如果希望继续避免自动 AI 调用，请在升级前关闭歌词 AI。启用后可能因首次打标和后续翻译产生模型用量；已保存结果会复用，不因每次播放重新生成。工作台的重试、重新翻译和明确清理仍是具体操作，不再构成全局模式。

升级保留原目标语言、模型选择、供应商连接与凭据、歌词文件及已有译文。读取兼容配置时不写回修改；关闭 AI 不会删除已有结果。首次无标签歌曲会等待简短打标，正文返回后再执行整首翻译；实际等待时间取决于所配模型与服务状态。

### 宿主要求、安装与恢复

**本包最低宿主能力兼容编号：5。** 新增“需要翻译、尚未生成”的缓存状态，旧能力 4 宿主无法读取；安装前须使用明确支持能力 5 的宿主。能力编号是宿主能力要求，独立于插件版本 1.0.0 和 FlareTune 软件版本。这次插件发布不包含 FlareTune 宿主 1.3.0 的正式发布，不会自动升级生产站点或其宿主。

官方稳定源入口保持为 [main/repository.json](https://raw.githubusercontent.com/arctan303/FlareTune-Plugins/main/repository.json)。旧版不可变包及目录条目保留；加入新版条目不会自动升级已安装站点。管理员应先确认宿主兼容，再从现有来源选择更新，并按站点既有构建与激活流程应用。

恢复时先保留原歌词文件与配置，再核对目标插件和宿主的兼容性。代码回退不会撤销已经保存的文件或配置；不能因为回退插件就盲目把宿主降到能力 4，新判断缓存仍可能需要能力 5 读取。本版本不提供破坏性自动降级或通过删除原词恢复兼容的操作。

## English

This is the candidate for the first formal release of Lyrics workspace. Viewing, candidate selection, editing, timing adjustments, import, export and recovery remain available. The update simplifies retrieval and AI translation. Consumer clients continue to use the existing lyric API; language and translation eligibility remain server responsibilities.

### Lyrics and translation

- Instrumental tags stop retrieval on the server without lyric searches or lyric AI calls.
- After selecting suitable lyrics, a usable provider translation in the configured target language is saved and reused without an AI pass. For example, a valid Chinese provider translation is used directly when Chinese is the target.
- When no usable translation exists, the song's language tag determines the next step. Untagged songs are assessed against a fixed language table and match threshold. A few foreign phrases do not trigger translation when the predominant language already matches the target. For example, a mainly Chinese song needs no translation when Chinese is the target; a different target is handled according to the predominant language.
- One configured lyric AI model serves two roles: predominant-language tagging and translation. There is no second model configuration.
- When translation is needed, the original lyrics and translation status return before background generation finishes. Later requests reuse the running task or saved result instead of starting duplicate work.
- Valid translations and no-translation decisions are reused. Relevant changes, including original text or target language, trigger reassessment. An insufficient match, model error or generation failure is not cached as a permanent no-translation decision: the original remains available and processing can be retried under the existing limits.
- Routine background translation does not clean up sung content or change line or word timing. Explicit workspace cleanup, drafts and final saves retain their existing permissions and conflict protection.

### Review the AI switch before upgrading

Lyric AI now has one enabled/disabled switch. Manual-only and automatic modes are removed. The existing target language and model configuration are retained.

| Previous configuration | Behavior in 1.0.0 |
| --- | --- |
| AI enabled, manual-only mode | Enabled; assess untagged lyrics and prepare needed translations automatically |
| AI enabled, automatic mode | Enabled; use the same preparation flow |
| AI explicitly disabled | Remains disabled; no lyric AI calls |
| Legacy translation explicitly disabled | Remains disabled; simplifying modes does not enable AI |

Disable lyric AI before upgrading if you want to avoid automatic model calls. Enabled processing may use the model for initial language tagging and subsequent translation. Saved results are reused rather than regenerated on every play. Retry, retranslation and explicit cleanup remain individual workspace actions, not global modes.

The upgrade preserves the target language, selected model, provider connection and credentials, lyric files and existing translations. Compatibility reads do not rewrite configuration. Disabling AI does not delete saved results. A first request for untagged lyrics waits for the short tagging step, then returns the original before full translation finishes. Actual latency depends on the configured model and service.

### Host requirement, installation and recovery

**Minimum host capability level: 5.** The new cached “translation needed, not yet generated” state cannot be read by level-4 hosts. Use a host that explicitly supports level 5 before installing this package. The capability number is independent of plugin version 1.0.0 and the FlareTune application version. This plugin release does not formally release the FlareTune 1.3.0 host or automatically upgrade production sites or their hosts.

The official stable source remains [main/repository.json](https://raw.githubusercontent.com/arctan303/FlareTune-Plugins/main/repository.json). Previously published immutable packages and catalog entries remain available. Publishing a new entry does not automatically upgrade installed sites. Administrators should verify host compatibility, select the update from the existing source and apply it through the site's normal build and activation process.

For recovery, preserve the original lyric files and configuration, then check compatibility between the chosen plugin and host. A code rollback does not undo saved files or settings. Do not blindly downgrade the host to capability level 4 when rolling back the plugin: new decision caches may still require level 5 to read. This version does not offer destructive automatic downgrades or delete original lyrics to restore compatibility.
