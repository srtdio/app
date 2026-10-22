// Installs the harness network: a fake signed-in Supabase session in
// localStorage, the fixture PostgREST for https://harness.supabase.test, the
// chat-token and asset-read .test hosts, and a hard block on every other
// non-localhost request. Nothing leaves the machine.

import { deflateSync } from 'node:zlib';
import type { Page, Route } from '@playwright/test';
import { answerRest, type Row, type Tables } from './postgrest';
import {
  buildWorld,
  ME,
  REFUSED_SEND,
  threadRootOf,
  WORKSPACE_ID,
  type ChatWorld,
} from './chat-data';
import { notesChannelRow } from './notes-data';
import { TASK_RPC } from './tasks-data';
import { INDUCTION_RPC } from './induction-rpc';
import { SEARCH_RPC } from './search-data';

const SUPABASE_HOST = 'harness.supabase.test';
const CHAT_TOKEN_HOST = 'chat-token.harness.test';
const ASSET_READ_HOST = 'asset-read.harness.test';
const ASSET_UPLOAD_HOST = 'asset-upload.harness.test';

function base64url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function fakeSession(): string {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const user = {
    id: ME,
    aud: 'authenticated',
    role: 'authenticated',
    email: 'sam@harness.test',
    app_metadata: { provider: 'email' },
    user_metadata: {},
    created_at: '2026-01-01T00:00:00Z',
  };
  const accessToken = [
    base64url({ alg: 'HS256', typ: 'JWT' }),
    base64url({ sub: ME, exp, role: 'authenticated', aud: 'authenticated', email: user.email }),
    'harness',
  ].join('.');
  return JSON.stringify({
    access_token: accessToken,
    refresh_token: 'harness-refresh',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: exp,
    user,
  });
}

// CRC32 for the PNG chunks below.
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/**
 * A small valid PDF of `pages` US Letter pages (a filled box on each), the
 * bytes the asset-read stream mode serves for the file viewer.
 */
