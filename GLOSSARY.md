# EdgeEver

EdgeEver is an open-source, multi-device note app for individuals and teams. Content is organized by workspaces and notebooks, with both a three-pane layout and Jot as ways of working.

## Organization

**Workspace**:
The outermost space that owns notes and notebooks; members collaborate within one workspace.
_Avoid_: Space, team, account

**Notebook**:
A container that organizes notes inside a workspace; notebooks can nest without limit.
_Avoid_: Folder, category, directory

**Inbox**:
The single, undeletable default notebook of each workspace, where new notes without an explicit notebook land until they are organized. Users may rename it (e.g. "Unsorted", "Collection box").
_Avoid_: Default notebook, uncategorized

## Content

**Memo (Note)**:
The only content unit in EdgeEver, with an optional title, body, tags, and resources; called memo in code and note in the UI. Every card in Jot is a memo; there is no separate "short memo" entity.
_Avoid_: Short card, flash note, entry

**Card**:
How a memo is presented in Jot; not a data entity.
_Avoid_: Treating a card as an object separate from its memo

## Views and actions

**Jot**:
The view that shows Inbox memos as a card stream in reverse creation order, with a quick-capture box on top. "Jot" names the view, not a memo type; a memo moved out of the Inbox stays the same memo and simply leaves Jot.
_Avoid_: A jot, timeline, stream

**Triage**:
Moving a memo from the Inbox into another notebook; triaged memos leave Jot.
_Avoid_: Archive, categorize

**Review**:
The view that resurfaces older memos from the whole workspace, either "on this day" or at random.
_Avoid_: Revision, time travel
