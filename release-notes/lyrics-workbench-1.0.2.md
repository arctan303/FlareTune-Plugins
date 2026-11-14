# Lyrics Workbench 1.0.2 / 歌词工作台 1.0.2

继承1.0.1的请求内读取复用和无效写入消除，并修复历史来源译文没有显式语言字段时的读取兼容。工作台直接复用宿主已有的来源语言契约，保留有效的旧酷狗等中文译文，不因缺少字段误报无译文或启动AI。只在返回时规范化语言，不重写原词、时间轴、译文或资产归属。

候选评分、来源顺序、主要语言判断和客户端接口不变；最低宿主能力仍为5、数据版本0。配合宿主歌词请求优化在dev验证；本开发版本不替代正式1.0.0记录，不部署生产站。

Includes request-local read reuse and avoids assessment-only writes from 1.0.1. Historical provider translations without an explicit language field now use the host's existing source-language contract. Valid legacy Chinese translations, including Kugou, remain available without unnecessary AI. Language is normalized only in the response; original lyrics, timing, translation bytes and stored provenance are preserved.

Candidate scoring, source order, predominant-language policy and consumer APIs remain unchanged. Minimum host capability is 5 and data version is 0. This development combination does not replace the stable 1.0.0 release or update production sites.
