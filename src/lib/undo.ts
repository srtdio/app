/**
 * How long every Undo strip stays up before its delete or move commits. The one
 * undo window in the app: posts, briefs, files, plans, tasks and stage moves all
 * read it, so no surface keeps its own timer length.
 */
export const UNDO_MS = 4000;
