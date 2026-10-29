# HTML 制品

AI Agent 生成的交互网页现在可以作为 **HTML 制品**保存在 EdgeEver 中阅读。制品放在独立的「Agent 制品」库中，有自己的文件夹，在 Web 端和桌面端的沙箱阅读器里打开；可以通过文件选择、拖拽、REST API 或 MCP 工具 `create_html_artifact`、`list_artifacts`、`get_artifact` 导入。制品支持替换内容与版本历史、导出图片、缩略图、离线阅读已打开过的网页、回收站与恢复，以及在笔记中插入制品卡片；制品不能公开分享。Android 和 iOS 以只读方式降级显示。详见 [HTML 制品](../html-artifacts.zh-CN.md)。

Migration `0073_artifact_library` 新增可空列 `notebooks.system_kind` 和一个部分唯一索引（每个工作区只有一个有效的制品库），不修改任何已有数据，制品库在第一次使用时才创建。EdgeEver ZIP 备份现在会记录哪个笔记本是制品库，旧备份仍可恢复。

回滚代码后，这一列不再被使用。旧版服务端运行期间，旧版客户端可以覆盖制品正文，因为只有新版服务端会拒绝这类保存（`artifact_update_required`）。已在本地 Cloudflare D1 和自托管 Bun/SQLite 运行时上验证从上一版本到本版本的真实升级；Docker 镜像本身、旧版桌面端、Android 和 iOS 客户端以及真机均未验证。
