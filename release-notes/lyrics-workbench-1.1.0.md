# Lyrics Workbench 1.1.0 / 歌词工作台 1.1.0

开发候选，尚未发布。最低宿主能力为 API 6；AI 功能需要 AI 网关 0.2.3 或同一兼容系列的更新版本。服务接口版本仍为 1，数据版本仍为 0，不替换旧不可变包或稳定目录。

成员与管理员均可编辑并保存共享歌词。候选、LRC／备份导入、文字、译文、调时、清译文、重置和工作台 AI 共用同一首歌的草稿，最后一次保存才写入共享文件；失败或版本冲突保留草稿。同歌分区切换保留草稿，取消或确认离开才放弃。模型、来源和全站设置仍仅管理员可管理。

消费端继续只使用统一歌词接口。已有人工或工作台处理的文件直接返回；否则复用来源的合格目标译文，有歌曲语言标签则直接判断，缺标才独立快速识别。需要翻译时，首次返回正文和翻译状态的同时自动启动翻译角色，后续请求复用任务与结果，不等待另一次前端请求才生成。整首翻译一次，输出不合格最多补救一次；自动补缺完整成功后保存，手动AI先进入草稿。后台续跑继承平台时限，失败可显式重试。初次匹配与评分算法不变，旧宿主继续选择兼容版本。

Development candidate; not published. Requires host API level 6. AI features require AI gateway 0.2.3 or a compatible later release. Service API version remains 1 and data version remains 0. Existing immutable packages and the stable catalog are unchanged.

Members and administrators can edit and save shared lyrics. Candidates, LRC and backup imports, text, translations, timing, clearing translations, resetting and workspace AI share one song draft. Only the final save writes the shared file; failures and version conflicts keep the draft. Switching between the same song's pages preserves it; canceling or confirming departure discards it. Models, lyric sources and site settings remain administrator-only.

Consumers continue using only the unified lyric API. Processed manual or workbench files are returned directly. Otherwise valid provider translations are reused; known language tags determine need directly, while missing tags receive a separate quick assessment. When translation is needed, its role starts automatically as the first response returns the original lyrics and translation status. Later requests reuse that task and its result; they are not required to start generation. Translation covers the whole song with at most one repair for invalid output. Automatic completion saves complete results; manual AI stages its result in the draft. Background work inherits platform continuation limits, with explicit retry after failure. Initial source matching and scoring remain unchanged, and older hosts continue selecting compatible packages.
