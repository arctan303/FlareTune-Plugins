# Lyrics Workbench 1.0.1 / 歌词工作台 1.0.1

按歌曲内部ID读取已有歌词时，请求内复用claim阶段取得的原文快照，避免resolve阶段再次读取同一文件。宿主已经完成入口授权时，工作台不再重复执行同一套完整查询；最终返回、配置变化和异步写回的实时保护继续由宿主执行。

已有原文没有被更优候选替换时，直接沿用该原文和ETag，不再仅为评估标记重写文件；保留真实的weak质量、出处、人工内容、偏移及时间轴。候选评分、来源顺序、语言判断和客户端接口保持原有规则。无需翻译的结果和异步翻译任务继续复用。

最低宿主能力兼容编号仍为5，数据版本不变。当前优化组合先在dev验证，不替代1.0.0的正式发布记录，也不发布宿主1.3.0或更新生产站。

Request-local reads reuse the original snapshot obtained during the claim step. When the host has already authorized entry, the workbench avoids repeating the same complete read-authority query. Host checks at response publication, configuration changes and asynchronous writes remain live.

An existing original that no better candidate replaces retains its ETag and bytes instead of being rewritten solely for an assessment marker. Actual weak quality, provenance, manual content, offset and timing are retained. Candidate scoring, source order, language policy and consumer APIs remain unchanged.

The minimum host capability remains 5 and the data version is unchanged. This combination is verified on dev first; it does not replace the stable 1.0.0 release record, publish FlareTune 1.3.0 or update production sites.
