// Envelope derivation: the columns of an inbox entry that are the same for
// every recipient of a given source change (workspace, linked entity, scope,
// payload) plus the source ref used to build the idempotency key. Returns null
// when the change is not a fan-out trigger, so the worker has a single place to
// short-circuit non-events.

import { briefClosed, isActionable, resolvedFlipped, stageChanged } from './transitions';
import type { ChangeEvent, Envelope } from './types';

export function buildEnvelope(event: ChangeEvent): Envelope | null {
  if (!isActionable(event)) return null;

  switch (event.table) {
    case 'comments': {
      const c = event.row;
      // INSERT and the open->resolved flip share the same linked entity.
      if (event.type === 'UPDATE' && !resolvedFlipped(event)) return null;
      // entity_type is generated as `string`; runtime values are 'post'|'brief'.
      const entityType = c.entity_type as 'post' | 'brief';
      return {
        workspaceId: c.workspace_id,
        entityType,
        entityId: c.entity_id,
        scope: entityType === 'post' ? 'posts' : 'briefs',
        scopeKey: null,
        payload: {
          comment_id: c.id,
          entity_type: c.entity_type,
          entity_id: c.entity_id,
          author_user_id: c.author_user_id,
          resolved: event.type === 'UPDATE',
        },
        sourceTable: 'comments',
        sourceId: c.id,
      };
    }

    case 'posts': {
      if (!stageChanged(event)) return null;
      const p = event.row;
      return {
        workspaceId: p.workspace_id,
        entityType: 'post',
        entityId: p.id,
        scope: 'posts',
        scopeKey: null,
        payload: { post_id: p.id, from_stage: event.old.stage ?? null, to_stage: p.stage },
        sourceTable: 'posts',
        sourceId: p.id,
      };
    }

    case 'briefs': {
      if (event.type === 'UPDATE' && !briefClosed(event)) return null;
      const b = event.row;
      return {
        workspaceId: b.workspace_id,
        entityType: 'brief',
        entityId: b.id,
        scope: 'briefs',
        scopeKey: null,
        payload: { brief_id: b.id, title: b.title, created_by: b.created_by },
        sourceTable: 'briefs',
        sourceId: b.id,
      };
    }

    case 'assets': {
      const a = event.row;
      return {
        workspaceId: a.workspace_id,
        entityType: 'workspace',
        entityId: a.workspace_id,
        scope: 'everything',
        scopeKey: null,
        payload: { asset_id: a.id, filename: a.filename },
        sourceTable: 'assets',
        sourceId: a.id,
      };
    }

    case 'asset_versions': {
      const v = event.row;
      return {
        workspaceId: v.workspace_id,
        entityType: 'workspace',
        entityId: v.workspace_id,
        scope: 'everything',
        scopeKey: null,
        payload: { asset_id: v.asset_id, asset_version_id: v.id, version_number: v.version_number },
        sourceTable: 'asset_versions',
        sourceId: v.id,
      };
    }

    case 'workspace_members': {
      const m = event.row;
      return {
        workspaceId: m.workspace_id,
        entityType: 'workspace',
        entityId: m.workspace_id,
        scope: 'people',
        scopeKey: null,
        payload: { member_id: m.id, role: m.role, invited_by: m.invited_by },
        sourceTable: 'workspace_members',
        sourceId: m.id,
      };
    }
  }
}
