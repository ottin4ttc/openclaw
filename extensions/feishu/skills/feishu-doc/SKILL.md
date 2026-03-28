---
name: feishu-doc
description: |
  Feishu document read/write operations. Activate when user mentions Feishu docs, cloud docs, or docx links.
---

# Feishu Document Tool

Single tool `feishu_doc` with action parameter for all document operations, including table creation for Docx.

## Content Format Decision Guide

**Choose the right action based on what you want to write:**

| Content type                                                                | Action to use                                                               |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Plain text, headings, bullet lists, code blocks, quotes, links, bold/italic | `write` / `append` / `insert` with markdown `content`                       |
| Table (any structured grid of rows and columns)                             | `create_table_with_values`                                                  |
| Table + text in same document                                               | First `append` text sections, then `create_table_with_values` for the table |

**Critical rule:** `write`, `append`, and `insert` actions do NOT support markdown table syntax (`| col | col |`). Passing a markdown table in `content` will silently render as plain text or be ignored. Always use `create_table_with_values` for tabular data.

## Token Extraction

From URL `https://xxx.feishu.cn/docx/ABC123def` → `doc_token` = `ABC123def`

## Actions

### Read Document

```json
{ "action": "read", "doc_token": "ABC123def" }
```

Returns: title, plain text content, block statistics. Check `hint` field - if present, structured content (tables, images) exists that requires `list_blocks`.

### Write Document (Replace All)

```json
{ "action": "write", "doc_token": "ABC123def", "content": "# Title\n\nMarkdown content..." }
```

Replaces entire document with markdown content. Supports: headings, lists, code blocks, quotes, links, images (`![](url)` auto-uploaded), bold/italic/strikethrough.

**⚠️ Markdown tables are NOT supported in write/append/insert.** If you need a table, use `create_table_with_values` instead (see below).

### Append Content

```json
{ "action": "append", "doc_token": "ABC123def", "content": "Additional content" }
```

Appends markdown to end of document.

**⚠️ Markdown tables are NOT supported.** Use `create_table_with_values` for tabular data.

### Insert Content After Block

```json
{
  "action": "insert",
  "doc_token": "ABC123def",
  "content": "## New Section\n\nContent here",
  "after_block_id": "doxcnXXX"
}
```

Inserts markdown content after the specified block. Use `list_blocks` to find block IDs.

### Create Document (Empty)

```json
{ "action": "create", "title": "New Document", "folder_token": "fldcnXXX" }
```

Creates an empty document. Optional `folder_token` and `grant_to_requester` (default: true).

### Create Document with Content (Atomic, Recommended)

```json
{
  "action": "create_and_write",
  "title": "Report Title",
  "content": "# Report\n\nContent here..."
}
```

Creates a new document and writes markdown content in one operation. Preferred over separate `create` + `write` calls. Optional: `folder_token`, `grant_to_requester` (default: true).

If write fails, returns `{ doc_token, url, write_error }` so you can retry the write separately.

### List Blocks

```json
{ "action": "list_blocks", "doc_token": "ABC123def" }
```

Returns full block data including tables, images. Use this to read structured content.

### Get Single Block

```json
{ "action": "get_block", "doc_token": "ABC123def", "block_id": "doxcnXXX" }
```

### Update Block Text

```json
{
  "action": "update_block",
  "doc_token": "ABC123def",
  "block_id": "doxcnXXX",
  "content": "New text"
}
```

### Delete Block

```json
{ "action": "delete_block", "doc_token": "ABC123def", "block_id": "doxcnXXX" }
```

### Create Table (Docx Table Block)

```json
{
  "action": "create_table",
  "doc_token": "ABC123def",
  "row_size": 2,
  "column_size": 2,
  "column_width": [200, 200]
}
```

Optional: `parent_block_id` to insert under a specific block.

### Write Table Cells

```json
{
  "action": "write_table_cells",
  "doc_token": "ABC123def",
  "table_block_id": "doxcnTABLE",
  "values": [
    ["A1", "B1"],
    ["A2", "B2"]
  ]
}
```

### Read Table Cells

```json
{
  "action": "read_table_cells",
  "doc_token": "ABC123def",
  "table_block_id": "doxcnTABLE"
}
```

Returns `{ values: [["A1", "B1"], ["A2", "B2"]], row_size: 2, column_size: 2, merge_info: [] }`. Use `list_blocks` to find the table's block ID first.

### Create Table With Values (One-step)

**Use this whenever you need a table — do NOT use markdown table syntax in write/append.**

```json
{
  "action": "create_table_with_values",
  "doc_token": "ABC123def",
  "row_size": 4,
  "column_size": 3,
  "column_width": [120, 300, 200],
  "values": [
    ["团队", "成员", "备注"],
    ["团队1", "Alice、Bob、Carol", ""],
    ["团队2", "Dave、Eve", ""],
    ["团队3", "Frank", "单人参赛"]
  ]
}
```

Rules:

- `row_size` must equal `values.length`
- `column_size` must equal `values[0].length`
- First row is typically the header row (no special header flag needed, just put headers in row 0)
- All cell values must be strings; use `""` for empty cells
- `column_width`: pixel widths per column; omit to use default widths

Optional: `parent_block_id` to insert under a specific block.

### Insert Table Row

