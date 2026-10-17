// Wire contracts for the asset-upload Worker's purge routes
// (handlers in asset-upload-purge.ts) and the storage-cap error code.
//
// POST /purge       owner empties Recently deleted (all, or the given ids)
// POST /purge-chat  a member's deleted chat message files, removed for good

/** POST /purge body. No asset_ids = every file in Recently deleted. */
export interface PurgeRequest {
  workspace_id: string;
  asset_ids?: string[];
}

/** requested = rows asset_purge_request marked; removed = rows fully deleted from R2. */
export interface PurgeResponse {
  requested: number;
  removed: number;
  freedBytes: number;
}

/** POST /purge-chat body. Rows must already carry purge_requested_at. */
export interface PurgeChatRequest {
  workspace_id: string;
  asset_ids: string[];
}

export interface PurgeChatResponse {
  removed: number;
  freedBytes: number;
}

/** Codes these routes and the cap add, with their HTTP status. */
export const PURGE_ERROR_STATUS = {
  workspace_full: 413,
  owner_only: 403,
  not_member: 403,
} as const;

export type PurgeErrorCode = keyof typeof PURGE_ERROR_STATUS;

/** Error body shape, same as every other asset-upload error. */
export interface PurgeErrorBody {
  error: { code: PurgeErrorCode | 'bad_request' | 'unauthorized'; message: string };
}

/** Exact 413 body for an upload that does not fit. Never mentions the cap number. */
export const WORKSPACE_FULL_BODY = {
  error: { code: 'workspace_full', message: 'This workspace is full.' },
} as const;