export function fixturePdf(pages: number): Buffer {
  const objects: string[] = ['<< /Type /Catalog /Pages 2 0 R >>', ''];
  const kids: string[] = [];
  for (let i = 0; i < pages; i += 1) {
    const pageId = objects.length + 1;
    kids.push(`${pageId} 0 R`);
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${pageId + 1} 0 R >>`,
    );
    const stream = `0.2 0.4 0.8 rg 72 ${500 - i * 40} 468 200 re f`;
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages} >>`;
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** Pages in the PDF the stream mode serves. */
export const FIXTURE_PDF_PAGES = 3;

/** A solid-colour PNG so photo tiles have real pixels without any network. */
export function solidPng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const rowBytes = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x += 1) {
    rowBytes[1 + x * 3] = rgb[0];
    rowBytes[2 + x * 3] = rgb[1];
    rowBytes[3 + x * 3] = rgb[2];
  }
  const raw = Buffer.concat(Array.from({ length: height }, () => rowBytes));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function silentWav(): Buffer {
  const samples = 8000;
  const buffer = Buffer.alloc(44 + samples);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + samples, 4);
  buffer.write('WAVEfmt ', 8, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(8000, 24);
  buffer.writeUInt32LE(8000, 28);
  buffer.writeUInt16LE(1, 32);
  buffer.writeUInt16LE(8, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(samples, 40);
  buffer.fill(128, 44);
  return buffer;
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET, POST, PATCH, DELETE, HEAD, OPTIONS',
  'access-control-expose-headers': 'content-range',
};

type RpcHandler = (args: Record<string, unknown>, tables: Tables) => unknown;

/** A proc that raised: the route answers 400 with this message (PostgREST's shape). */
class HarnessRpcError extends Error {}

/** The active members of a chat (DM pair or group members), as user ids. */
function channelMemberIds(tables: Tables, channelId: string): string[] {
  const channel = (tables.chat_channels ?? []).find((c) => c.channel_id === channelId);
  if (channel === undefined) return [];
  if (channel.channel_type === 'dm') return [String(channel.dm_user_a), String(channel.dm_user_b)];
  if (channel.channel_type === 'group') {
    return (tables.group_members ?? [])
      .filter((m) => m.group_id === channel.entity_id)
      .map((m) => String(m.user_id));
  }
  return [ME];
}

function roleOf(tables: Tables, userId: string): string {
  return String(
    (tables.workspace_members ?? []).find((m) => m.user_id === userId && m.active === true)?.role ??
      '',
  );
}

/** The agency-side roles (is_agency_side_member). */
const AGENCY_ROLES = ['owner', 'admin', 'agency'];

function planItemsOf(tables: Tables, planId: unknown): Row[] {
  return (tables.plan_items ?? []).filter((i) => i.plan_id === planId && i.deleted_at === null);
}

function inPlan(plan: Row | undefined, day: string): boolean {
  return plan !== undefined && day >= String(plan.starts_on) && day <= String(plan.ends_on);
}

/** The plan procs over the fixture tables (owner/agency writes; RLS is not emulated). */
const PLAN_RPC: Record<string, RpcHandler> = {
  plan_create: (args, tables) => {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    (tables.plans ??= []).push({
      id,
      workspace_id: args.p_workspace_id,
      title: args.p_title,
      starts_on: args.p_starts_on,
      ends_on: args.p_ends_on,
      audience: args.p_audience,
      shared_with_client_at: args.p_audience === 'client' ? now : null,
      shared_with_client_by: args.p_audience === 'client' ? ME : null,
      created_by: ME,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    });
    return id;
  },
  // One transaction: a Draft plan, its concepts in order, then its posts (each
  // post's target_date: a plan day, or null to clear it). Everything is checked
  // before any write, so a refusal saves nothing.
  plan_create_with_items: (args, tables) => {
    if (roleOf(tables, ME) === 'client') throw new HarnessRpcError('forbidden_role');
    const concepts = Array.isArray(args.p_concepts) ? (args.p_concepts as Row[]) : [];
    const posts = Array.isArray(args.p_posts) ? (args.p_posts as Row[]) : [];
    if (concepts.length > 50 || posts.length > 50) throw new HarnessRpcError('invalid_payload');
    const range = { starts_on: args.p_starts_on, ends_on: args.p_ends_on } as Row;
    const seen = new Set<unknown>();
    for (const p of posts) {
      if (seen.has(p.post_id)) throw new HarnessRpcError('invalid_payload');
      seen.add(p.post_id);
      if (!(tables.posts ?? []).some((x) => x.id === p.post_id)) {
        throw new HarnessRpcError('invalid_payload');
      }
      if (typeof p.target_date === 'string' && !inPlan(range, p.target_date)) {
        throw new HarnessRpcError('date_outside_plan');
      }
    }
    for (const c of concepts) {
      if (typeof c.target_date === 'string' && !inPlan(range, c.target_date)) {
        throw new HarnessRpcError('date_outside_plan');
      }
    }
    const planId = PLAN_RPC.plan_create?.({ ...args, p_audience: 'team' }, tables);
    for (const c of concepts) {
      PLAN_RPC.plan_concept_add?.(
        {
          p_plan_id: planId,
          p_title: c.title,
          p_description: c.description,
          p_attachment_version_ids: c.attachment_version_ids,
          p_target_date: c.target_date ?? null,
        },
        tables,
      );
    }
    for (const p of posts) {
      PLAN_RPC.plan_posts_add?.({ p_plan_id: planId, p_post_ids: [p.post_id] }, tables);
      const post = (tables.posts ?? []).find((x) => x.id === p.post_id);
      if (post !== undefined) {
        post.target_date = typeof p.target_date === 'string' ? `${p.target_date}T12:00:00Z` : null;
      }
    }
    return planId;
  },
  plan_update: (args, tables) => {
    const plan = (tables.plans ?? []).find((p) => p.id === args.p_plan_id);
    if (plan !== undefined) {
      plan.title = args.p_title;
      plan.starts_on = args.p_starts_on;
      plan.ends_on = args.p_ends_on;
    }
    return null;
  },
  plan_share_with_client: (args, tables) => {
    const plan = (tables.plans ?? []).find((p) => p.id === args.p_plan_id);
    if (plan === undefined) throw new HarnessRpcError('plan not available');
    // Agency side only; drafts never block it; one-way and idempotent.
    if (roleOf(tables, ME) === 'client') throw new HarnessRpcError('forbidden_role');
    if (plan.audience === 'client') return null;
    plan.audience = 'client';
    plan.shared_with_client_at = new Date().toISOString();
    plan.shared_with_client_by = ME;
    return null;
  },
  // The draft post items of up to 100 plans the caller may see by name, each
  // with its post's target_date (part 2b): a client gets them on client plans only. Items a client cannot read from
  // plan_items sit in hidden_plan_items (the fixture's stand-in for RLS).
  plan_draft_rows: (args, tables) => {
    const ids = new Set(Array.isArray(args.p_plan_ids) ? args.p_plan_ids.map(String) : []);
    const client = roleOf(tables, ME) === 'client';
    const items = [...(tables.plan_items ?? []), ...(tables.hidden_plan_items ?? [])];
    return items.flatMap((i) => {
      if (i.kind !== 'post' || i.deleted_at !== null || !ids.has(String(i.plan_id))) return [];
      const plan = (tables.plans ?? []).find((p) => p.id === i.plan_id && p.deleted_at === null);
      if (plan === undefined || (client && plan.audience !== 'client')) return [];
      const post = (tables.posts ?? []).find((p) => p.id === i.post_id);
      if (post === undefined || post.stage !== 'draft') return [];
      return [
        {
          plan_id: i.plan_id,
          item_id: i.id,
          item_position: i.position,
          post_number: post.number,
          title: post.title,
          // The post's own target_date (20261012190000_plan_part_2b).
          target_date: post.target_date ?? null,
        },
      ];
    });
  },
  // The creator or an owner/admin only (forbidden_role otherwise); RLS hides
  // a deleted plan, so the fixture drops the row.
  plan_delete: (args, tables) => {
    const plans = tables.plans ?? [];
    const at = plans.findIndex((p) => p.id === args.p_plan_id);
    if (at < 0) return null;
    const role = roleOf(tables, ME);
    if (plans[at]?.created_by !== ME && role !== 'owner' && role !== 'admin') {
      throw new HarnessRpcError('forbidden_role');
    }
    plans.splice(at, 1);
    return null;
  },
  plan_concept_add: (args, tables) => {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    (tables.plan_items ??= []).push({
      id,
      workspace_id: WORKSPACE_ID,
      plan_id: args.p_plan_id,
      kind: 'concept',
      position: planItemsOf(tables, args.p_plan_id).length,
      title: args.p_title,
      description: args.p_description === '' ? null : args.p_description,
      post_id: null,
      target_date: args.p_target_date ?? null,
      created_by: ME,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    });
    const versions = Array.isArray(args.p_attachment_version_ids)
      ? args.p_attachment_version_ids
      : [];
    versions.forEach((versionId, position) =>
      (tables.asset_attachments ??= []).push({
        id: crypto.randomUUID(),
        asset_id: versionId,
        asset_version_id: versionId,
        entity_type: 'plan_item',
        entity_id: id,
        workspace_id: WORKSPACE_ID,
        position,
        attached_by: ME,
        attached_at: now,
        deleted_at: null,
      }),
    );
    return id;
  },
  plan_concept_edit: (args, tables) => {
    // Agency side only, like the proc.
    if (roleOf(tables, ME) === 'client') throw new HarnessRpcError('forbidden_role');
    const item = (tables.plan_items ?? []).find((i) => i.id === args.p_item_id);
    if (item !== undefined) {
      item.title = args.p_title;
      item.description = args.p_description;
      // The proc always writes the date (null clears) and resets both reviews.
      item.target_date = args.p_target_date ?? null;
      for (const r of tables.plan_item_reviews ?? []) {
        if (r.item_id === item.id) r.status = 'waiting';
      }
      // Files: null keeps every link; an array soft-deletes and re-attaches them all.
      if (Array.isArray(args.p_attachment_version_ids)) {
        const now = new Date().toISOString();
        const links = (tables.asset_attachments ??= []);
        for (const a of links) {
          if (a.entity_type === 'plan_item' && a.entity_id === item.id && a.deleted_at === null) {
            a.deleted_at = now;
          }
        }
        args.p_attachment_version_ids.forEach((versionId, position) =>
          links.push({
            id: crypto.randomUUID(),
            asset_id: versionId,
            asset_version_id: versionId,
            entity_type: 'plan_item',
            entity_id: item.id,
            workspace_id: WORKSPACE_ID,
            position,
            attached_by: ME,
            attached_at: now,
            deleted_at: null,
          }),
        );
      }
    }
    return null;
  },
  // Mirrors the 2b proc: agency only; p_target_date given = that day (inside
  // the plan, else date_outside_plan) written onto each added post (12:00 in
  // the fixture's UTC workspace); null = the post keeps its own date. The slot
  // never carries a day (plan_items_target_date_concept_only).
  plan_posts_add: (args, tables) => {
    if (roleOf(tables, ME) === 'client') throw new HarnessRpcError('forbidden_role');
    const ids = Array.isArray(args.p_post_ids) ? args.p_post_ids : [];
    const held = new Set(planItemsOf(tables, args.p_plan_id).map((i) => i.post_id));
    const plan = (tables.plans ?? []).find((p) => p.id === args.p_plan_id);
    const given = typeof args.p_target_date === 'string' ? args.p_target_date : null;
    if (given !== null && !inPlan(plan, given)) throw new HarnessRpcError('date_outside_plan');
    let added = 0;
    for (const postId of ids) {
      if (held.has(postId)) continue;
      const now = new Date().toISOString();
      (tables.plan_items ??= []).push({
        id: crypto.randomUUID(),
        workspace_id: WORKSPACE_ID,
        plan_id: args.p_plan_id,
        kind: 'post',
        position: planItemsOf(tables, args.p_plan_id).length,
        title: null,
        description: null,
        post_id: postId,
        target_date: null,
        created_by: ME,
        created_at: now,
        updated_at: now,
        deleted_at: null,
      });
      if (given !== null) {
        const post = (tables.posts ?? []).find((p) => p.id === postId);
        if (post !== undefined) post.target_date = `${given}T12:00:00Z`;
      }
      held.add(postId);
      added += 1;
    }
    return added;
  },
  // RLS hides a removed item: the fixture drops the row.
  plan_item_remove: (args, tables) => {
    const items = tables.plan_items ?? [];
    const at = items.findIndex((i) => i.id === args.p_item_id);
    if (at >= 0) items.splice(at, 1);
    return null;
  },
  // Mirrors the live 5-arg proc: agency only; a day inside the plan or null
  // (else date_outside_plan); p_item_ids is the full plan order after the
  // move. A post slot's day is its post's target_date (12:00 in the fixture's
  // UTC workspace), a concept's plan_items.target_date. A day change resets
  // both slot reviews to waiting unless p_keep_reviews; same day only reorders.
  plan_item_move: (args, tables) => {
    if (roleOf(tables, ME) === 'client') throw new HarnessRpcError('forbidden_role');
    const item = (tables.plan_items ?? []).find(
      (i) => i.id === args.p_item_id && i.deleted_at === null,
    );
    if (item === undefined) throw new HarnessRpcError('plan_item_not_found');
    const plan = (tables.plans ?? []).find((p) => p.id === item.plan_id);
    const day = typeof args.p_target_date === 'string' ? args.p_target_date : null;
    if (day !== null && !inPlan(plan, day)) throw new HarnessRpcError('date_outside_plan');
    if (typeof args.p_keep_reviews !== 'boolean') throw new HarnessRpcError('invalid_payload');
    const post =
      item.kind === 'post' ? (tables.posts ?? []).find((p) => p.id === item.post_id) : undefined;
    const current =
      item.kind === 'post'
        ? post?.target_date == null
          ? null
          : String(post.target_date).slice(0, 10)
        : (item.target_date ?? null);
    if (current !== day) {
      if (post !== undefined) post.target_date = day === null ? null : `${day}T12:00:00Z`;
      else item.target_date = day;
      if (args.p_keep_reviews !== true) {
        for (const r of tables.plan_item_reviews ?? []) {
          if (r.item_id === item.id) r.status = 'waiting';
        }
      }
    }
    const order = Array.isArray(args.p_item_ids) ? args.p_item_ids : [];
    order.forEach((id, position) => {
      const row = planItemsOf(tables, item.plan_id).find((i) => i.id === id);
      if (row !== undefined) row.position = position;
    });
    return null;
  },
  plan_items_reorder: (args, tables) => {
    const ids = Array.isArray(args.p_item_ids) ? args.p_item_ids : [];
    ids.forEach((id, position) => {
      const item = (tables.plan_items ?? []).find((i) => i.id === id);
      if (item !== undefined) item.position = position;
    });
    return null;
  },
  // Mirrors the live proc (20261019030000_plan_save): the Plan screen's Save
  // changes, one call with the queued ops in order. Agency only; 1 to 200 ops;
  // each op runs the matching proc (update -> plan_update, remove ->
  // plan_item_remove, move -> plan_item_move with keep_reviews defaulting to
  // true, reorder -> plan_items_reorder); any other op is invalid_payload.
  plan_save: (args, tables) => {
    if (roleOf(tables, ME) === 'client') throw new HarnessRpcError('forbidden_role');
    const plan = (tables.plans ?? []).find((p) => p.id === args.p_plan_id && p.deleted_at === null);
    if (plan === undefined) throw new HarnessRpcError('plan_not_found');
    const ops = Array.isArray(args.p_ops) ? (args.p_ops as Row[]) : null;
    if (ops === null || ops.length < 1 || ops.length > 200) {
      throw new HarnessRpcError('invalid_payload');
    }
    for (const op of ops) {
      if (op.op === 'update') {
        PLAN_RPC.plan_update?.(
          {
            p_plan_id: args.p_plan_id,
            p_title: op.title,
            p_starts_on: op.starts_on,
            p_ends_on: op.ends_on,
          },
          tables,
        );
      } else if (op.op === 'remove') {
        PLAN_RPC.plan_item_remove?.({ p_item_id: op.item_id }, tables);
      } else if (op.op === 'move') {
        PLAN_RPC.plan_item_move?.(
          {
            p_item_id: op.item_id,
            p_target_date: op.target_date ?? null,
            p_item_ids: op.item_ids,
            p_keep_reviews: typeof op.keep_reviews === 'boolean' ? op.keep_reviews : true,
          },
          tables,
        );
      } else if (op.op === 'reorder') {
        PLAN_RPC.plan_items_reorder?.({ p_item_ids: op.item_ids }, tables);
      } else {
        throw new HarnessRpcError('invalid_payload');
      }
    }
    return null;
  },
  // Mirrors the live proc: a live item on a live plan; a post item's post must
  // exist and not be deleted (invalid_payload, both sides); team side for the
  // agency roles; client side for a client on a client plan, a draft post
  // refused (post_not_ready). Never touches posts.stage. approved/changes add
  // plan_review inbox rows; waiting after approved/changes adds a withdrawal row.
  plan_item_review: (args, tables) => {
    const item = [...(tables.plan_items ?? []), ...(tables.hidden_plan_items ?? [])].find(
      (i) => i.id === args.p_item_id && i.deleted_at === null,
    );
    const plan =
      item !== undefined
        ? (tables.plans ?? []).find((p) => p.id === item.plan_id && p.deleted_at === null)
        : undefined;
    if (item === undefined || plan === undefined) throw new HarnessRpcError('invalid_payload');
    const side = String(args.p_side);
    const status = String(args.p_status);
    if (
      !['team', 'client'].includes(side) ||
      !['waiting', 'approved', 'changes'].includes(status)
    ) {
      throw new HarnessRpcError('invalid_payload');
    }
    let stage: string | null = null;
    if (item.kind === 'post') {
      const post = (tables.posts ?? []).find((p) => p.id === item.post_id);
      if (post === undefined || (post.deleted_at !== undefined && post.deleted_at !== null)) {
        throw new HarnessRpcError('invalid_payload');
      }
      stage = String(post.stage);
    }
    const role = roleOf(tables, ME);
    if (side === 'team') {
      if (!AGENCY_ROLES.includes(role)) throw new HarnessRpcError('forbidden_role');
    } else {
      if (role !== 'client' || plan.audience !== 'client') {
        throw new HarnessRpcError('forbidden_role');
      }
      if (stage === 'draft') throw new HarnessRpcError('post_not_ready');
    }
    const rows = (tables.plan_item_reviews ??= []);
    const existing = rows.find((r) => r.item_id === args.p_item_id && r.side === side);
    const previous = existing !== undefined ? String(existing.status) : null;
    const now = new Date().toISOString();
    if (existing !== undefined) {
      existing.status = status;
      existing.reviewed_by = ME;
      existing.reviewed_at = now;
    } else {
      rows.push({
        item_id: args.p_item_id,
        workspace_id: WORKSPACE_ID,
        side,
        status,
        reviewed_by: ME,
        reviewed_at: now,
      });
    }
    const payload: Record<string, unknown> | null =
      status !== 'waiting'
        ? { side, status }
        : previous !== null && previous !== 'waiting'
          ? { side, status: 'waiting', withdrawn: true, previous }
          : null;
    if (payload !== null) {
      // _plan_item_notify: agency roles, plus clients on a client-side review; never the actor.
      const recipients = (tables.workspace_members ?? []).filter(
        (m) =>
          m.active === true &&
          m.user_id !== ME &&
          (AGENCY_ROLES.includes(String(m.role)) || (side === 'client' && m.role === 'client')),
      );
      for (const m of recipients) {
        (tables.inbox_entries ??= []).push({
          ...planInboxRow({
            id: crypto.randomUUID(),
            eventType: 'plan_review',
            itemId: String(item.id),
            planId: String(plan.id),
            actor: ME,
            payload,
            agoMs: 0,
          }),
          user_id: m.user_id,
        });
      }
    }
    return null;
  },
  plan_item_comment_create: (args, tables) => {
    const id = crypto.randomUUID();
    (tables.plan_item_comments ??= []).push({
      id,
      workspace_id: WORKSPACE_ID,
      item_id: args.p_item_id,
      author_user_id: ME,
      body: args.p_body,
      visibility: args.p_visibility,
      created_at: new Date().toISOString(),
      edited_at: null,
      deleted_at: null,
    });
    return id;
  },
  // One message carrying the plan; idempotent on p_id; a team plan never goes
  // into a chat with a client.
  chat_plan_share: (args, tables) => {
    const rows = (tables.chat_messages ??= []);
    const existing = rows.find((m) => m.id === args.p_id);
    if (existing !== undefined) return existing;
    const plan = (tables.plans ?? []).find((p) => p.id === args.p_plan_id && p.deleted_at === null);
    if (plan === undefined) throw new HarnessRpcError('plan not available');
    const channelId = String(args.p_channel_id);
    if (plan.audience === 'team') {
      if (roleOf(tables, ME) === 'client') throw new HarnessRpcError('plan not available');
      const hasClient = channelMemberIds(tables, channelId).some(
        (id) => id !== ME && roleOf(tables, id) === 'client',
      );
      if (hasClient) throw new HarnessRpcError('plan_not_shared_with_client');
    }
    const row: Row = {
      id: args.p_id,
      channel_id: channelId,
      workspace_id: WORKSPACE_ID,
      sender_user_id: ME,
      body: typeof args.p_body === 'string' ? args.p_body : null,
      mentions: null,
      attachment_asset_ids: null,
      shared_post_ids: null,
      shared_brief_ids: null,
      shared_plan_ids: [args.p_plan_id],
      reply_to_message_id: null,
      forwarded_from_message_id: null,
      attachment_meta: null,
      agora_event_id: null,
      created_at: new Date().toISOString(),
      edited_at: null,
      deleted_at: null,
      thread_root_message_id: null,
    };
    rows.push(row);
    return row;
  },
};

/** Onboarding procs (20261014140000): just enough world for the onboarding spec. */
const ONBOARDING_RPC: Record<string, RpcHandler> = {
  username_available: (args, tables) => {
    const name = String(args.p_username ?? '');
    return !(tables.users ?? []).some((u) => u.username === name && u.id !== ME);
  },
  user_onboarding_save: (args, tables) => {
    const payload = (args.p_payload ?? {}) as Record<string, unknown>;
    const me = (tables.users ?? []).find((u) => u.id === ME);
    if (me === undefined) throw new HarnessRpcError('invalid_payload');
    me.display_name = String(payload.display_name ?? '');
    me.username = String(payload.username ?? '');
    me.designation = payload.designation ?? null;
    me.profile_completed_at = new Date().toISOString();
    return ME;
  },
  workspace_create: (args, tables) => {
    const payload = (args.p_payload ?? {}) as Record<string, unknown>;
    const id = crypto.randomUUID();
    (tables.workspaces ??= []).push({
      id,
      name: String(payload.name ?? ''),
      timezone: String(payload.timezone ?? 'UTC'),
      // workspace_create falls back to linkedin when no platform is sent.
      platform: String(payload.platform ?? 'linkedin'),
      client_domain: null,
      logo_url: null,
      owner_user_id: ME,
      key: 'KC',
      created_at: new Date().toISOString(),
    });
    (tables.workspace_members ??= []).push({
      id: crypto.randomUUID(),
      workspace_id: id,
      user_id: ME,
      role: 'owner',
      active: true,
      accepted_at: new Date().toISOString(),
      removed_at: null,
    });
    return id;
  },
};

// The default capability seed per role (workspace_role_permissions), as far as
// the app reads it: brief.create is the client's, settings are owner/admin's,
// post.create is the agency side's (owner, admin, agency).
const ROLE_CAPABILITIES: Record<string, readonly string[]> = {
  owner: ['workspace.manage_settings', 'post.create'],
  admin: ['workspace.manage_settings', 'post.create'],
  agency: ['post.create'],
  client: ['brief.create'],
};

const CAPABILITY_RPC: Record<string, RpcHandler> = {
  proc_capability: (args, tables) => {
    const member = (tables.workspace_members ?? []).find(
      (m) => m.workspace_id === args.p_workspace_id && m.user_id === ME && m.active === true,
    );
    const role = typeof member?.role === 'string' ? member.role : '';
    return (ROLE_CAPABILITIES[role] ?? []).includes(String(args.p_capability));
  },
};

const RPC: Record<string, RpcHandler> = {
  ...PLAN_RPC,
  ...CAPABILITY_RPC,
  ...TASK_RPC,
  ...ONBOARDING_RPC,
  ...INDUCTION_RPC,
  ...SEARCH_RPC,
  chat_unread_counts: (_args, tables) => {
    const cursors = tables.chat_read_cursors ?? [];
    const channels = tables.chat_channels ?? [];
    return channels.map((channel) => {
      const mine = cursors.find((c) => c.channel_id === channel.channel_id && c.user_id === ME);
      const after = String(mine?.last_read_at ?? '');
      const unread = (tables.chat_messages ?? []).filter(
        (m) =>
          m.channel_id === channel.channel_id &&
          m.sender_user_id !== ME &&
          String(m.created_at) > after,
      ).length;
      return { channel_id: channel.channel_id, unread_count: unread };
    });
  },
  chat_read_cursor_set: () => null,
  // Mark stamps: resolve / reopen the fixture mark row (the proc returns void).
  chat_mark_resolve: (args, tables) => {
    const row = (tables.chat_message_marks ?? []).find((m) => m.message_id === args.p_message_id);
    if (row === undefined) throw new HarnessRpcError('mark not found');
    row.resolved_by = ME;
    row.resolved_at = new Date().toISOString();
    return null;
  },
  chat_mark_reopen: (args, tables) => {
    const row = (tables.chat_message_marks ?? []).find((m) => m.message_id === args.p_message_id);
    if (row === undefined) throw new HarnessRpcError('mark not found');
    row.resolved_by = null;
    row.resolved_at = null;
    return null;
  },
  inbox_mark_read: () => null,
  // Notifications read state: snooze one entry.
  inbox_snooze: (args, tables) => {
    const row = (tables.inbox_entries ?? []).find((r) => r.id === args.p_entry_id);
    if (row !== undefined) row.snoozed_until = new Date(Date.now() + 3_600_000).toISOString();
    return null;
  },
  // Reminders: an id already held is a no-op; a new one replaces the pending
  // reminder on the same message (the proc's Change time rule).
  chat_reminder_set: (args, tables) => {
    const rows = (tables.chat_message_reminders ??= []);
    if (rows.some((r) => r.id === args.p_id)) return null;
    const now = new Date().toISOString();
    for (const r of rows) {
      if (r.message_id === args.p_message_id && r.fired_at === null && r.cancelled_at === null) {
        r.cancelled_at = now;
      }
    }
    rows.push({
      id: args.p_id,
      user_id: ME,
      message_id: args.p_message_id,
      channel_id: args.p_channel_id,
      workspace_id: WORKSPACE_ID,
      remind_at: args.p_remind_at,
      fired_at: null,
      cancelled_at: null,
      created_at: now,
    });
    return null;
  },
  chat_reminder_cancel: (args, tables) => {
    const row = (tables.chat_message_reminders ?? []).find((r) => r.id === args.p_id);
    if (row !== undefined && row.fired_at === null) row.cancelled_at = new Date().toISOString();
    return null;
  },
  session_register: () => null,
  // Personal notes: the deterministic channel, created once (idempotent).
  notes_channel_ensure: (args, tables) => {
    const channels = (tables.chat_channels ??= []);
    const id = `notes__${String(args.p_workspace_id)}__${ME}`;
    if (!channels.some((c) => c.channel_id === id))
      channels.push({ ...notesChannelRow(), channel_id: id });
    return id;
  },
  // Message search: each word a prefix match, newest first, keyset paging,
  // deleted rows left out, the limit clamped 1..50, a query outside 2..100 empty.
  chat_message_search: (args, tables) => {
    // A filter chip (p_kind): the newest matches of that kind, the query
    // (when 2+ characters) narrowing them, like the 8-arg proc.
    if (typeof args.p_kind === 'string') return kindSearch(args, tables);
    const query = String(args.p_query ?? '').trim();
    if (query.length < 2 || query.length > 100) return [];
    const words = query.toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
    const limit = Math.min(50, Math.max(1, Number(args.p_limit ?? 30)));
    const beforeAt = typeof args.p_before_created_at === 'string' ? args.p_before_created_at : null;
    const beforeId = typeof args.p_before_id === 'string' ? args.p_before_id : null;
    return (tables.chat_messages ?? [])
      .filter((m) => m.deleted_at === null && typeof m.body === 'string')
      .filter((m) => args.p_channel_id == null || m.channel_id === args.p_channel_id)
      .filter((m) => {
        const tokens =
          String(m.body)
            .toLowerCase()
            .match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
        return words.every((w) => tokens.some((t) => t.startsWith(w)));
      })
      .sort(
        (a, b) =>
          String(b.created_at).localeCompare(String(a.created_at)) ||
          String(b.id).localeCompare(String(a.id)),
      )
      .filter((m) => {
        if (beforeAt === null || beforeId === null) return true;
        const at = String(m.created_at);
        return at < beforeAt || (at === beforeAt && String(m.id) < beforeId);
      })
      .slice(0, limit);
  },
  // Live replies per thread root (deleted ones left out), the first 200 ids only.
  chat_thread_reply_counts: (args, tables) => {
    const ids = Array.isArray(args.p_root_ids) ? args.p_root_ids.slice(0, 200).map(String) : [];
    const replies = (tables.chat_messages ?? []).filter(
      (m) =>
        m.channel_id === args.p_channel_id &&
        m.deleted_at === null &&
        ids.includes(String(m.thread_root_message_id)),
    );
    return ids
      .map((root) => {
        const own = replies.filter((m) => m.thread_root_message_id === root);
        const last = own
          .map((m) => String(m.created_at))
          .sort()
          .pop();
        return { root_id: root, reply_count: own.length, last_reply_at: last ?? null };
      })
      .filter((row) => row.reply_count > 0);
  },
  // The record write: the row lands now, its thread root set by the trigger's rule.
  chat_message_send: (args, tables) => {
    const rows = tables.chat_messages ?? [];
    const existing = rows.find((m) => m.id === args.p_id);
    if (existing !== undefined) return existing;
    const replyTo =
      typeof args.p_reply_to_message_id === 'string' ? args.p_reply_to_message_id : null;
    const row: Row = {
      id: args.p_id,
      channel_id: args.p_channel_id,
      workspace_id: WORKSPACE_ID,
      sender_user_id: ME,
      body: typeof args.p_body === 'string' ? args.p_body : null,
      mentions: Array.isArray(args.p_mentions) ? args.p_mentions : null,
      attachment_asset_ids: Array.isArray(args.p_attachment_asset_ids)
        ? args.p_attachment_asset_ids
        : null,
      shared_post_ids: Array.isArray(args.p_shared_post_ids) ? args.p_shared_post_ids : null,
      shared_brief_ids: null,
      reply_to_message_id: replyTo,
      forwarded_from_message_id: null,
      attachment_meta: isObject(args.p_attachment_meta) ? args.p_attachment_meta : null,
      agora_event_id: null,
      created_at: new Date().toISOString(),
      edited_at: null,
      deleted_at: null,
      thread_root_message_id: threadRootOf(rows, replyTo),
    };
    if (typeof args.p_forwarded_from_message_id === 'string') {
      row.forwarded_from_message_id = args.p_forwarded_from_message_id;
    }
    if (Array.isArray(args.p_shared_brief_ids)) row.shared_brief_ids = args.p_shared_brief_ids;
    rows.push(row);
    return row;
  },
  // Scheduled sends: the four procs over the chat_scheduled_messages fixture.
  chat_message_schedule: (args, tables) => {
    const rows = (tables.chat_scheduled_messages ??= []);
    const now = new Date().toISOString();
    const row: Row = {
      id: args.p_id,
      channel_id: args.p_channel_id,
      workspace_id: WORKSPACE_ID,
      sender_user_id: ME,
      body: typeof args.p_body === 'string' ? args.p_body : null,
      mentions: Array.isArray(args.p_mentions) ? args.p_mentions : null,
      attachment_asset_ids: Array.isArray(args.p_attachment_asset_ids)
        ? args.p_attachment_asset_ids
        : null,
      attachment_meta: isObject(args.p_attachment_meta) ? args.p_attachment_meta : null,
      shared_post_ids: Array.isArray(args.p_shared_post_ids) ? args.p_shared_post_ids : null,
      shared_brief_ids: Array.isArray(args.p_shared_brief_ids) ? args.p_shared_brief_ids : null,
      reply_to_message_id:
        typeof args.p_reply_to_message_id === 'string' ? args.p_reply_to_message_id : null,
      send_at: args.p_send_at,
      status: 'scheduled',
      failure_reason: null,
      sent_at: null,
      created_at: now,
      updated_at: now,
    };
    rows.push(row);
    return row;
  },
  chat_scheduled_update: (args, tables) => {
    const row = (tables.chat_scheduled_messages ?? []).find((r) => r.id === args.p_id);
    if (row === undefined) return null;
    row.send_at = args.p_send_at;
    row.body = args.p_body;
    row.mentions = args.p_mentions;
    row.updated_at = new Date().toISOString();
    return row;
  },
  chat_scheduled_cancel: (args, tables) => {
    const row = (tables.chat_scheduled_messages ?? []).find((r) => r.id === args.p_id);
    if (row !== undefined) row.status = 'cancelled';
    return null;
  },
  chat_scheduled_send_now: (args, tables) => {
    const row = (tables.chat_scheduled_messages ?? []).find((r) => r.id === args.p_id);
    if (row === undefined) return null;
    row.status = 'sent';
    row.sent_at = new Date().toISOString();
    // The proc's chat_scheduled_clear_failed: the send's failed entry is read now.
    for (const entry of tables.inbox_entries ?? []) {
      const payload = entry.payload as Record<string, unknown> | null;
      if (
        entry.event_type === 'scheduled_failed' &&
        entry.read_at === null &&
        payload?.scheduled_id === row.id
      ) {
        entry.read_at = row.sent_at;
      }
    }
    const send = RPC.chat_message_send;
    return send === undefined
      ? null
      : send(
          {
            p_id: row.id,
            p_channel_id: row.channel_id,
            p_body: row.body,
            p_mentions: row.mentions,
            p_shared_post_ids: row.shared_post_ids,
            p_reply_to_message_id: row.reply_to_message_id,
            p_attachment_asset_ids: row.attachment_asset_ids,
            p_attachment_meta: row.attachment_meta,
          },
          tables,
        );
  },
};

/** chat_message_search with p_kind: photo / voice / file by attachment mime, link by body. */
function kindSearch(args: Record<string, unknown>, tables: Tables): Row[] {
  const kind = String(args.p_kind);
  const query = String(args.p_query ?? '').trim();
  if (query.length === 1 || query.length > 100) return [];
  const words = query.toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
  const limit = Math.min(50, Math.max(1, Number(args.p_limit ?? 30)));
  const beforeAt = typeof args.p_before_created_at === 'string' ? args.p_before_created_at : null;
  const beforeId = typeof args.p_before_id === 'string' ? args.p_before_id : null;
  const mimes = (m: Row): string[] =>
    isObject(m.attachment_meta)
      ? Object.values(m.attachment_meta).map((v) => (isObject(v) ? String(v.mime ?? '') : ''))
      : [];
  const ofKind = (m: Row): boolean => {
    if (kind === 'link') return /https?:\/\//i.test(String(m.body ?? ''));
    const list = mimes(m);
    if (kind === 'photo') return list.some((t) => t.startsWith('image/'));
    if (kind === 'voice') return list.some((t) => t.startsWith('audio/'));
    if (kind === 'file')
      return list.some((t) => !t.startsWith('image/') && !t.startsWith('audio/'));
    return false;
  };
  return (tables.chat_messages ?? [])
    .filter((m) => m.deleted_at === null && ofKind(m))
    .filter((m) => args.p_channel_id == null || m.channel_id === args.p_channel_id)
    .filter((m) => {
      if (words.length === 0) return true;
      const tokens =
        String(m.body ?? '')
          .toLowerCase()
          .match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
      return words.every((w) => tokens.some((t) => t.startsWith(w)));
    })
    .sort(
      (a, b) =>
        String(b.created_at).localeCompare(String(a.created_at)) ||
        String(b.id).localeCompare(String(a.id)),
    )
    .filter((m) => {
      if (beforeAt === null || beforeId === null) return true;
      const at = String(m.created_at);
      return at < beforeAt || (at === beforeAt && String(m.id) < beforeId);
    })
    .slice(0, limit);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A refused record write (the proc raised): the send shows "Not sent" with its alert. */
function refusedSend(name: string, args: Record<string, unknown>): boolean {
  return (
    name === 'chat_message_send' &&
    typeof args.p_body === 'string' &&
    args.p_body.includes(REFUSED_SEND)
  );
}

export interface HarnessNetwork {
  world: ChatWorld;
  /** Requests the fixtures did not recognise (answered with an empty result). */
  unmatched: string[];
  /** Every non-localhost request that was blocked outright. */
  blocked: string[];
  /** Gate chat_messages reads until release() so a test can see first paint. */
  holdHistory: () => { release: () => void };
  /** Every file name the asset-upload stub received, in order. */
  uploads: string[];
  /** Gate asset uploads until release() so a test can see them in flight. */
  holdUploads: () => { release: () => void };
  /** Every RPC the page called, in order, with its JSON args. */
  rpcCalls: Array<{ name: string; args: Record<string, unknown> }>;
  /** RPC names the fixture refuses (400, the proc raised) until removed. */
  refuseRpc: Set<string>;
  /** Gate GET reads of one REST table until release() (a slow read). */
  holdTable: (table: string) => { release: () => void };
  /** REST tables whose reads fail (500) until removed. */
  failTable: Set<string>;
}

export async function installHarnessNetwork(
  page: Page,
  opts: {
    planSwipePeek?: boolean;
    /**
     * The voice notes' bytes: the silent wav (default), bytes no browser can
     * decode, or 'stall': the request is never answered, so no data arrives.
     */
    voiceAudio?: 'wav' | 'invalid' | 'stall';
    /** A transcript stored on every voice note's attachment_meta (the legacy field). */
    voiceTranscript?: string;
  } = {},
): Promise<HarnessNetwork> {
  const world = buildWorld();
  if (opts.voiceTranscript !== undefined) {
    for (const m of world.tables.chat_messages ?? []) {
      const meta = m.attachment_meta as Record<string, Record<string, unknown>> | null;
      for (const entry of Object.values(meta ?? {})) {
        if (String(entry.mime).startsWith('audio/')) entry.transcript = opts.voiceTranscript;
      }
    }
  }
  const unmatched: string[] = [];
  const blocked: string[] = [];
  let historyGate: Promise<void> | null = null;
  const uploads: string[] = [];
  let uploadGate: Promise<void> | null = null;
  const rpcCalls: HarnessNetwork['rpcCalls'] = [];
  const refuseRpc = new Set<string>();
  const tableGates = new Map<string, Promise<void>>();
  const failTable = new Set<string>();

  await page.addInitScript((session) => {
    window.localStorage.setItem('sb-harness-auth-token', session);
  }, fakeSession());
  // The plan list's one-time swipe peek moves a row about 600ms after it
  // paints: specs see it only when they ask for it.
  if (opts.planSwipePeek !== true) {
    await page.addInitScript(() => {
      window.localStorage.setItem('sorted:plan-swipe-peek-seen', '1');
    });
  }

  const png = solidPng(64, 48, [96, 128, 160]);
  const wav = silentWav();
  // Not audio at all: the element raises a media error and play() rejects.
  const brokenAudio = Buffer.from('this is not an audio file', 'utf8');
  const pdf = fixturePdf(FIXTURE_PDF_PAGES);

  const handle = async (route: Route): Promise<void> => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    if (method === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS });
      return;
    }
    if (url.hostname === SUPABASE_HOST) {
      if (url.pathname.startsWith('/rest/v1/rpc/')) {
        const name = url.pathname.slice('/rest/v1/rpc/'.length);
        const handler = RPC[name];
        if (!handler) unmatched.push(`rpc ${name}`);
        const args = (request.postDataJSON() ?? {}) as Record<string, unknown>;
        rpcCalls.push({ name, args });
        if (refusedSend(name, args) || refuseRpc.has(name)) {
          await route.fulfill({
            status: 400,
            headers: { ...CORS, 'content-type': 'application/json' },
            body: JSON.stringify({ code: 'P0001', message: 'refused', details: null, hint: null }),
          });
          return;
        }
        let result: unknown;
        try {
          result = handler ? handler(args, world.tables) : null;
        } catch (error) {
          if (!(error instanceof HarnessRpcError)) throw error;
          await route.fulfill({
            status: 400,
            headers: { ...CORS, 'content-type': 'application/json' },
            body: JSON.stringify({
              code: 'P0001',
              message: error.message,
              details: null,
              hint: null,
            }),
          });
          return;
        }
        await route.fulfill({
          status: 200,
          headers: { ...CORS, 'content-type': 'application/json' },
          body: JSON.stringify(result),
        });
        return;
      }
      if (url.pathname.startsWith('/rest/v1/')) {
        const table = url.pathname.slice('/rest/v1/'.length);
        if (method !== 'GET' && method !== 'HEAD') {
          unmatched.push(`${method} ${table}`);
          await route.fulfill({ status: 204, headers: CORS });
          return;
        }
        // The create form's exemption read (own row under RLS): the harness user is an
        // active platform operator, so the create-workspace flows stay open. The
        // non-exempt path is covered by the WorkspaceSwitcher unit tests.
        if (table === 'platform_operators') {
          await route.fulfill({
            status: 200,
            headers: { ...CORS, 'content-type': 'application/json' },
            body: JSON.stringify([{ user_id: ME }]),
          });
          return;
        }
        if (!(table in world.tables)) unmatched.push(`table ${table}`);
        if (table === 'chat_messages' && historyGate) await historyGate;
        const tableGate = tableGates.get(table);
        if (tableGate !== undefined) await tableGate;
        if (failTable.has(table)) {
          await route.fulfill({
            status: 500,
            headers: { ...CORS, 'content-type': 'application/json' },
            body: JSON.stringify({ code: 'XX000', message: 'failed', details: null, hint: null }),
          });
          return;
        }
        // A post's live plans (the delete confirm: post_id=eq.) and the Plan
        // screen's batched Also in read (post_id=in.(...)): plan_items joined to
        // their live plans' titles in one select, as PostgREST's !inner embed answers.
        if (
          table === 'plan_items' &&
          (url.searchParams.get('select') ?? '').includes('plans!inner')
        ) {
          const filter = url.searchParams.get('post_id') ?? '';
          const postIds = filter.startsWith('in.(')
            ? filter.slice(4, -1).split(',')
            : [filter.replace(/^eq\./, '')];
          const rows = (world.tables.plan_items ?? []).flatMap((i) => {
            if (!postIds.includes(String(i.post_id)) || i.deleted_at !== null) return [];
            const plan = (world.tables.plans ?? []).find(
              (p) => p.id === i.plan_id && p.deleted_at === null,
            );
            return plan === undefined
              ? []
              : [{ post_id: i.post_id, plan_id: i.plan_id, plans: { title: plan.title } }];
          });
          await route.fulfill({
            status: 200,
            headers: { ...CORS, 'content-type': 'application/json' },
            body: JSON.stringify(rows),
          });
          return;
        }
        const answer = answerRest(world.tables, table, url.searchParams, method, request.headers());
        await route.fulfill({
          status: answer.status,
          headers: { ...CORS, ...answer.headers },
          body: answer.body,
        });
        return;
      }
      if (url.pathname.startsWith('/auth/v1/user')) {
        const session = JSON.parse(fakeSession()) as { user: Row };
        await route.fulfill({
          status: 200,
          headers: { ...CORS, 'content-type': 'application/json' },
          body: JSON.stringify(session.user),
        });
        return;
      }
      unmatched.push(`${method} ${url.pathname}`);
      await route.fulfill({
        status: 200,
        headers: { ...CORS, 'content-type': 'application/json' },
        body: '{}',
      });
      return;
    }
    if (url.hostname === CHAT_TOKEN_HOST) {
      await route.fulfill({
        status: 200,
        headers: { ...CORS, 'content-type': 'application/json' },
        body: JSON.stringify({
          token: 'harness-chat-token',
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          agora_username: ME.replace(/-/g, ''),
          app_key: 'harness#app',
        }),
      });
      return;
    }
    if (url.hostname === ASSET_READ_HOST) {
      if (url.pathname.startsWith('/blob/audio')) {
        // Left pending: the element never gets a byte, an error or an end.
        if (opts.voiceAudio === 'stall') return;
        await route.fulfill({
          status: 200,
          headers: {
            ...CORS,
            'content-type': opts.voiceAudio === 'invalid' ? 'audio/webm' : 'audio/wav',
          },
          body: opts.voiceAudio === 'invalid' ? brokenAudio : wav,
        });
        return;
      }
      if (url.pathname.startsWith('/blob/')) {
        await route.fulfill({
          status: 200,
          headers: { ...CORS, 'content-type': 'image/png' },
          body: png,
        });
        return;
      }
      const body = (request.postDataJSON() ?? {}) as Record<string, unknown>;
      const id = String(body.asset_version_id ?? body.id ?? 'x');
      // The file viewer's PDF bytes come through the Worker (stream mode). Like
      // the real Worker, a chat file that is not a PDF, Word or Excel file
      // (a pptx) has no stream: 400.
      const streamMime = Object.values(world.tables.chat_messages ?? [])
        .map((m) => (m.attachment_meta as Record<string, { mime?: string }> | null)?.[id]?.mime)
        .find((mime) => mime !== undefined);
      if (
        body.stream === true &&
        streamMime !== undefined &&
        !/^application\/(pdf|vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|spreadsheetml\.sheet))$/.test(
          streamMime,
        )
      ) {
        await route.fulfill({
          status: 400,
          headers: { ...CORS, 'content-type': 'application/json' },
          body: JSON.stringify({ error: { code: 'bad_request' } }),
        });
        return;
      }
      if (body.stream === true) {
        await route.fulfill({
          status: 200,
          headers: {
            ...CORS,
            'content-type': 'application/pdf',
            'x-content-type-options': 'nosniff',
            'cache-control': 'private, no-store',
          },
          body: pdf,
        });
        return;
      }
      // A thumbnail rendition: the fixture PNG for any version whose meta has one.
      if (body.rendition === 'thumbnail') {
        const has = Object.values(world.tables.chat_messages ?? []).some((m) => {
          const meta = m.attachment_meta as Record<string, { thumb_w?: number }> | null;
          return typeof meta?.[id]?.thumb_w === 'number';
        });
        // No small copy: 204 with no body, as the worker answers.
        await route.fulfill(
          has
            ? {
                status: 200,
                headers: { ...CORS, 'content-type': 'application/json' },
                body: JSON.stringify({
                  url: `https://${ASSET_READ_HOST}/blob/image/${id}`,
                  expires_at: new Date(Date.now() + 3_600_000).toISOString(),
                }),
              }
            : { status: 204, headers: CORS, body: '' },
        );
        return;
      }
      const isAudio = Object.values(world.tables.chat_messages ?? []).some((m) => {
        const meta = m.attachment_meta as Record<string, { mime?: string }> | null;
        return meta?.[id]?.mime?.startsWith('audio/') === true;
      });
      await route.fulfill({
        status: 200,
        headers: { ...CORS, 'content-type': 'application/json' },
        body: JSON.stringify({
          url: `https://${ASSET_READ_HOST}/blob/${isAudio ? 'audio' : 'image'}/${id}`,
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        }),
      });
      return;
    }
    if (url.hostname === ASSET_UPLOAD_HOST && method === 'POST') {
      // The asset-upload Worker's answer: a fresh asset and version per file.
      if (uploadGate) await uploadGate;
      const body = request.postDataBuffer()?.toString('latin1') ?? '';
      const name = /filename="([^"]+)"/.exec(body)?.[1] ?? 'file';
      uploads.push(name);
      const n = String(uploads.length).padStart(12, '0');
      await route.fulfill({
        status: 200,
        headers: { ...CORS, 'content-type': 'application/json' },
        body: JSON.stringify({
          asset: {
            assetId: `0190f000-0000-7000-8000-${n}`,
            versionId: `0190f100-0000-7000-8000-${n}`,
            reused: false,
          },
        }),
      });
      return;
    }
    if (url.hostname === ASSET_UPLOAD_HOST && method === 'GET' && url.pathname === '/usage') {
      // The asset-upload Worker's storage reading: a fresh workspace, no warning.
      await route.fulfill({
        status: 200,
        headers: { ...CORS, 'content-type': 'application/json' },
        body: JSON.stringify({
          usedBytes: 0,
          warnAtBytes: 800 * 1024 * 1024,
          warn: false,
          exempt: false,
        }),
      });
      return;
    }
    blocked.push(request.url());
    await route.abort('blockedbyclient');
  };

  // The page's own object URLs (picked-file previews; WebKit routes them) never
  // leave the page, so they are not routed.
  await page.route(/^(?!https?:\/\/localhost[:/]|blob:)/, handle);
  // page.route never sees WebSockets. A socket to a fixture host is accepted
  // and left silent (no server behind it); any other socket is closed and
  // recorded as blocked.
  await page.routeWebSocket(/^(?!wss?:\/\/localhost[:/])/, (socket) => {
    const host = new URL(socket.url()).hostname;
    if (host.endsWith('.test')) return;
    blocked.push(socket.url());
    void socket.close();
  });

  return {
    world,
    unmatched,
    blocked,
    holdHistory: () => {
      let release = (): void => {};
      historyGate = new Promise<void>((resolve) => {
        release = () => {
          historyGate = null;
          resolve();
        };
      });
      return { release };
    },
    uploads,
    holdUploads: () => {
      let release = (): void => {};
      uploadGate = new Promise<void>((resolve) => {
        release = () => {
          uploadGate = null;
          resolve();
        };
      });
      return { release };
    },
    rpcCalls,
    refuseRpc,
    holdTable: (table) => {
      let release = (): void => {};
      tableGates.set(
        table,
        new Promise<void>((resolve) => {
          release = () => {
            tableGates.delete(table);
            resolve();
          };
        }),
      );
      return { release };
    },
    failTable,
  };
}

