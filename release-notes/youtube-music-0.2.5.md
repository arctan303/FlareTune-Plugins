# YouTube Music 0.2.5

YT 歌词首次加载可能因重复的会话、安装与连接检查耗尽 Worker 调用预算，导致已有原词却返回失败，后台补译也可能留下过期 pending。本版在请求内复用已捕获的授权上下文，以原子数据库检查保持权限、安装 epoch 与连接 revision 实时有效，减少重复读取。

此更新配合歌词工作台 1.0.0 使用；最低宿主能力兼容编号仍为4，数据版本不变。有效原文、时间轴、连接凭据及模型配置保留。升级由站点管理员选择版本并按既有构建、激活流程应用。

首次、缓存命中和异步模型返回后的结算均纳入 Worker Free 50次预算回归；连接变化、会话失效、角色与安装变化不得允许迟到结果写入。客户端继续消费原有歌词接口。

First-time YT lyric loading could exhaust the Worker invocation budget through repeated session, installation and connection checks. This could fail a request despite cached originals and leave background translation pending. This update reuses the captured request authority and performs atomic live checks of permissions, installation epochs and connection revisions.

Use with Lyrics Workbench 1.0.0. Minimum host capability remains4; the data version is unchanged. Original lyrics, timing, connection credentials and model settings are preserved. Administrators apply the update through the existing selection, build and activation workflow.

Regression checks cover cold and warm reads, delayed model completion within the Free 50-call budget, and rejection of late writes after authorization or connection changes. Consumer clients keep the existing lyric API.
