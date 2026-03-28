import { Type, type Static } from "@sinclair/typebox";

export const FeishuDocSchema = Type.Object({
  action: Type.String({
    description:
      "Action to perform: read | write | append | insert | create | create_and_write | list_blocks | get_block | update_block | delete_block | delete_blocks | create_table | write_table_cells | create_table_with_values | read_table_cells | insert_table_row | insert_table_column | delete_table_rows | delete_table_columns | merge_table_cells | upload_image | upload_file | color_text | list_comments | get_comment | create_comment | list_comment_replies",
  }),
  doc_token: Type.Optional(
    Type.String({
      description: "Document token (required for most actions, extract from URL /docx/XXX)",
    }),
  ),
  content: Type.Optional(
    Type.String({
      description:
        "Markdown content (for write/append/insert/update_block/create_comment/create_and_write). IMPORTANT: Use proper markdown syntax for good formatting — # for h1, ## for h2, **bold**, - for bullets, 1. for numbered lists, --- for dividers, | for tables. Plain text without markdown syntax will render as ugly unformatted paragraphs.",
    }),
  ),
  title: Type.Optional(
    Type.String({ description: "Document title (for create/create_and_write)" }),
  ),
  folder_token: Type.Optional(
    Type.String({ description: "Target folder token (for create/create_and_write)" }),
  ),
  grant_to_requester: Type.Optional(
    Type.Boolean({
      description:
        "Grant edit permission to requesting user (for create/create_and_write, default: true)",
    }),
  ),
  block_id: Type.Optional(
    Type.String({
      description:
        "Block ID (for get_block/update_block/delete_block/color_text/insert_table_row/insert_table_column/delete_table_rows/delete_table_columns/merge_table_cells)",
    }),
  ),
  block_ids: Type.Optional(
    Type.Array(Type.String(), {
      description: "Array of block IDs to delete (for delete_blocks)",
    }),
  ),
  after_block_id: Type.Optional(
    Type.String({ description: "Insert content after this block ID (for insert action)" }),
  ),
  parent_block_id: Type.Optional(
    Type.String({
      description:
        "Parent block ID (for create_table/create_table_with_values/upload_image/upload_file)",
    }),
  ),
  row_size: Type.Optional(
    Type.Integer({
      description: "Table row count (for create_table/create_table_with_values)",
      minimum: 1,
    }),
  ),
  column_size: Type.Optional(
    Type.Integer({
      description: "Table column count (for create_table/create_table_with_values)",
      minimum: 1,
    }),
  ),
  column_width: Type.Optional(
    Type.Array(Type.Number({ minimum: 1 }), {
      description: "Column widths in px (for create_table/create_table_with_values)",
    }),
  ),
  table_block_id: Type.Optional(
    Type.String({ description: "Table block ID (for write_table_cells/read_table_cells)" }),
  ),
  values: Type.Optional(
    Type.Array(Type.Array(Type.String()), {
      description: "2D matrix values[row][col] (for write_table_cells/create_table_with_values)",
    }),
  ),
  row_index: Type.Optional(
    Type.Number({ description: "Row index to insert at (-1 for end, for insert_table_row)" }),
  ),
  column_index: Type.Optional(
    Type.Number({
      description: "Column index to insert at (-1 for end, for insert_table_column)",
    }),
  ),
  row_start: Type.Optional(
    Type.Number({
      description: "Start row index 0-based (for delete_table_rows/merge_table_cells)",
    }),
  ),
  row_count: Type.Optional(
    Type.Number({ description: "Number of rows to delete (for delete_table_rows, default: 1)" }),
  ),
  row_end: Type.Optional(
    Type.Number({ description: "End row index exclusive (for merge_table_cells)" }),
  ),
  column_start: Type.Optional(
    Type.Number({
      description: "Start column index 0-based (for delete_table_columns/merge_table_cells)",
    }),
  ),
  column_count: Type.Optional(
    Type.Number({
      description: "Number of columns to delete (for delete_table_columns, default: 1)",
    }),
  ),
  column_end: Type.Optional(
    Type.Number({ description: "End column index exclusive (for merge_table_cells)" }),
  ),
  url: Type.Optional(Type.String({ description: "Remote URL (for upload_image/upload_file)" })),
  file_path: Type.Optional(
    Type.String({ description: "Local file path (for upload_image/upload_file)" }),
  ),
  image: Type.Optional(
    Type.String({ description: "Image as data URI or base64 (for upload_image)" }),
  ),
  filename: Type.Optional(
    Type.String({ description: "Optional filename override (for upload_image/upload_file)" }),
  ),
  index: Type.Optional(
    Type.Integer({ minimum: 0, description: "Insert position 0-based (for upload_image)" }),
  ),
  comment_id: Type.Optional(
    Type.String({ description: "Comment ID (for get_comment/list_comment_replies)" }),
  ),
  page_size: Type.Optional(
    Type.Number({
      description: "Number of items per page (for list_comments/list_comment_replies, default: 50)",
    }),
  ),
  page_token: Type.Optional(
    Type.String({
      description: "Pagination token (for list_comments/list_comment_replies)",
    }),
  ),
});

export type FeishuDocParams = Static<typeof FeishuDocSchema>;