```json
{
  "action": "insert_table_row",
  "doc_token": "ABC123def",
  "block_id": "doxcnTABLE",
  "row_index": -1
}
```

`row_index`: -1 = end (default), 0 = first.

### Insert Table Column

```json
{
  "action": "insert_table_column",
  "doc_token": "ABC123def",
  "block_id": "doxcnTABLE",
  "column_index": -1
}
```

`column_index`: -1 = end (default), 0 = first.

### Delete Table Rows

```json
{
  "action": "delete_table_rows",
  "doc_token": "ABC123def",
  "block_id": "doxcnTABLE",
  "row_start": 1,
  "row_count": 1
}
```

`row_start`: 0-based index. `row_count`: default 1.

### Delete Table Columns

```json
{
  "action": "delete_table_columns",
  "doc_token": "ABC123def",
  "block_id": "doxcnTABLE",
  "column_start": 1,
  "column_count": 1
}
```

### Merge Table Cells

```json
{
  "action": "merge_table_cells",
  "doc_token": "ABC123def",
  "block_id": "doxcnTABLE",
  "row_start": 0,
  "row_end": 2,
  "column_start": 0,
  "column_end": 2
}
```

Row/column end indices are exclusive.

### Upload Image to Docx (from URL or local file)

```json
{
  "action": "upload_image",
  "doc_token": "ABC123def",
  "url": "https://example.com/image.png"
}
```

Or local path with position control:

```json
{
  "action": "upload_image",
  "doc_token": "ABC123def",
  "file_path": "/tmp/image.png",
  "parent_block_id": "doxcnParent",
  "index": 5
}
```

Optional `index` (0-based) inserts at a specific position among siblings. Omit to append at end.

**Note:** Image display size is determined by the uploaded image's pixel dimensions. For small images (e.g. 480x270 GIFs), scale to 800px+ width before uploading to ensure proper display.

### Upload File Attachment to Docx (from URL or local file)

```json
{
  "action": "upload_file",
  "doc_token": "ABC123def",
  "url": "https://example.com/report.pdf"
}
```

Or local path:

```json
{
  "action": "upload_file",
  "doc_token": "ABC123def",
  "file_path": "/tmp/report.pdf",
  "filename": "Q1-report.pdf"
}
```

Rules:

- exactly one of `url` / `file_path`
- optional `filename` override
- optional `parent_block_id`

### Colored / Styled Text

```json
{
  "action": "color_text",
  "doc_token": "ABC123def",
  "block_id": "doxcnXXX",
  "content": "Revenue [green]+15%[/green] YoY"
}
```

Color tags: `[red]`, `[green]`, `[blue]`, `[orange]`, `[yellow]`, `[purple]`, `[grey]`, `[bold]`, `[bg:yellow]`.

## Comments

### List Document Comments

```json
{ "action": "list_comments", "doc_token": "ABC123def" }
```

With pagination:

```json
{ "action": "list_comments", "doc_token": "ABC123def", "page_size": 20, "page_token": "next_token" }
```

Returns: `{ comments: [...], page_token, has_more }`. Each comment includes `comment_id`, content, author, creation time, `is_whole` (true = whole-document, false = block-level).

### Get Single Comment

```json
{ "action": "get_comment", "doc_token": "ABC123def", "comment_id": "7xxx" }
```

### Create Document Comment

```json
{ "action": "create_comment", "doc_token": "ABC123def", "content": "Please review this section" }
```

Creates a whole-document comment. Returns `{ comment_id }`.

### List Comment Replies

```json
{ "action": "list_comment_replies", "doc_token": "ABC123def", "comment_id": "7xxx" }
```

With pagination: `page_size`, `page_token`. Returns: `{ replies: [...], page_token, has_more }`.

## Table Safety Rules

**CRITICAL: Never delete and recreate tables for modifications.** This destroys document structure.

### Safe Table Modification Workflow

1. **Read first**: Use `read_table_cells` to get current content
2. **Update cells**: Use `write_table_cells` to update specific cells
3. **Add/remove rows/columns**: Use `insert_table_row`, `delete_table_rows`, etc.
4. **Never**: `delete_block` + recreate for table edits

### Recommended Pattern

```json
// Step 1: Read current table state
{ "action": "read_table_cells", "doc_token": "ABC", "table_block_id": "tbl_xxx" }

// Step 2: Update only changed cells
{
  "action": "write_table_cells",
  "doc_token": "ABC",
  "table_block_id": "tbl_xxx",
  "values": [["updated", "values"]]
}
```

### Error Handling

If a table operation fails with error code 1770029 or similar:

- Do NOT escalate to delete+recreate
- Try smaller atomic operations (one row at a time)
- Check `list_blocks` to verify current table structure

## Reading Workflow

1. Start with `action: "read"` - get plain text + statistics
2. Check `block_types` in response for Table, Image, Code, etc.
3. If structured content exists, use `action: "list_blocks"` for full data

## Configuration

```yaml
channels:
  feishu:
    tools:
      doc: true # default: true
```

**Note:** `feishu_wiki` depends on this tool - wiki page content is read/written via `feishu_doc`.

## Permissions

Required: `docx:document`, `docx:document:readonly`, `docx:document.block:convert`, `drive:drive`

For comment operations:

- Read: `docx:document.comment:read`
- Write: `docx:document.comment`
