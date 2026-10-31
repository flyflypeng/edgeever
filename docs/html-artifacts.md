# HTML artifacts

[简体中文](html-artifacts.zh-CN.md)

An **HTML artifact** is a single interactive web page that an AI agent produced (a report, a dashboard, a slide deck, a small tool) and that you keep and read in EdgeEver. An artifact is a kind of note: it has a title, tags and a place in your workspace, it syncs and goes to the trash like any note, and it shows up in search. Its page cannot be edited word by word inside EdgeEver. You replace it as a whole with a newer HTML file, and earlier versions stay in the version history.

## Agent Artifacts (the Artifact Library)

Artifacts live in their own tree, **Agent Artifacts**, below the notebooks in the sidebar. Each workspace has exactly one. EdgeEver creates it the first time you open it or import an artifact, so opening it for the first time needs a connection.

- Group artifacts in **artifact folders**; folders can nest. Use **New artifact folder** on the library and **New subfolder** on a folder.
- You can rename the library, but you cannot delete or move it.
- The library and the notebooks are kept apart. Artifacts stay inside the library, ordinary notes cannot be moved into it, and notebooks and artifact folders cannot be moved across. A move that would cross the boundary is refused with "Can't move here".
- A folder can only be deleted when it holds no artifacts; empty subfolders are deleted with it.
- **All notes** leaves artifacts out. They still appear when you search, filter by tag, or open their folder, and the quick switcher marks them with a page icon.

## Importing

Import works on the web app and the desktop app, and needs a connection.

- Open **Agent Artifacts** (or one of its folders). The primary button becomes **Import HTML**; choose one or more `.html` or `.htm` files. Outside the library, the note type menu next to **New note** (**More**) has **Import HTML artifact**.
- Drag files onto the note list. Inside the library every file is imported as an artifact. Elsewhere, `.html`/`.htm` files go to the library root and other files take the normal Markdown import.
- Artifacts land in the selected folder, or in the library root.
- The title comes from the page's `<title>`, otherwise from the file name. You can change it later.
- Several files are imported one by one. A file that fails does not stop the others, and a summary lists each failure.

Pages are stored as a **single file**. Relative resources the page references (`./style.css`, `images/a.png`, `/app.js`) are not imported. EdgeEver lists them after the import ("missing local resources") so you know those parts may not display. Resources loaded from `https://…` addresses and inline `data:` URLs keep working, because the page can reach the internet.

## Reading

Selecting an artifact opens it in the reader in the third pane. The toolbar has:

- the title (edit it in place) and tags;
- **Reload**, **Full screen** (Esc leaves), **Export image**, **Download HTML** (the original file);
- **Replace content…** and **Version history**;
- **Move to trash**.

Links that open a new window (`target="_blank"`, `window.open`) open a new browser tab. On the web, a plain link loads inside the reader frame; **Reload** brings the artifact back. In the desktop app every external link opens in your system browser and the artifact stays in place. Downloads the page starts work as usual.

**Export image** captures the whole page as one long image or only the visible area, as PNG, JPEG or WebP. If the page shows cross-origin images or embedded pages that do not allow CORS access, the capture would miss them, so no image is created and EdgeEver tells you why. Export the visible area or fix the page in that case.

### Cards and thumbnails

In the list, an artifact shows as a card with a thumbnail of its first screen. The web or desktop app that has the list open renders thumbnails it is missing in a hidden, sandboxed frame and uploads them, up to two at a time. A page that cannot be captured keeps the placeholder.

### Offline

Every page you have opened (and every page a thumbnail was rendered from) is cached on that device and opens offline later. A page that was never opened on this device needs a connection; EdgeEver says so instead of showing a blank frame. Import, replace and version restore always need a connection.

## Changing an artifact

- **Title, tags, location**: edit them in the reader or the list, as for any note. Moves are limited to the library.
- **Replace content…**: pick a new HTML file (same limits as import). The previous version is kept automatically. The thumbnail refreshes on its own.
- **Version history**: compare the text of earlier versions and restore one. Restoring brings back that version's page.
- The body itself cannot be edited, by people or by tools. A save that tries to change it is refused with `artifact_update_required` (HTTP 409), and the artifact stays as it was.

## Linking artifacts from notes

- In a note, type `/card` (**Artifact card**) to insert a card that shows the artifact's title and thumbnail. Clicking it opens the artifact.
- `@` mentions and the note-link picker also list artifacts, marked with a page icon.
- A card is stored as an ordinary paragraph holding one note link. Apps without card support show it as a plain link and keep it when they save. A card whose artifact was trashed or deleted shows "Artifact unavailable".

## Trash, restore and delete

Moving an artifact to the trash, restoring it and deleting it forever work like they do for notes. Restored artifacts go back to their folder. If that folder no longer exists, they go to the library root. Deleting forever removes every stored version and thumbnail.

## Sharing

Artifacts cannot be shared publicly. Note sharing is not offered for artifacts, the library and its folders cannot be shared, and public notebook sites never include artifacts.

## MCP tools

Agents connected through Remote MCP (**Profile → API / MCP**) or the local MCP server can manage artifacts with three tools. The built-in assistant does not offer them.

| Tool | Scopes | What it does |
| --- | --- | --- |
| `create_html_artifact` | `write:memos`, `write:resources`; `write:notebooks` only when the library or a folder has to be created | Saves one HTML page as an artifact |
| `list_artifacts` | `read:memos`, `read:resources` | Lists artifacts in a folder and its subfolders |
| `get_artifact` | `read:memos`, `read:resources` | Returns one artifact's details, and the HTML on request |

