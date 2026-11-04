# Hierarchical Tags Guide

[简体中文](hierarchical-tags.md) | [English](hierarchical-tags.en-US.md)

A tag uses `/` to separate levels. Writing a tag such as `#reading/fiction/scifi` creates the three levels "reading → fiction → scifi", keeping the flexibility of tags and the structure of folders at the same time.

### Where to browse

The "Tags" section sits below "Agent Artifacts" in the first column, where every tag in the workspace forms one collapsible tree.

- Both the section header and every tag with children can be collapsed, and the expanded state is remembered.
- The number on a node counts the notes carrying that tag or any tag below it, counting each note once.
- Spellings that differ only in letter case or whitespace form one node, so `Topic/Kernel` and `topic/kernel` merge.
- Levels are sorted by name, numbers in natural order, and a leading emoji does not affect sorting.
- When a level starts with an emoji, that emoji becomes the node icon.

### Filtering by tag

Click any node and the second column lists the notes and Agent Artifacts carrying that tag or any tag below it, across the whole workspace. Clicking a tag on a note card switches the filter as well, and expands and scrolls the tree to the matching node.

### Renaming and moving

Open the "···" menu or the right-click menu on a node and choose "Rename". The dialog shows the full path:

- Changing the name renames the tag, for example `reading` to `books`.
- Changing the path moves it, for example `reading/fiction` to `books/fiction`, and every tag below it moves along.
- When the target path already exists, a confirmation appears before merging.
- Type an emoji straight into the field, for example `📚reading`.

### Removing a tag

"Remove tag" drops the node and every tag below it from the notes that carry them; the notes themselves stay. The number of affected notes is shown before it runs.

### Writing conventions

- Tags live on notes, so there is no empty tag apart from a note.
- Paths are tidied on save: `a / b`, `a//b`, and `/a/` are stored as `a/b`, `a/b`, and `a`.
- Levels only affect browsing and filtering. The Android and iOS clients still show and filter by the full tag name.