export { WORKSPACE_ID };

// ---------------------------------------------------------------------------
// Activity plan rows (plan_comment / plan_review), the live writer's shape:
// entity_type 'plan_item', entity_id the item, scope 'posts', scope_key and
// payload.plan_id the plan. Seed a plan first (seedClientPlan).
// ---------------------------------------------------------------------------

/** The plan comment an Activity plan_comment row points at (on the concept). */
export const ACTIVITY_PLAN_COMMENT_ID = '0190d300-0000-7000-8000-00000000d3a1';
export const ACTIVITY_PLAN_COMMENT_BODY = 'Love the morning light. Can the first shot be wider?';
export const ACTIVITY_PLAN_COMMENT_ROW = '0190f100-0000-7000-8000-0000000000d1';
export const ACTIVITY_PLAN_REVIEW_ROW = '0190f100-0000-7000-8000-0000000000d2';

/** One inbox row for the viewer (ME) of a plan event, created `agoMs` ago. */
function planInboxRow(input: {
  id: string;
  eventType: 'plan_comment' | 'plan_review';
  itemId: string;
  planId: string;
  actor: string;
  payload: Record<string, unknown>;
  agoMs: number;
}): Row {
  return {
    id: input.id,
    user_id: ME,
    actor_user_id: input.actor,
    workspace_id: WORKSPACE_ID,
    event_type: input.eventType,
    entity_type: 'plan_item',
    entity_id: input.itemId,
    scope: 'posts',
    scope_key: input.planId,
    tier: 'active',
    payload: { ...input.payload, plan_id: input.planId },
    read_at: null,
    snoozed_until: null,
    email_sent_at: null,
    deleted_at: null,
    created_at: new Date(Date.now() - input.agoMs).toISOString(),
  };
}