`create_html_artifact` arguments:

- `title` (1–160 characters) and `html` (the whole page as a string, at most 20 MB in UTF-8).
- `folderPath` (optional): a path relative to the library, such as `Reports/2026`. Missing folders are created; names match case-insensitively; each segment is at most 80 characters; empty, `.` and `..` segments are refused.
- `tags` (optional).
- `thumbnailBase64` and `thumbnailMimeType` (optional, together): a PNG, JPEG or WebP image used as the card thumbnail. Without one, a web or desktop app renders the thumbnail later.
- `source` and `externalId` (optional, together): a stable identity for idempotent imports.
  - Calling again with the same pair and the same HTML returns `unchanged`.
  - Calling with different HTML replaces the content, keeps the previous version and returns `replaced`.
  - If the earlier artifact was deleted, a new one is created.
  - Without the pair, every call creates a new artifact.

The result has `status` (`created`, `replaced` or `unchanged`) and the artifact's `id`, `title`, `folderPath`, `tags`, `thumbnailPending` and `missingLocalAssets`.

`list_artifacts` takes `folderPath`, `q`, `tag` and `limit` (at most 100). `get_artifact` takes `id` and `includeHtml`.

The general note tools keep working on artifacts for metadata: `update_memo` can change the title, tags and folder but not the body, `move_memos`, `trash_memos`, `restore_memos` and `restore_memo_revision` work as usual. `list_memos` without a notebook leaves artifacts out; `search_memos` without a query, tag or notebook does too.

Errors agents may see:

| Code | Meaning |
| --- | --- |
| `artifact_too_large` (413) | The HTML is larger than 20 MB |
| `artifact_invalid_html` (400) | Empty or non-UTF-8 HTML |
| `artifact_update_required` (409) | A body change was attempted through a note tool |
| `artifact_location_invalid` (400) | A move across the library boundary |
| `artifact_share_unsupported` (400) | Sharing an artifact, the library or a library folder |
| `import_source_conflict` (409) | The `source`/`externalId` pair already belongs to an ordinary note |

The REST API has the same operations for scripts: `POST /api/v1/artifacts` (multipart `file`, optional `folderId`, `title`, `tags` as a JSON array, `thumbnail`), `PUT /api/v1/artifacts/{id}/content` (multipart `file`, optional `expectedRevision`, `thumbnail`) and `POST /api/v1/artifact-library`.

## Safety

Artifacts often come from agents or other people, so EdgeEver treats every page as untrusted.

- The page runs in a sandboxed frame loaded through `srcdoc`, with only `allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads`. It runs as an opaque origin: its scripts cannot read EdgeEver's cookies, local storage, login session, the app's page or your notes. It cannot navigate the EdgeEver window, and it gets no camera, microphone or location access. The frame may only request full screen.
- The server always sends stored HTML as a download (`Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`), so a browser never renders it under the EdgeEver origin.
- The page **can** use the internet: it can load scripts and images from CDNs, and send requests to any site that accepts them. Do not import pages you would not open in a browser, and do not type secrets into them.
- In the desktop app, links the page opens go to your system browser, and the page can never replace the app window.
- Thumbnails and image export run in the same sandbox and talk to the app only through a private message channel that checks the sender.

## Mobile apps and older versions

- **Android and iOS** show artifacts read-only: the thumbnail, a short text excerpt and a note to open the artifact on the web or desktop. You can move artifacts between library folders (and change their tags on Android). The page itself is not rendered, and artifacts cannot be imported there.
- **Older EdgeEver apps** (released before HTML artifacts) connected to an updated server show the library as an ordinary notebook and an artifact as a note with its fallback text; the older web app also shows the hidden envelope as a long comment line. If you edit that text there, the server refuses the save, so the artifact is never damaged. The older web app then keeps showing its unsent edit as "Queued" and the server keeps refusing it. Update the app to read artifacts.
- **Server upgrade**: the database gains one optional column (migration `0084_artifact_library`). Existing notebooks and notes are not changed, and the library is only created when first used. An older server ignores the column, but it does not have the protection above, so while an older server is running, older apps could overwrite an artifact's body.

## Backup

EdgeEver ZIP backups (**Profile → Import & Export → Export EdgeEver ZIP**) include artifacts, their HTML and thumbnails, and since this release which notebook is the library.

- Restoring into a workspace that already has a library places the backup's library inside it as a folder.
- Backups made before this release do not mark the library. Restored into the workspace they came from, the library stays the library. Restored anywhere else, their artifacts go to the library root, and the old library and its folders come back as ordinary, empty notebooks that you can delete.

## Limits

| Item | Limit |
| --- | --- |
| HTML file size | 20 MB per page (UTF-8) |
| File types | `.html`, `.htm`, UTF-8, not empty |
| Title | 160 characters |
| Folder name in `folderPath` | 80 characters per segment |
| Thumbnail | PNG, JPEG or WebP; generated thumbnails are 480 px wide |
| Missing local resources reported | first 50 |
| `list_artifacts` page | 100 |

Known limitations:

- `#section` links inside a page do not scroll to the section.
- A page's own relative resources must be inlined or hosted online before import.
- Artifacts are never in the inbox and never on public notebook sites.
