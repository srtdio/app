/**
 * The longest a folder name may be; mirrors the folders.name column limit
 * (folders_name_check: char_length(name) between 1 and 80). Shared by the
 * New folder and Rename folder sheets so the UI gate cannot drift from the DB.
 */
export const MAX_FOLDER_NAME = 80;