/**
 * A plan_comment row on `itemId` (with its Everyone comment by `actor`, listed
 * among a few older comments so the item screen has to scroll to it).
 */
export function seedActivityPlanComment(
  world: ChatWorld,
  opts: { planId: string; itemId: string; actor: string },
): void {
  const t = world.tables;
  const comments = (t.plan_item_comments ??= []);
  for (let k = 0; k < 6; k += 1) {
    comments.push({
      id: `0190d300-0000-7000-8000-00000000d3b${k}`,
      workspace_id: WORKSPACE_ID,
      item_id: opts.itemId,
      author_user_id: ME,
      body: `Earlier note ${k + 1} on the cut and the caption length.`,
      visibility: 'everyone',
      created_at: `2026-10-09T10:0${k}:00Z`,
      edited_at: null,
      deleted_at: null,
    });
  }
  comments.push({
    id: ACTIVITY_PLAN_COMMENT_ID,
    workspace_id: WORKSPACE_ID,
    item_id: opts.itemId,
    author_user_id: opts.actor,
    body: ACTIVITY_PLAN_COMMENT_BODY,
    visibility: 'everyone',
    created_at: '2026-10-09T11:00:00Z',
    edited_at: null,
    deleted_at: null,
  });
  (t.inbox_entries ??= []).push(
    planInboxRow({
      id: ACTIVITY_PLAN_COMMENT_ROW,
      eventType: 'plan_comment',
      itemId: opts.itemId,
      planId: opts.planId,
      actor: opts.actor,
      payload: { comment_id: ACTIVITY_PLAN_COMMENT_ID, visibility: 'everyone' },
      agoMs: 60_000,
    }),
  );
}

/** A plan_review row on `itemId` by `actor` (side and status as the writer records them). */
export function seedActivityPlanReview(
  world: ChatWorld,
  opts: {
    planId: string;
    itemId: string;
    actor: string;
    side: 'team' | 'client';
    status: 'approved' | 'changes';
  },
): void {
  (world.tables.inbox_entries ??= []).push(
    planInboxRow({
      id: ACTIVITY_PLAN_REVIEW_ROW,
      eventType: 'plan_review',
      itemId: opts.itemId,
      planId: opts.planId,
      actor: opts.actor,
      payload: { side: opts.side, status: opts.status },
      agoMs: 120_000,
    }),
  );
}
