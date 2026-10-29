# HTML artifacts

Interactive web pages made by AI agents can now be kept and read in EdgeEver as **HTML artifacts**. They live in a separate **Agent Artifacts** library with its own folders, open in a sandboxed reader on the web and desktop apps, and can be imported by file picker, drag-and-drop, the REST API or the MCP tools `create_html_artifact`, `list_artifacts` and `get_artifact`. Artifacts support replacing content with version history, image export, thumbnails, offline reading of opened pages, trash and restore, and cards in notes. They cannot be shared publicly. Android and iOS show a read-only fallback. See [HTML artifacts](../html-artifacts.md).

Migration `0073_artifact_library` adds the nullable `notebooks.system_kind` column and a partial unique index (one active library per workspace). It changes no existing rows, and the library is created on first use. EdgeEver ZIP backups now record which notebook is the library; older backups still restore.

Rolling back the code leaves the column unused. While an older server runs, older clients can overwrite an artifact's body, because only the new server refuses those saves (`artifact_update_required`). The real upgrade from the previous release was verified on local Cloudflare D1 and on the self-hosted Bun/SQLite runtime. The Docker image itself, older desktop, Android and iOS builds, and device runs were not verified.
