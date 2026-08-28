// AUTO-GENERATED. Run pnpm types:supabase to refresh. Do not edit by hand.

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      asset_attachments: {
        Row: {
          asset_id: string
          asset_version_id: string
          attached_at: string
          attached_by: string | null
          deleted_at: string | null
          entity_id: string
          entity_type: string
          id: string
          position: number
          workspace_id: string
        }
        Insert: {
          asset_id: string
          asset_version_id: string
          attached_at?: string
          attached_by?: string | null
          deleted_at?: string | null
          entity_id: string
          entity_type: string
          id?: string
          position?: number
          workspace_id: string
        }
        Update: {
          asset_id?: string
          asset_version_id?: string
          attached_at?: string
          attached_by?: string | null
          deleted_at?: string | null
          entity_id?: string
          entity_type?: string
          id?: string
          position?: number
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "asset_attachments_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_attachments_asset_version_id_fkey"
            columns: ["asset_version_id"]
            isOneToOne: false
            referencedRelation: "asset_versions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_attachments_attached_by_fkey"
            columns: ["attached_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_attachments_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      asset_renditions: {
        Row: {
          asset_version_id: string
          created_at: string
          duration_ms: number | null
          height: number | null
          id: string
          mime_type: string
          r2_key: string
          role: string
          sha256: string
          size_bytes: number
          width: number | null
          workspace_id: string
        }
        Insert: {
          asset_version_id: string
          created_at?: string
          duration_ms?: number | null
          height?: number | null
          id?: string
          mime_type: string
          r2_key: string
          role: string
          sha256: string
          size_bytes: number
          width?: number | null
          workspace_id: string
        }
        Update: {
          asset_version_id?: string
          created_at?: string
          duration_ms?: number | null
          height?: number | null
          id?: string
          mime_type?: string
          r2_key?: string
          role?: string
          sha256?: string
          size_bytes?: number
          width?: number | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "asset_renditions_asset_version_id_fkey"
            columns: ["asset_version_id"]
            isOneToOne: false
            referencedRelation: "asset_versions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_renditions_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      asset_versions: {
        Row: {
          asset_id: string
          duration_ms: number | null
          external_url: string | null
          height: number | null
          id: string
          kind: string
          mime_type: string | null
          r2_key: string | null
          sha256: string | null
          size_bytes: number | null
          uploaded_at: string
          uploaded_by: string | null
          version_number: number
          width: number | null
          workspace_id: string
        }
        Insert: {
          asset_id: string
          duration_ms?: number | null
          external_url?: string | null
          height?: number | null
          id?: string
          kind: string
          mime_type?: string | null
          r2_key?: string | null
          sha256?: string | null
          size_bytes?: number | null
          uploaded_at?: string
          uploaded_by?: string | null
          version_number: number
          width?: number | null
          workspace_id: string
        }
        Update: {
          asset_id?: string
          duration_ms?: number | null
          external_url?: string | null
          height?: number | null
          id?: string
          kind?: string
          mime_type?: string | null
          r2_key?: string | null
          sha256?: string | null
          size_bytes?: number | null
          uploaded_at?: string
          uploaded_by?: string | null
          version_number?: number
          width?: number | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "asset_versions_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_versions_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_versions_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      assets: {
        Row: {
          current_version_id: string | null
          deleted_at: string | null
          display_name: string | null
          filename: string
          folder_id: string | null
          folder_path: string
          id: string
          tags: string[]
          uploaded_at: string
          uploaded_by: string | null
          workspace_id: string
        }
        Insert: {
          current_version_id?: string | null
          deleted_at?: string | null
          display_name?: string | null
          filename: string
          folder_id?: string | null
          folder_path?: string
          id?: string
          tags?: string[]
          uploaded_at?: string
          uploaded_by?: string | null
          workspace_id: string
        }
        Update: {
          current_version_id?: string | null
          deleted_at?: string | null
          display_name?: string | null
          filename?: string
          folder_id?: string | null
          folder_path?: string
          id?: string
          tags?: string[]
          uploaded_at?: string
          uploaded_by?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "assets_current_version_id_fkey"
            columns: ["current_version_id"]
            isOneToOne: false
            referencedRelation: "asset_versions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assets_folder_id_fkey"
            columns: ["folder_id"]
            isOneToOne: false
            referencedRelation: "folders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assets_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assets_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_log: {
        Row: {
          action: string
          actor_user_id: string | null
          created_at: string
          entity_id: string | null
          entity_type: string | null
          error_code: string | null
          id: string
          impersonation_session_id: string | null
          ip_subnet: unknown
          on_behalf_of: string | null
          outcome: string
          payload: Json | null
          trace_id: string
          workspace_id: string | null
        }
        Insert: {
          action: string
          actor_user_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          error_code?: string | null
          id?: string
          impersonation_session_id?: string | null
          ip_subnet?: unknown
          on_behalf_of?: string | null
          outcome: string
          payload?: Json | null
          trace_id: string
          workspace_id?: string | null
        }
        Update: {
          action?: string
          actor_user_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          error_code?: string | null
          id?: string
          impersonation_session_id?: string | null
          ip_subnet?: unknown
          on_behalf_of?: string | null
          outcome?: string
          payload?: Json | null
          trace_id?: string
          workspace_id?: string | null
        }
        Relationships: []
      }
      audit_log_2026_05: {
        Row: {
          action: string
          actor_user_id: string | null
          created_at: string
          entity_id: string | null
          entity_type: string | null
          error_code: string | null
          id: string
          impersonation_session_id: string | null
          ip_subnet: unknown
          on_behalf_of: string | null
          outcome: string
          payload: Json | null
          trace_id: string
          workspace_id: string | null
        }
        Insert: {
          action: string
          actor_user_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          error_code?: string | null
          id?: string
          impersonation_session_id?: string | null
          ip_subnet?: unknown
          on_behalf_of?: string | null
          outcome: string
          payload?: Json | null
          trace_id: string
          workspace_id?: string | null
        }
        Update: {
          action?: string
          actor_user_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          error_code?: string | null
          id?: string
          impersonation_session_id?: string | null
          ip_subnet?: unknown
          on_behalf_of?: string | null
          outcome?: string
          payload?: Json | null
          trace_id?: string
          workspace_id?: string | null
        }
        Relationships: []
      }
      audit_log_2026_06: {
        Row: {
          action: string
          actor_user_id: string | null
          created_at: string
          entity_id: string | null
          entity_type: string | null
          error_code: string | null
          id: string
          impersonation_session_id: string | null
          ip_subnet: unknown
          on_behalf_of: string | null
          outcome: string
          payload: Json | null
          trace_id: string
          workspace_id: string | null
        }
        Insert: {
          action: string
          actor_user_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          error_code?: string | null
          id?: string
          impersonation_session_id?: string | null
          ip_subnet?: unknown
          on_behalf_of?: string | null
          outcome: string
          payload?: Json | null
          trace_id: string
          workspace_id?: string | null
        }
        Update: {
          action?: string
          actor_user_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          error_code?: string | null
          id?: string
          impersonation_session_id?: string | null
          ip_subnet?: unknown
          on_behalf_of?: string | null
          outcome?: string
          payload?: Json | null
          trace_id?: string
          workspace_id?: string | null
        }
        Relationships: []
      }
      audit_log_2026_07: {
        Row: {
          action: string
          actor_user_id: string | null
          created_at: string
          entity_id: string | null
          entity_type: string | null
          error_code: string | null
          id: string
          impersonation_session_id: string | null
          ip_subnet: unknown
          on_behalf_of: string | null
          outcome: string
          payload: Json | null
          trace_id: string
          workspace_id: string | null
        }
        Insert: {
          action: string
          actor_user_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          error_code?: string | null
          id?: string
          impersonation_session_id?: string | null
          ip_subnet?: unknown
          on_behalf_of?: string | null
          outcome: string
          payload?: Json | null
          trace_id: string
          workspace_id?: string | null
        }
        Update: {
          action?: string
          actor_user_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          error_code?: string | null
          id?: string
          impersonation_session_id?: string | null
          ip_subnet?: unknown
          on_behalf_of?: string | null
          outcome?: string
          payload?: Json | null
          trace_id?: string
          workspace_id?: string | null
        }
        Relationships: []
      }
      audit_log_2026_08: {
        Row: {
          action: string
          actor_user_id: string | null
          created_at: string
          entity_id: string | null
          entity_type: string | null
          error_code: string | null
          id: string
          impersonation_session_id: string | null
          ip_subnet: unknown
          on_behalf_of: string | null
          outcome: string
          payload: Json | null
          trace_id: string
          workspace_id: string | null
        }
        Insert: {
          action: string
          actor_user_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          error_code?: string | null
          id?: string
          impersonation_session_id?: string | null
          ip_subnet?: unknown
          on_behalf_of?: string | null
          outcome: string
          payload?: Json | null
          trace_id: string
          workspace_id?: string | null
        }
        Update: {
          action?: string
          actor_user_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          error_code?: string | null
          id?: string
          impersonation_session_id?: string | null
          ip_subnet?: unknown
          on_behalf_of?: string | null
          outcome?: string
          payload?: Json | null
          trace_id?: string
          workspace_id?: string | null
        }
        Relationships: []
      }
      audit_log_2026_09: {
        Row: {
          action: string
          actor_user_id: string | null
          created_at: string
          entity_id: string | null
          entity_type: string | null
          error_code: string | null
          id: string
          impersonation_session_id: string | null
          ip_subnet: unknown
          on_behalf_of: string | null
          outcome: string
          payload: Json | null
          trace_id: string
          workspace_id: string | null
        }
        Insert: {
          action: string
          actor_user_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          error_code?: string | null
          id?: string
          impersonation_session_id?: string | null
          ip_subnet?: unknown
          on_behalf_of?: string | null
          outcome: string
          payload?: Json | null
          trace_id: string
          workspace_id?: string | null
        }
        Update: {
          action?: string
          actor_user_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          error_code?: string | null
          id?: string
          impersonation_session_id?: string | null
          ip_subnet?: unknown
          on_behalf_of?: string | null
          outcome?: string
          payload?: Json | null
          trace_id?: string
          workspace_id?: string | null
        }
        Relationships: []
      }
      audit_log_2026_10: {
        Row: {
          action: string
          actor_user_id: string | null
          created_at: string
          entity_id: string | null
          entity_type: string | null
          error_code: string | null
          id: string
          impersonation_session_id: string | null
          ip_subnet: unknown
          on_behalf_of: string | null
          outcome: string
          payload: Json | null
          trace_id: string
          workspace_id: string | null
        }
        Insert: {
          action: string
          actor_user_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          error_code?: string | null
          id?: string
          impersonation_session_id?: string | null
          ip_subnet?: unknown
          on_behalf_of?: string | null
          outcome: string
          payload?: Json | null
          trace_id: string
          workspace_id?: string | null
        }
        Update: {
          action?: string
          actor_user_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          error_code?: string | null
          id?: string
          impersonation_session_id?: string | null
          ip_subnet?: unknown
          on_behalf_of?: string | null
          outcome?: string
          payload?: Json | null
          trace_id?: string
          workspace_id?: string | null
        }
        Relationships: []
      }
      audit_log_2026_11: {
        Row: {
          action: string
          actor_user_id: string | null
          created_at: string
          entity_id: string | null
          entity_type: string | null
          error_code: string | null
          id: string
          impersonation_session_id: string | null
          ip_subnet: unknown
          on_behalf_of: string | null
          outcome: string
          payload: Json | null
          trace_id: string
          workspace_id: string | null
        }
        Insert: {
          action: string
          actor_user_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          error_code?: string | null
          id?: string
          impersonation_session_id?: string | null
          ip_subnet?: unknown
          on_behalf_of?: string | null
          outcome: string
          payload?: Json | null
          trace_id: string
          workspace_id?: string | null
        }
        Update: {
          action?: string
          actor_user_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          error_code?: string | null
          id?: string
          impersonation_session_id?: string | null
          ip_subnet?: unknown
          on_behalf_of?: string | null
          outcome?: string
          payload?: Json | null
          trace_id?: string
          workspace_id?: string | null
        }
        Relationships: []
      }
      audit_log_2026_12: {
        Row: {
          action: string
          actor_user_id: string | null
          created_at: string
          entity_id: string | null
          entity_type: string | null
          error_code: string | null
          id: string
          impersonation_session_id: string | null
          ip_subnet: unknown
          on_behalf_of: string | null
          outcome: string
          payload: Json | null
          trace_id: string
          workspace_id: string | null
        }
        Insert: {
          action: string
          actor_user_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          error_code?: string | null
          id?: string
          impersonation_session_id?: string | null
          ip_subnet?: unknown
          on_behalf_of?: string | null
          outcome: string
          payload?: Json | null
          trace_id: string
          workspace_id?: string | null
        }
        Update: {
          action?: string
          actor_user_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          error_code?: string | null
          id?: string
          impersonation_session_id?: string | null
          ip_subnet?: unknown
          on_behalf_of?: string | null
          outcome?: string
          payload?: Json | null
          trace_id?: string
          workspace_id?: string | null
        }
        Relationships: []
      }
      audit_log_2027_01: {
        Row: {
          action: string
          actor_user_id: string | null
          created_at: string
          entity_id: string | null
          entity_type: string | null
          error_code: string | null
          id: string
          impersonation_session_id: string | null
          ip_subnet: unknown
          on_behalf_of: string | null
          outcome: string
          payload: Json | null
          trace_id: string
          workspace_id: string | null
        }
        Insert: {
          action: string
          actor_user_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          error_code?: string | null
          id?: string
          impersonation_session_id?: string | null
          ip_subnet?: unknown
          on_behalf_of?: string | null
          outcome: string
          payload?: Json | null
          trace_id: string
          workspace_id?: string | null
        }
        Update: {
          action?: string
          actor_user_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          error_code?: string | null
          id?: string
          impersonation_session_id?: string | null
          ip_subnet?: unknown
          on_behalf_of?: string | null
          outcome?: string
          payload?: Json | null
          trace_id?: string
          workspace_id?: string | null
        }
        Relationships: []
      }
      audit_log_2027_02: {
        Row: {
          action: string
          actor_user_id: string | null
          created_at: string
          entity_id: string | null
          entity_type: string | null
          error_code: string | null
          id: string
          impersonation_session_id: string | null
          ip_subnet: unknown
          on_behalf_of: string | null
          outcome: string
          payload: Json | null
          trace_id: string
          workspace_id: string | null
        }
        Insert: {
          action: string
          actor_user_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          error_code?: string | null
          id?: string
          impersonation_session_id?: string | null
          ip_subnet?: unknown
          on_behalf_of?: string | null
          outcome: string
          payload?: Json | null
          trace_id: string
          workspace_id?: string | null
        }
        Update: {
          action?: string
          actor_user_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          error_code?: string | null
          id?: string
          impersonation_session_id?: string | null
          ip_subnet?: unknown
          on_behalf_of?: string | null
          outcome?: string
          payload?: Json | null
          trace_id?: string
          workspace_id?: string | null
        }
        Relationships: []
      }
      audit_log_2027_03: {
        Row: {
          action: string
          actor_user_id: string | null
          created_at: string
          entity_id: string | null
          entity_type: string | null
          error_code: string | null
          id: string
          impersonation_session_id: string | null
          ip_subnet: unknown
          on_behalf_of: string | null
          outcome: string
          payload: Json | null
          trace_id: string
          workspace_id: string | null
        }
        Insert: {
          action: string
          actor_user_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          error_code?: string | null
          id?: string
          impersonation_session_id?: string | null
          ip_subnet?: unknown
          on_behalf_of?: string | null
          outcome: string
          payload?: Json | null
          trace_id: string
          workspace_id?: string | null
        }
        Update: {
          action?: string
          actor_user_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          error_code?: string | null
          id?: string
          impersonation_session_id?: string | null
          ip_subnet?: unknown
          on_behalf_of?: string | null
          outcome?: string
          payload?: Json | null
          trace_id?: string
          workspace_id?: string | null
        }
        Relationships: []
      }
      audit_log_2027_04: {
        Row: {
          action: string
          actor_user_id: string | null
          created_at: string
          entity_id: string | null
          entity_type: string | null
          error_code: string | null
          id: string
          impersonation_session_id: string | null
          ip_subnet: unknown
          on_behalf_of: string | null
          outcome: string
          payload: Json | null
          trace_id: string
          workspace_id: string | null
        }
        Insert: {
          action: string
          actor_user_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          error_code?: string | null
          id?: string
          impersonation_session_id?: string | null
          ip_subnet?: unknown
          on_behalf_of?: string | null
          outcome: string
          payload?: Json | null
          trace_id: string
          workspace_id?: string | null
        }
        Update: {
          action?: string
          actor_user_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          error_code?: string | null
          id?: string
          impersonation_session_id?: string | null
          ip_subnet?: unknown
          on_behalf_of?: string | null
          outcome?: string
          payload?: Json | null
          trace_id?: string
          workspace_id?: string | null
        }
        Relationships: []
      }
      audit_log_2027_05: {
        Row: {
          action: string
          actor_user_id: string | null
          created_at: string
          entity_id: string | null
          entity_type: string | null
          error_code: string | null
          id: string
          impersonation_session_id: string | null
          ip_subnet: unknown
          on_behalf_of: string | null
          outcome: string
          payload: Json | null
          trace_id: string
          workspace_id: string | null
        }
        Insert: {
          action: string
          actor_user_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          error_code?: string | null
          id?: string
          impersonation_session_id?: string | null
          ip_subnet?: unknown
          on_behalf_of?: string | null
          outcome: string
          payload?: Json | null
          trace_id: string
          workspace_id?: string | null
        }
        Update: {
          action?: string
          actor_user_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          error_code?: string | null
          id?: string
          impersonation_session_id?: string | null
          ip_subnet?: unknown
          on_behalf_of?: string | null
          outcome?: string
          payload?: Json | null
          trace_id?: string
          workspace_id?: string | null
        }
        Relationships: []
      }
      audit_log_2027_06: {
        Row: {
          action: string
          actor_user_id: string | null
          created_at: string
          entity_id: string | null
          entity_type: string | null
          error_code: string | null
          id: string
          impersonation_session_id: string | null
          ip_subnet: unknown
          on_behalf_of: string | null
          outcome: string
          payload: Json | null
          trace_id: string
          workspace_id: string | null
        }
        Insert: {
          action: string
          actor_user_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          error_code?: string | null
          id?: string
          impersonation_session_id?: string | null
          ip_subnet?: unknown
          on_behalf_of?: string | null
          outcome: string
          payload?: Json | null
          trace_id: string
          workspace_id?: string | null
        }
        Update: {
          action?: string
          actor_user_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          error_code?: string | null
          id?: string
          impersonation_session_id?: string | null
          ip_subnet?: unknown
          on_behalf_of?: string | null
          outcome?: string
          payload?: Json | null
          trace_id?: string
          workspace_id?: string | null
        }
        Relationships: []
      }
      audit_log_2027_07: {
        Row: {
          action: string
          actor_user_id: string | null
          created_at: string
          entity_id: string | null
          entity_type: string | null
          error_code: string | null
          id: string
          impersonation_session_id: string | null
          ip_subnet: unknown
          on_behalf_of: string | null
          outcome: string
          payload: Json | null
          trace_id: string
          workspace_id: string | null
        }
        Insert: {
          action: string
          actor_user_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          error_code?: string | null
          id?: string
          impersonation_session_id?: string | null
          ip_subnet?: unknown
          on_behalf_of?: string | null
          outcome: string
          payload?: Json | null
          trace_id: string
          workspace_id?: string | null
        }
        Update: {
          action?: string
          actor_user_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          error_code?: string | null
          id?: string
          impersonation_session_id?: string | null
          ip_subnet?: unknown
          on_behalf_of?: string | null
          outcome?: string
          payload?: Json | null
          trace_id?: string
          workspace_id?: string | null
        }
        Relationships: []
      }
      audit_log_2027_08: {
        Row: {
          action: string
          actor_user_id: string | null
          created_at: string
          entity_id: string | null
          entity_type: string | null
          error_code: string | null
          id: string
          impersonation_session_id: string | null
          ip_subnet: unknown
          on_behalf_of: string | null
          outcome: string
          payload: Json | null
          trace_id: string
          workspace_id: string | null
        }
        Insert: {
          action: string
          actor_user_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          error_code?: string | null
          id?: string
          impersonation_session_id?: string | null
          ip_subnet?: unknown
          on_behalf_of?: string | null
          outcome: string
          payload?: Json | null
          trace_id: string
          workspace_id?: string | null
        }
        Update: {
          action?: string
          actor_user_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          error_code?: string | null
          id?: string
          impersonation_session_id?: string | null
          ip_subnet?: unknown
          on_behalf_of?: string | null
          outcome?: string
          payload?: Json | null
          trace_id?: string
          workspace_id?: string | null
        }
        Relationships: []
      }
      audit_log_2027_09: {
        Row: {
          action: string
          actor_user_id: string | null
          created_at: string
          entity_id: string | null
          entity_type: string | null
          error_code: string | null
          id: string
          impersonation_session_id: string | null
          ip_subnet: unknown
          on_behalf_of: string | null
          outcome: string
          payload: Json | null
          trace_id: string
          workspace_id: string | null
        }
        Insert: {
          action: string
          actor_user_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          error_code?: string | null
          id?: string
          impersonation_session_id?: string | null
          ip_subnet?: unknown
          on_behalf_of?: string | null
          outcome: string
          payload?: Json | null
          trace_id: string
          workspace_id?: string | null
        }
        Update: {
          action?: string
          actor_user_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          error_code?: string | null
          id?: string
          impersonation_session_id?: string | null
          ip_subnet?: unknown
          on_behalf_of?: string | null
          outcome?: string
          payload?: Json | null
          trace_id?: string
          workspace_id?: string | null
        }
        Relationships: []
      }
      audit_log_2027_10: {
        Row: {
          action: string
          actor_user_id: string | null
          created_at: string
          entity_id: string | null
          entity_type: string | null
          error_code: string | null
          id: string
          impersonation_session_id: string | null
          ip_subnet: unknown
          on_behalf_of: string | null
          outcome: string
          payload: Json | null
          trace_id: string
          workspace_id: string | null
        }
        Insert: {
          action: string
          actor_user_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          error_code?: string | null
          id?: string
          impersonation_session_id?: string | null
          ip_subnet?: unknown
          on_behalf_of?: string | null
          outcome: string
          payload?: Json | null
          trace_id: string
          workspace_id?: string | null
        }
        Update: {
          action?: string
          actor_user_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          error_code?: string | null
          id?: string
          impersonation_session_id?: string | null
          ip_subnet?: unknown
          on_behalf_of?: string | null
          outcome?: string
          payload?: Json | null
          trace_id?: string
          workspace_id?: string | null
        }
        Relationships: []
      }
      audit_log_2027_11: {
        Row: {
          action: string
          actor_user_id: string | null
          created_at: string
          entity_id: string | null
          entity_type: string | null
          error_code: string | null
          id: string
          impersonation_session_id: string | null
          ip_subnet: unknown
          on_behalf_of: string | null
          outcome: string
          payload: Json | null
          trace_id: string
          workspace_id: string | null
        }
        Insert: {
          action: string
          actor_user_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          error_code?: string | null
          id?: string
          impersonation_session_id?: string | null
          ip_subnet?: unknown
          on_behalf_of?: string | null
          outcome: string
          payload?: Json | null
          trace_id: string
          workspace_id?: string | null
        }
        Update: {
          action?: string
          actor_user_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          error_code?: string | null
          id?: string
          impersonation_session_id?: string | null
          ip_subnet?: unknown
          on_behalf_of?: string | null
          outcome?: string
          payload?: Json | null
          trace_id?: string
          workspace_id?: string | null
        }
        Relationships: []
      }
      audit_log_2027_12: {
        Row: {
          action: string
          actor_user_id: string | null
          created_at: string
          entity_id: string | null
          entity_type: string | null
          error_code: string | null
          id: string
          impersonation_session_id: string | null
          ip_subnet: unknown
          on_behalf_of: string | null
          outcome: string
          payload: Json | null
          trace_id: string
          workspace_id: string | null
        }
        Insert: {
          action: string
          actor_user_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          error_code?: string | null
          id?: string
          impersonation_session_id?: string | null
          ip_subnet?: unknown
          on_behalf_of?: string | null
          outcome: string
          payload?: Json | null
          trace_id: string
          workspace_id?: string | null
        }
        Update: {
          action?: string
          actor_user_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          error_code?: string | null
          id?: string
          impersonation_session_id?: string | null
          ip_subnet?: unknown
          on_behalf_of?: string | null
          outcome?: string
          payload?: Json | null
          trace_id?: string
          workspace_id?: string | null
        }
        Relationships: []
      }
      audit_log_2028_01: {
        Row: {
          action: string
          actor_user_id: string | null
          created_at: string
          entity_id: string | null
          entity_type: string | null
          error_code: string | null
          id: string
          impersonation_session_id: string | null
          ip_subnet: unknown
          on_behalf_of: string | null
          outcome: string
          payload: Json | null
          trace_id: string
          workspace_id: string | null
        }
        Insert: {
          action: string
          actor_user_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          error_code?: string | null
          id?: string
          impersonation_session_id?: string | null
          ip_subnet?: unknown
          on_behalf_of?: string | null
          outcome: string
          payload?: Json | null
          trace_id: string
          workspace_id?: string | null
        }
        Update: {
          action?: string
          actor_user_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          error_code?: string | null
          id?: string
          impersonation_session_id?: string | null
          ip_subnet?: unknown
          on_behalf_of?: string | null
          outcome?: string
          payload?: Json | null
          trace_id?: string
          workspace_id?: string | null
        }
        Relationships: []
      }
      audit_log_2028_02: {
        Row: {
          action: string
          actor_user_id: string | null
          created_at: string
          entity_id: string | null
          entity_type: string | null
          error_code: string | null
          id: string
          impersonation_session_id: string | null
          ip_subnet: unknown
          on_behalf_of: string | null
          outcome: string
          payload: Json | null
          trace_id: string
          workspace_id: string | null
        }
        Insert: {
          action: string
          actor_user_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          error_code?: string | null
          id?: string
          impersonation_session_id?: string | null
          ip_subnet?: unknown
          on_behalf_of?: string | null
          outcome: string
          payload?: Json | null
          trace_id: string
          workspace_id?: string | null
        }
        Update: {
          action?: string
          actor_user_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          error_code?: string | null
          id?: string
          impersonation_session_id?: string | null
          ip_subnet?: unknown
          on_behalf_of?: string | null
          outcome?: string
          payload?: Json | null
          trace_id?: string
          workspace_id?: string | null
        }
        Relationships: []
      }
      audit_log_2028_03: {
        Row: {
          action: string
          actor_user_id: string | null
          created_at: string
          entity_id: string | null
          entity_type: string | null
          error_code: string | null
          id: string
          impersonation_session_id: string | null
          ip_subnet: unknown
          on_behalf_of: string | null
          outcome: string
          payload: Json | null
          trace_id: string
          workspace_id: string | null
        }
        Insert: {
          action: string
          actor_user_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          error_code?: string | null
          id?: string
          impersonation_session_id?: string | null
          ip_subnet?: unknown
          on_behalf_of?: string | null
          outcome: string
          payload?: Json | null
          trace_id: string
          workspace_id?: string | null
        }
        Update: {
          action?: string
          actor_user_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          error_code?: string | null
          id?: string
          impersonation_session_id?: string | null
          ip_subnet?: unknown
          on_behalf_of?: string | null
          outcome?: string
          payload?: Json | null
          trace_id?: string
          workspace_id?: string | null
        }
        Relationships: []
      }
      audit_log_2028_04: {
        Row: {
          action: string
          actor_user_id: string | null
          created_at: string
          entity_id: string | null
          entity_type: string | null
          error_code: string | null
          id: string
          impersonation_session_id: string | null
          ip_subnet: unknown
          on_behalf_of: string | null
          outcome: string
          payload: Json | null
          trace_id: string
          workspace_id: string | null
        }
        Insert: {
          action: string
          actor_user_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          error_code?: string | null
          id?: string
          impersonation_session_id?: string | null
          ip_subnet?: unknown
          on_behalf_of?: string | null
          outcome: string
          payload?: Json | null
          trace_id: string
          workspace_id?: string | null
        }
        Update: {
          action?: string
          actor_user_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          error_code?: string | null
          id?: string
          impersonation_session_id?: string | null
          ip_subnet?: unknown
          on_behalf_of?: string | null
          outcome?: string
          payload?: Json | null
          trace_id?: string
          workspace_id?: string | null
        }
        Relationships: []
      }
      audit_log_2028_05: {
        Row: {
          action: string
          actor_user_id: string | null
          created_at: string
          entity_id: string | null
          entity_type: string | null
          error_code: string | null
          id: string
          impersonation_session_id: string | null
          ip_subnet: unknown
          on_behalf_of: string | null
          outcome: string
          payload: Json | null
          trace_id: string
          workspace_id: string | null
        }
        Insert: {
          action: string
          actor_user_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          error_code?: string | null
          id?: string
          impersonation_session_id?: string | null
          ip_subnet?: unknown
          on_behalf_of?: string | null
          outcome: string
          payload?: Json | null
          trace_id: string
          workspace_id?: string | null
        }
        Update: {
          action?: string
          actor_user_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          error_code?: string | null
          id?: string
          impersonation_session_id?: string | null
          ip_subnet?: unknown
          on_behalf_of?: string | null
          outcome?: string
          payload?: Json | null
          trace_id?: string
          workspace_id?: string | null
        }
        Relationships: []
      }
      audit_log_2028_06: {
        Row: {
          action: string
          actor_user_id: string | null
          created_at: string
          entity_id: string | null
          entity_type: string | null
          error_code: string | null
          id: string
          impersonation_session_id: string | null
          ip_subnet: unknown
          on_behalf_of: string | null
          outcome: string
          payload: Json | null
          trace_id: string
          workspace_id: string | null
        }
        Insert: {
          action: string
          actor_user_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          error_code?: string | null
          id?: string
          impersonation_session_id?: string | null
          ip_subnet?: unknown
          on_behalf_of?: string | null
          outcome: string
          payload?: Json | null
          trace_id: string
          workspace_id?: string | null
        }
        Update: {
          action?: string
          actor_user_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          error_code?: string | null
          id?: string
          impersonation_session_id?: string | null
          ip_subnet?: unknown
          on_behalf_of?: string | null
          outcome?: string
          payload?: Json | null
          trace_id?: string
          workspace_id?: string | null
        }
        Relationships: []
      }
      audit_log_2028_07: {
        Row: {
          action: string
          actor_user_id: string | null
          created_at: string
          entity_id: string | null
          entity_type: string | null
          error_code: string | null
          id: string
          impersonation_session_id: string | null
          ip_subnet: unknown
          on_behalf_of: string | null
          outcome: string
          payload: Json | null
          trace_id: string
          workspace_id: string | null
        }
        Insert: {
          action: string
          actor_user_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          error_code?: string | null
          id?: string
          impersonation_session_id?: string | null
          ip_subnet?: unknown
          on_behalf_of?: string | null
          outcome: string
          payload?: Json | null
          trace_id: string
          workspace_id?: string | null
        }
        Update: {
          action?: string
          actor_user_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          error_code?: string | null
          id?: string
          impersonation_session_id?: string | null
          ip_subnet?: unknown
          on_behalf_of?: string | null
          outcome?: string
          payload?: Json | null
          trace_id?: string
          workspace_id?: string | null
        }
        Relationships: []
      }
      audit_log_2028_08: {
        Row: {
          action: string
          actor_user_id: string | null
          created_at: string
          entity_id: string | null
          entity_type: string | null
          error_code: string | null
          id: string
          impersonation_session_id: string | null
          ip_subnet: unknown
          on_behalf_of: string | null
          outcome: string
          payload: Json | null
          trace_id: string
          workspace_id: string | null
        }
        Insert: {
          action: string
          actor_user_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          error_code?: string | null
          id?: string
          impersonation_session_id?: string | null
          ip_subnet?: unknown
          on_behalf_of?: string | null
          outcome: string
          payload?: Json | null
          trace_id: string
          workspace_id?: string | null
        }
        Update: {
          action?: string
          actor_user_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          error_code?: string | null
          id?: string
          impersonation_session_id?: string | null
          ip_subnet?: unknown
          on_behalf_of?: string | null
          outcome?: string
          payload?: Json | null
          trace_id?: string
          workspace_id?: string | null
        }
        Relationships: []
      }
      audit_log_2028_09: {
        Row: {
          action: string
          actor_user_id: string | null
          created_at: string
          entity_id: string | null
          entity_type: string | null
          error_code: string | null
          id: string
          impersonation_session_id: string | null
          ip_subnet: unknown
          on_behalf_of: string | null
          outcome: string
          payload: Json | null
          trace_id: string
          workspace_id: string | null
        }
        Insert: {
          action: string
          actor_user_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          error_code?: string | null
          id?: string
          impersonation_session_id?: string | null
          ip_subnet?: unknown
          on_behalf_of?: string | null
          outcome: string
          payload?: Json | null
          trace_id: string
          workspace_id?: string | null
        }
        Update: {
          action?: string
          actor_user_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          error_code?: string | null
          id?: string
          impersonation_session_id?: string | null
          ip_subnet?: unknown
          on_behalf_of?: string | null
          outcome?: string
          payload?: Json | null
          trace_id?: string
          workspace_id?: string | null
        }
        Relationships: []
      }
      audit_log_2028_10: {
        Row: {
          action: string
          actor_user_id: string | null
          created_at: string
          entity_id: string | null
          entity_type: string | null
          error_code: string | null
          id: string
          impersonation_session_id: string | null
          ip_subnet: unknown
          on_behalf_of: string | null
          outcome: string
          payload: Json | null
          trace_id: string
          workspace_id: string | null
        }
        Insert: {
          action: string
          actor_user_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          error_code?: string | null
          id?: string
          impersonation_session_id?: string | null
          ip_subnet?: unknown
          on_behalf_of?: string | null
          outcome: string
          payload?: Json | null
          trace_id: string
          workspace_id?: string | null
        }
        Update: {
          action?: string
          actor_user_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          error_code?: string | null
          id?: string
          impersonation_session_id?: string | null
          ip_subnet?: unknown
          on_behalf_of?: string | null
          outcome?: string
          payload?: Json | null
          trace_id?: string
          workspace_id?: string | null
        }
        Relationships: []
      }
      audit_log_2028_11: {
        Row: {
          action: string
          actor_user_id: string | null
          created_at: string
          entity_id: string | null
          entity_type: string | null
          error_code: string | null
          id: string
          impersonation_session_id: string | null
          ip_subnet: unknown
          on_behalf_of: string | null
          outcome: string
          payload: Json | null
          trace_id: string
          workspace_id: string | null
        }
        Insert: {
          action: string
          actor_user_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          error_code?: string | null
          id?: string
          impersonation_session_id?: string | null
          ip_subnet?: unknown
          on_behalf_of?: string | null
          outcome: string
          payload?: Json | null
          trace_id: string
          workspace_id?: string | null
        }
        Update: {
          action?: string
          actor_user_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          error_code?: string | null
          id?: string
          impersonation_session_id?: string | null
          ip_subnet?: unknown
          on_behalf_of?: string | null
          outcome?: string
          payload?: Json | null
          trace_id?: string
          workspace_id?: string | null
        }
        Relationships: []
      }
      audit_log_2028_12: {
        Row: {
          action: string
          actor_user_id: string | null
          created_at: string
          entity_id: string | null
          entity_type: string | null
          error_code: string | null
          id: string
          impersonation_session_id: string | null
          ip_subnet: unknown
          on_behalf_of: string | null
          outcome: string
          payload: Json | null
          trace_id: string
          workspace_id: string | null
        }
        Insert: {
          action: string
          actor_user_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          error_code?: string | null
          id?: string
          impersonation_session_id?: string | null
          ip_subnet?: unknown
          on_behalf_of?: string | null
          outcome: string
          payload?: Json | null
          trace_id: string
          workspace_id?: string | null
        }
        Update: {
          action?: string
          actor_user_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          error_code?: string | null
          id?: string
          impersonation_session_id?: string | null
          ip_subnet?: unknown
          on_behalf_of?: string | null
          outcome?: string
          payload?: Json | null
          trace_id?: string
          workspace_id?: string | null
        }
        Relationships: []
      }
      audit_log_default: {
        Row: {
          action: string
          actor_user_id: string | null
          created_at: string
          entity_id: string | null
          entity_type: string | null
          error_code: string | null
          id: string
          impersonation_session_id: string | null
          ip_subnet: unknown
          on_behalf_of: string | null
          outcome: string
          payload: Json | null
          trace_id: string
          workspace_id: string | null
        }
        Insert: {
          action: string
          actor_user_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          error_code?: string | null
          id?: string
          impersonation_session_id?: string | null
          ip_subnet?: unknown
          on_behalf_of?: string | null
          outcome: string
          payload?: Json | null
          trace_id: string
          workspace_id?: string | null
        }
        Update: {
          action?: string
          actor_user_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          error_code?: string | null
          id?: string
          impersonation_session_id?: string | null
          ip_subnet?: unknown
          on_behalf_of?: string | null
          outcome?: string
          payload?: Json | null
          trace_id?: string
          workspace_id?: string | null
        }
        Relationships: []
      }
      briefs: {
        Row: {
          brand_requirements: string | null
          closed_at: string | null
          closed_by: string | null
          created_at: string
          created_by: string | null
          created_via: string
          deleted_at: string | null
          format_requested: string | null
          id: string
          legacy_author_name: string | null
          mentions: Json | null
          number: number
          objective: string
          reference_links: Json | null
          row_version: number
          status: string
          target_date: string | null
          title: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          brand_requirements?: string | null
          closed_at?: string | null
          closed_by?: string | null
          created_at?: string
          created_by?: string | null
          created_via?: string
          deleted_at?: string | null
          format_requested?: string | null
          id?: string
          legacy_author_name?: string | null
          mentions?: Json | null
          number: number
          objective: string
          reference_links?: Json | null
          row_version?: number
          status?: string
          target_date?: string | null
          title: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          brand_requirements?: string | null
          closed_at?: string | null
          closed_by?: string | null
          created_at?: string
          created_by?: string | null
          created_via?: string
          deleted_at?: string | null
          format_requested?: string | null
          id?: string
          legacy_author_name?: string | null
          mentions?: Json | null
          number?: number
          objective?: string
          reference_links?: Json | null
          row_version?: number
          status?: string
          target_date?: string | null
          title?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "briefs_closed_by_fkey"
            columns: ["closed_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "briefs_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "briefs_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      chat_channels: {
        Row: {
          agora_group_id: string | null
          channel_id: string
          channel_type: string
          created_at: string
          dm_user_a: string | null
          dm_user_b: string | null
          entity_id: string | null
          last_synced_at: string | null
          workspace_id: string
        }
        Insert: {
          agora_group_id?: string | null
          channel_id: string
          channel_type: string
          created_at?: string
          dm_user_a?: string | null
          dm_user_b?: string | null
          entity_id?: string | null
          last_synced_at?: string | null
          workspace_id: string
        }
        Update: {
          agora_group_id?: string | null
          channel_id?: string
          channel_type?: string
          created_at?: string
          dm_user_a?: string | null
          dm_user_b?: string | null
          entity_id?: string | null
          last_synced_at?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "chat_channels_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      chat_messages: {
        Row: {
          agora_event_id: string
          attachment_asset_ids: string[] | null
          body: string | null
          channel_id: string
          created_at: string
          deleted_at: string | null
          edited_at: string | null
          id: string
          mentions: Json | null
          sender_user_id: string | null
          workspace_id: string
        }
        Insert: {
          agora_event_id: string
          attachment_asset_ids?: string[] | null
          body?: string | null
          channel_id: string
          created_at: string
          deleted_at?: string | null
          edited_at?: string | null
          id: string
          mentions?: Json | null
          sender_user_id?: string | null
          workspace_id: string
        }
        Update: {
          agora_event_id?: string
          attachment_asset_ids?: string[] | null
          body?: string | null
          channel_id?: string
          created_at?: string
          deleted_at?: string | null
          edited_at?: string | null
          id?: string
          mentions?: Json | null
          sender_user_id?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "chat_messages_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: false
            referencedRelation: "chat_channels"
            referencedColumns: ["channel_id"]
          },
          {
            foreignKeyName: "chat_messages_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      chat_messages_2026_05: {
        Row: {
          agora_event_id: string
          attachment_asset_ids: string[] | null
          body: string | null
          channel_id: string
          created_at: string
          deleted_at: string | null
          edited_at: string | null
          id: string
          mentions: Json | null
          sender_user_id: string | null
          workspace_id: string
        }
        Insert: {
          agora_event_id: string
          attachment_asset_ids?: string[] | null
          body?: string | null
          channel_id: string
          created_at: string
          deleted_at?: string | null
          edited_at?: string | null
          id: string
          mentions?: Json | null
          sender_user_id?: string | null
          workspace_id: string
        }
        Update: {
          agora_event_id?: string
          attachment_asset_ids?: string[] | null
          body?: string | null
          channel_id?: string
          created_at?: string
          deleted_at?: string | null
          edited_at?: string | null
          id?: string
          mentions?: Json | null
          sender_user_id?: string | null
          workspace_id?: string
        }
        Relationships: []
      }
      chat_messages_2026_06: {
        Row: {
          agora_event_id: string
          attachment_asset_ids: string[] | null
          body: string | null
          channel_id: string
          created_at: string
          deleted_at: string | null
          edited_at: string | null
          id: string
          mentions: Json | null
          sender_user_id: string | null
          workspace_id: string
        }
        Insert: {
          agora_event_id: string
          attachment_asset_ids?: string[] | null
          body?: string | null
          channel_id: string
          created_at: string
          deleted_at?: string | null
          edited_at?: string | null
          id: string
          mentions?: Json | null
          sender_user_id?: string | null
          workspace_id: string
        }
        Update: {
          agora_event_id?: string
          attachment_asset_ids?: string[] | null
          body?: string | null
          channel_id?: string
          created_at?: string
          deleted_at?: string | null
          edited_at?: string | null
          id?: string
          mentions?: Json | null
          sender_user_id?: string | null
          workspace_id?: string
        }
        Relationships: []
      }
      chat_messages_2026_07: {
        Row: {
          agora_event_id: string
          attachment_asset_ids: string[] | null
          body: string | null
          channel_id: string
          created_at: string
          deleted_at: string | null
          edited_at: string | null
          id: string
          mentions: Json | null
          sender_user_id: string | null
          workspace_id: string
        }
        Insert: {
          agora_event_id: string
          attachment_asset_ids?: string[] | null
          body?: string | null
          channel_id: string
          created_at: string
          deleted_at?: string | null
          edited_at?: string | null
          id: string
          mentions?: Json | null
          sender_user_id?: string | null
          workspace_id: string
        }
        Update: {
          agora_event_id?: string
          attachment_asset_ids?: string[] | null
          body?: string | null
          channel_id?: string
          created_at?: string
          deleted_at?: string | null
          edited_at?: string | null
          id?: string
          mentions?: Json | null
          sender_user_id?: string | null
          workspace_id?: string
        }
        Relationships: []
      }
      chat_messages_2026_08: {
        Row: {
          agora_event_id: string
          attachment_asset_ids: string[] | null
          body: string | null
          channel_id: string
          created_at: string
          deleted_at: string | null
          edited_at: string | null
          id: string
          mentions: Json | null
          sender_user_id: string | null
          workspace_id: string
        }
        Insert: {
          agora_event_id: string
          attachment_asset_ids?: string[] | null
          body?: string | null
          channel_id: string
          created_at: string
          deleted_at?: string | null
          edited_at?: string | null
          id: string
          mentions?: Json | null
          sender_user_id?: string | null
          workspace_id: string
        }
        Update: {
          agora_event_id?: string
          attachment_asset_ids?: string[] | null
          body?: string | null
          channel_id?: string
          created_at?: string
          deleted_at?: string | null
          edited_at?: string | null
          id?: string
          mentions?: Json | null
          sender_user_id?: string | null
          workspace_id?: string
        }
        Relationships: []
      }
      chat_messages_2026_09: {
        Row: {
          agora_event_id: string
          attachment_asset_ids: string[] | null
          body: string | null
          channel_id: string
          created_at: string
          deleted_at: string | null
          edited_at: string | null
          id: string
          mentions: Json | null
          sender_user_id: string | null
          workspace_id: string
        }
        Insert: {
          agora_event_id: string
          attachment_asset_ids?: string[] | null
          body?: string | null
          channel_id: string
          created_at: string
          deleted_at?: string | null
          edited_at?: string | null
          id: string
          mentions?: Json | null
          sender_user_id?: string | null
          workspace_id: string
        }
        Update: {
          agora_event_id?: string
          attachment_asset_ids?: string[] | null
          body?: string | null
          channel_id?: string
          created_at?: string
          deleted_at?: string | null
          edited_at?: string | null
          id?: string
          mentions?: Json | null
          sender_user_id?: string | null
          workspace_id?: string
        }
        Relationships: []
      }
      chat_messages_2026_10: {
        Row: {
          agora_event_id: string
          attachment_asset_ids: string[] | null
          body: string | null
          channel_id: string
          created_at: string
          deleted_at: string | null
          edited_at: string | null
          id: string
          mentions: Json | null
          sender_user_id: string | null
          workspace_id: string
        }
        Insert: {
          agora_event_id: string
          attachment_asset_ids?: string[] | null
          body?: string | null
          channel_id: string
          created_at: string
          deleted_at?: string | null
          edited_at?: string | null
          id: string
          mentions?: Json | null
          sender_user_id?: string | null
          workspace_id: string
        }
        Update: {
          agora_event_id?: string
          attachment_asset_ids?: string[] | null
          body?: string | null
          channel_id?: string
          created_at?: string
          deleted_at?: string | null
          edited_at?: string | null
          id?: string
          mentions?: Json | null
          sender_user_id?: string | null
          workspace_id?: string
        }
        Relationships: []
      }
      chat_messages_2026_11: {
        Row: {
          agora_event_id: string
          attachment_asset_ids: string[] | null
          body: string | null
          channel_id: string
          created_at: string
          deleted_at: string | null
          edited_at: string | null
          id: string
          mentions: Json | null
          sender_user_id: string | null
          workspace_id: string
        }
        Insert: {
          agora_event_id: string
          attachment_asset_ids?: string[] | null
          body?: string | null
          channel_id: string
          created_at: string
          deleted_at?: string | null
          edited_at?: string | null
          id: string
          mentions?: Json | null
          sender_user_id?: string | null
          workspace_id: string
        }
        Update: {
          agora_event_id?: string
          attachment_asset_ids?: string[] | null
          body?: string | null
          channel_id?: string
          created_at?: string
          deleted_at?: string | null
          edited_at?: string | null
          id?: string
          mentions?: Json | null
          sender_user_id?: string | null
          workspace_id?: string
        }
        Relationships: []
      }
      chat_messages_2026_12: {
        Row: {
          agora_event_id: string
          attachment_asset_ids: string[] | null
          body: string | null
          channel_id: string
          created_at: string
          deleted_at: string | null
          edited_at: string | null
          id: string
          mentions: Json | null
          sender_user_id: string | null
          workspace_id: string
        }
        Insert: {
          agora_event_id: string
          attachment_asset_ids?: string[] | null
          body?: string | null
          channel_id: string
          created_at: string
          deleted_at?: string | null
          edited_at?: string | null
          id: string
          mentions?: Json | null
          sender_user_id?: string | null
          workspace_id: string
        }
        Update: {
          agora_event_id?: string
          attachment_asset_ids?: string[] | null
          body?: string | null
          channel_id?: string
          created_at?: string
          deleted_at?: string | null
          edited_at?: string | null
          id?: string
          mentions?: Json | null
          sender_user_id?: string | null
          workspace_id?: string
        }
        Relationships: []
      }
      chat_messages_2027_01: {
        Row: {
          agora_event_id: string
          attachment_asset_ids: string[] | null
          body: string | null
          channel_id: string
          created_at: string
          deleted_at: string | null
          edited_at: string | null
          id: string
          mentions: Json | null
          sender_user_id: string | null
          workspace_id: string
        }
        Insert: {
          agora_event_id: string
          attachment_asset_ids?: string[] | null
          body?: string | null
          channel_id: string
          created_at: string
          deleted_at?: string | null
          edited_at?: string | null
          id: string
          mentions?: Json | null
          sender_user_id?: string | null
          workspace_id: string
        }
        Update: {
          agora_event_id?: string
          attachment_asset_ids?: string[] | null
          body?: string | null
          channel_id?: string
          created_at?: string
          deleted_at?: string | null
          edited_at?: string | null
          id?: string
          mentions?: Json | null
          sender_user_id?: string | null
          workspace_id?: string
        }
        Relationships: []
      }
      chat_messages_2027_02: {
        Row: {
          agora_event_id: string
          attachment_asset_ids: string[] | null
          body: string | null
          channel_id: string
          created_at: string
          deleted_at: string | null
          edited_at: string | null
          id: string
          mentions: Json | null
          sender_user_id: string | null
          workspace_id: string
        }
        Insert: {
          agora_event_id: string
          attachment_asset_ids?: string[] | null
          body?: string | null
          channel_id: string
          created_at: string
          deleted_at?: string | null
          edited_at?: string | null
          id: string
          mentions?: Json | null
          sender_user_id?: string | null
          workspace_id: string
        }
        Update: {
          agora_event_id?: string
          attachment_asset_ids?: string[] | null
          body?: string | null
          channel_id?: string
          created_at?: string
          deleted_at?: string | null
          edited_at?: string | null
          id?: string
          mentions?: Json | null
          sender_user_id?: string | null
          workspace_id?: string
        }
        Relationships: []
      }
      chat_messages_2027_03: {
        Row: {
          agora_event_id: string
          attachment_asset_ids: string[] | null
          body: string | null
          channel_id: string
          created_at: string
          deleted_at: string | null
          edited_at: string | null
          id: string
          mentions: Json | null
          sender_user_id: string | null
          workspace_id: string
        }
        Insert: {
          agora_event_id: string
          attachment_asset_ids?: string[] | null
          body?: string | null
          channel_id: string
          created_at: string
          deleted_at?: string | null
          edited_at?: string | null
          id: string
          mentions?: Json | null
          sender_user_id?: string | null
          workspace_id: string
        }
        Update: {
          agora_event_id?: string
          attachment_asset_ids?: string[] | null
          body?: string | null
          channel_id?: string
          created_at?: string
          deleted_at?: string | null
          edited_at?: string | null
          id?: string
          mentions?: Json | null
          sender_user_id?: string | null
          workspace_id?: string
        }
        Relationships: []
      }
      chat_messages_2027_04: {
        Row: {
          agora_event_id: string
          attachment_asset_ids: string[] | null
          body: string | null
          channel_id: string
          created_at: string
          deleted_at: string | null
          edited_at: string | null
          id: string
          mentions: Json | null
          sender_user_id: string | null
          workspace_id: string
        }
        Insert: {
          agora_event_id: string
          attachment_asset_ids?: string[] | null
          body?: string | null
          channel_id: string
          created_at: string
          deleted_at?: string | null
          edited_at?: string | null
          id: string
          mentions?: Json | null
          sender_user_id?: string | null
          workspace_id: string
        }
        Update: {
          agora_event_id?: string
          attachment_asset_ids?: string[] | null
          body?: string | null
          channel_id?: string
          created_at?: string
          deleted_at?: string | null
          edited_at?: string | null
          id?: string
          mentions?: Json | null
          sender_user_id?: string | null
          workspace_id?: string
        }
        Relationships: []
      }
      chat_messages_2027_05: {
        Row: {
          agora_event_id: string
          attachment_asset_ids: string[] | null
          body: string | null
          channel_id: string
          created_at: string
          deleted_at: string | null
          edited_at: string | null
          id: string
          mentions: Json | null
          sender_user_id: string | null
          workspace_id: string
        }
        Insert: {
          agora_event_id: string
          attachment_asset_ids?: string[] | null
          body?: string | null
          channel_id: string
          created_at: string
          deleted_at?: string | null
          edited_at?: string | null
          id: string
          mentions?: Json | null
          sender_user_id?: string | null
          workspace_id: string
        }
        Update: {
          agora_event_id?: string
          attachment_asset_ids?: string[] | null
          body?: string | null
          channel_id?: string
          created_at?: string
          deleted_at?: string | null
          edited_at?: string | null
          id?: string
          mentions?: Json | null
          sender_user_id?: string | null
          workspace_id?: string
        }
        Relationships: []
      }
      chat_messages_2027_06: {
        Row: {
          agora_event_id: string
          attachment_asset_ids: string[] | null
          body: string | null
          channel_id: string
          created_at: string
          deleted_at: string | null
          edited_at: string | null
          id: string
          mentions: Json | null
          sender_user_id: string | null
          workspace_id: string
        }
        Insert: {
          agora_event_id: string
          attachment_asset_ids?: string[] | null
          body?: string | null
          channel_id: string
          created_at: string
          deleted_at?: string | null
          edited_at?: string | null
          id: string
          mentions?: Json | null
          sender_user_id?: string | null
          workspace_id: string
        }
        Update: {
          agora_event_id?: string
          attachment_asset_ids?: string[] | null
          body?: string | null
          channel_id?: string
          created_at?: string
          deleted_at?: string | null
          edited_at?: string | null
          id?: string
          mentions?: Json | null
          sender_user_id?: string | null
          workspace_id?: string
        }
        Relationships: []
      }
      chat_messages_2027_07: {
        Row: {
          agora_event_id: string
          attachment_asset_ids: string[] | null
          body: string | null
          channel_id: string
          created_at: string
          deleted_at: string | null
          edited_at: string | null
          id: string
          mentions: Json | null
          sender_user_id: string | null
          workspace_id: string
        }
        Insert: {
          agora_event_id: string
          attachment_asset_ids?: string[] | null
          body?: string | null
          channel_id: string
          created_at: string
          deleted_at?: string | null
          edited_at?: string | null
          id: string
          mentions?: Json | null
          sender_user_id?: string | null
          workspace_id: string
        }
        Update: {
          agora_event_id?: string
          attachment_asset_ids?: string[] | null
          body?: string | null
          channel_id?: string
          created_at?: string
          deleted_at?: string | null
          edited_at?: string | null
          id?: string
          mentions?: Json | null
          sender_user_id?: string | null
          workspace_id?: string
        }
        Relationships: []
      }
      chat_messages_2027_08: {
        Row: {
          agora_event_id: string
          attachment_asset_ids: string[] | null
          body: string | null
          channel_id: string
          created_at: string
          deleted_at: string | null
          edited_at: string | null
          id: string
          mentions: Json | null
          sender_user_id: string | null
          workspace_id: string
        }
        Insert: {
          agora_event_id: string
          attachment_asset_ids?: string[] | null
          body?: string | null
          channel_id: string
          created_at: string
          deleted_at?: string | null
          edited_at?: string | null
          id: string
          mentions?: Json | null
          sender_user_id?: string | null
          workspace_id: string
        }
        Update: {
          agora_event_id?: string
          attachment_asset_ids?: string[] | null
          body?: string | null
          channel_id?: string
          created_at?: string
          deleted_at?: string | null
          edited_at?: string | null
          id?: string
          mentions?: Json | null
          sender_user_id?: string | null
          workspace_id?: string
        }
        Relationships: []
      }
      chat_messages_2027_09: {
        Row: {
          agora_event_id: string
          attachment_asset_ids: string[] | null
          body: string | null
          channel_id: string
          created_at: string
          deleted_at: string | null
          edited_at: string | null
          id: string
          mentions: Json | null
          sender_user_id: string | null
          workspace_id: string
        }
        Insert: {
          agora_event_id: string
          attachment_asset_ids?: string[] | null
          body?: string | null
          channel_id: string
          created_at: string
          deleted_at?: string | null
          edited_at?: string | null
          id: string
          mentions?: Json | null
          sender_user_id?: string | null
          workspace_id: string
        }
        Update: {
          agora_event_id?: string
          attachment_asset_ids?: string[] | null
          body?: string | null
          channel_id?: string
          created_at?: string
          deleted_at?: string | null
          edited_at?: string | null
          id?: string
          mentions?: Json | null
          sender_user_id?: string | null
          workspace_id?: string
        }
        Relationships: []
      }
      chat_messages_2027_10: {
        Row: {
          agora_event_id: string
          attachment_asset_ids: string[] | null
          body: string | null
          channel_id: string
          created_at: string
          deleted_at: string | null
          edited_at: string | null
          id: string
          mentions: Json | null
          sender_user_id: string | null
          workspace_id: string
        }
        Insert: {
          agora_event_id: string
          attachment_asset_ids?: string[] | null
          body?: string | null
          channel_id: string
          created_at: string
          deleted_at?: string | null
          edited_at?: string | null
          id: string
          mentions?: Json | null
          sender_user_id?: string | null
          workspace_id: string
        }
        Update: {
          agora_event_id?: string
          attachment_asset_ids?: string[] | null
          body?: string | null
          channel_id?: string
          created_at?: string
          deleted_at?: string | null
          edited_at?: string | null
          id?: string
          mentions?: Json | null
          sender_user_id?: string | null
          workspace_id?: string
        }
        Relationships: []
      }
      chat_messages_2027_11: {
        Row: {
          agora_event_id: string
          attachment_asset_ids: string[] | null
          body: string | null
          channel_id: string
          created_at: string
          deleted_at: string | null
          edited_at: string | null
          id: string
          mentions: Json | null
          sender_user_id: string | null
          workspace_id: string
        }
        Insert: {
          agora_event_id: string
          attachment_asset_ids?: string[] | null
          body?: string | null
          channel_id: string
          created_at: string
          deleted_at?: string | null
          edited_at?: string | null
          id: string
          mentions?: Json | null
          sender_user_id?: string | null
          workspace_id: string
        }
        Update: {
          agora_event_id?: string
          attachment_asset_ids?: string[] | null
          body?: string | null
          channel_id?: string
          created_at?: string
          deleted_at?: string | null
          edited_at?: string | null
          id?: string
          mentions?: Json | null
          sender_user_id?: string | null
          workspace_id?: string
        }
        Relationships: []
      }
      chat_messages_2027_12: {
        Row: {
          agora_event_id: string
          attachment_asset_ids: string[] | null
          body: string | null
          channel_id: string
          created_at: string
          deleted_at: string | null
          edited_at: string | null
          id: string
          mentions: Json | null
          sender_user_id: string | null
          workspace_id: string
        }
        Insert: {
          agora_event_id: string
          attachment_asset_ids?: string[] | null
          body?: string | null
          channel_id: string
          created_at: string
          deleted_at?: string | null
          edited_at?: string | null
          id: string
          mentions?: Json | null
          sender_user_id?: string | null
          workspace_id: string
        }
        Update: {
          agora_event_id?: string
          attachment_asset_ids?: string[] | null
          body?: string | null
          channel_id?: string
          created_at?: string
          deleted_at?: string | null
          edited_at?: string | null
          id?: string
          mentions?: Json | null
          sender_user_id?: string | null
          workspace_id?: string
        }
        Relationships: []
      }
      chat_messages_2028_01: {
        Row: {
          agora_event_id: string
          attachment_asset_ids: string[] | null
          body: string | null
          channel_id: string
          created_at: string
          deleted_at: string | null
          edited_at: string | null
          id: string
          mentions: Json | null
          sender_user_id: string | null
          workspace_id: string
        }
        Insert: {
          agora_event_id: string
          attachment_asset_ids?: string[] | null
          body?: string | null
          channel_id: string
          created_at: string
          deleted_at?: string | null
          edited_at?: string | null
          id: string
          mentions?: Json | null
          sender_user_id?: string | null
          workspace_id: string
        }
        Update: {
          agora_event_id?: string
          attachment_asset_ids?: string[] | null
          body?: string | null
          channel_id?: string
          created_at?: string
          deleted_at?: string | null
          edited_at?: string | null
          id?: string
          mentions?: Json | null
          sender_user_id?: string | null
          workspace_id?: string
        }
        Relationships: []
      }
      chat_messages_2028_02: {
        Row: {
          agora_event_id: string
          attachment_asset_ids: string[] | null
          body: string | null
          channel_id: string
          created_at: string
          deleted_at: string | null
          edited_at: string | null
          id: string
          mentions: Json | null
          sender_user_id: string | null
          workspace_id: string
        }
        Insert: {
          agora_event_id: string
          attachment_asset_ids?: string[] | null
          body?: string | null
          channel_id: string
          created_at: string
          deleted_at?: string | null
          edited_at?: string | null
          id: string
          mentions?: Json | null
          sender_user_id?: string | null
          workspace_id: string
        }
        Update: {
          agora_event_id?: string
          attachment_asset_ids?: string[] | null
          body?: string | null
          channel_id?: string
          created_at?: string
          deleted_at?: string | null
          edited_at?: string | null
          id?: string
          mentions?: Json | null
          sender_user_id?: string | null
          workspace_id?: string
        }
        Relationships: []
      }
      chat_messages_2028_03: {
        Row: {
          agora_event_id: string
          attachment_asset_ids: string[] | null
          body: string | null
          channel_id: string
          created_at: string
          deleted_at: string | null
          edited_at: string | null
          id: string
          mentions: Json | null
          sender_user_id: string | null
          workspace_id: string
        }
        Insert: {
          agora_event_id: string
          attachment_asset_ids?: string[] | null
          body?: string | null
          channel_id: string
          created_at: string
          deleted_at?: string | null
          edited_at?: string | null
          id: string
          mentions?: Json | null
          sender_user_id?: string | null
          workspace_id: string
        }
        Update: {
          agora_event_id?: string
          attachment_asset_ids?: string[] | null
          body?: string | null
          channel_id?: string
          created_at?: string
          deleted_at?: string | null
          edited_at?: string | null
          id?: string
          mentions?: Json | null
          sender_user_id?: string | null
          workspace_id?: string
        }
        Relationships: []
      }
      chat_messages_2028_04: {
        Row: {
          agora_event_id: string
          attachment_asset_ids: string[] | null
          body: string | null
          channel_id: string
          created_at: string
          deleted_at: string | null
          edited_at: string | null
          id: string
          mentions: Json | null
          sender_user_id: string | null
          workspace_id: string
        }
        Insert: {
          agora_event_id: string
          attachment_asset_ids?: string[] | null
          body?: string | null
          channel_id: string
          created_at: string
          deleted_at?: string | null
          edited_at?: string | null
          id: string
          mentions?: Json | null
          sender_user_id?: string | null
          workspace_id: string
        }
        Update: {
          agora_event_id?: string
          attachment_asset_ids?: string[] | null
          body?: string | null
          channel_id?: string
          created_at?: string
          deleted_at?: string | null
          edited_at?: string | null
          id?: string
          mentions?: Json | null
          sender_user_id?: string | null
          workspace_id?: string
        }
        Relationships: []
      }
      chat_messages_2028_05: {
        Row: {
          agora_event_id: string
          attachment_asset_ids: string[] | null
          body: string | null
          channel_id: string
          created_at: string
          deleted_at: string | null
          edited_at: string | null
          id: string
          mentions: Json | null
          sender_user_id: string | null
          workspace_id: string
        }
        Insert: {
          agora_event_id: string
          attachment_asset_ids?: string[] | null
          body?: string | null
          channel_id: string
          created_at: string
          deleted_at?: string | null
          edited_at?: string | null
          id: string
          mentions?: Json | null
          sender_user_id?: string | null
          workspace_id: string
        }
        Update: {
          agora_event_id?: string
          attachment_asset_ids?: string[] | null
          body?: string | null
          channel_id?: string
          created_at?: string
          deleted_at?: string | null
          edited_at?: string | null
          id?: string
          mentions?: Json | null
          sender_user_id?: string | null
          workspace_id?: string
        }
        Relationships: []
      }
      chat_messages_2028_06: {
        Row: {
          agora_event_id: string
          attachment_asset_ids: string[] | null
          body: string | null
          channel_id: string
          created_at: string
          deleted_at: string | null
          edited_at: string | null
          id: string
          mentions: Json | null
          sender_user_id: string | null
          workspace_id: string
        }
        Insert: {
          agora_event_id: string
          attachment_asset_ids?: string[] | null
          body?: string | null
          channel_id: string
          created_at: string
          deleted_at?: string | null
          edited_at?: string | null
          id: string
          mentions?: Json | null
          sender_user_id?: string | null
          workspace_id: string
        }
        Update: {
          agora_event_id?: string
          attachment_asset_ids?: string[] | null
          body?: string | null
          channel_id?: string
          created_at?: string
          deleted_at?: string | null
          edited_at?: string | null
          id?: string
          mentions?: Json | null
          sender_user_id?: string | null
          workspace_id?: string
        }
        Relationships: []
      }
      chat_messages_2028_07: {
        Row: {
          agora_event_id: string
          attachment_asset_ids: string[] | null
          body: string | null
          channel_id: string
          created_at: string
          deleted_at: string | null
          edited_at: string | null
          id: string
          mentions: Json | null
          sender_user_id: string | null
          workspace_id: string
        }
        Insert: {
          agora_event_id: string
          attachment_asset_ids?: string[] | null
          body?: string | null
          channel_id: string
          created_at: string
          deleted_at?: string | null
          edited_at?: string | null
          id: string
          mentions?: Json | null
          sender_user_id?: string | null
          workspace_id: string
        }
        Update: {
          agora_event_id?: string
          attachment_asset_ids?: string[] | null
          body?: string | null
          channel_id?: string
          created_at?: string
          deleted_at?: string | null
          edited_at?: string | null
          id?: string
          mentions?: Json | null
          sender_user_id?: string | null
          workspace_id?: string
        }
        Relationships: []
      }
      chat_messages_2028_08: {
        Row: {
          agora_event_id: string
          attachment_asset_ids: string[] | null
          body: string | null
          channel_id: string
          created_at: string
          deleted_at: string | null
          edited_at: string | null
          id: string
          mentions: Json | null
          sender_user_id: string | null
          workspace_id: string
        }
        Insert: {
          agora_event_id: string
          attachment_asset_ids?: string[] | null
          body?: string | null
          channel_id: string
          created_at: string
          deleted_at?: string | null
          edited_at?: string | null
          id: string
          mentions?: Json | null
          sender_user_id?: string | null
          workspace_id: string
        }
        Update: {
          agora_event_id?: string
          attachment_asset_ids?: string[] | null
          body?: string | null
          channel_id?: string
          created_at?: string
          deleted_at?: string | null
          edited_at?: string | null
          id?: string
          mentions?: Json | null
          sender_user_id?: string | null
          workspace_id?: string
        }
        Relationships: []
      }
      chat_messages_2028_09: {
        Row: {
          agora_event_id: string
          attachment_asset_ids: string[] | null
          body: string | null
          channel_id: string
          created_at: string
          deleted_at: string | null
          edited_at: string | null
          id: string
          mentions: Json | null
          sender_user_id: string | null
          workspace_id: string
        }
        Insert: {
          agora_event_id: string
          attachment_asset_ids?: string[] | null
          body?: string | null
          channel_id: string
          created_at: string
          deleted_at?: string | null
          edited_at?: string | null
          id: string
          mentions?: Json | null
          sender_user_id?: string | null
          workspace_id: string
        }
        Update: {
          agora_event_id?: string
          attachment_asset_ids?: string[] | null
          body?: string | null
          channel_id?: string
          created_at?: string
          deleted_at?: string | null
          edited_at?: string | null
          id?: string
          mentions?: Json | null
          sender_user_id?: string | null
          workspace_id?: string
        }
        Relationships: []
      }
      chat_messages_2028_10: {
        Row: {
          agora_event_id: string
          attachment_asset_ids: string[] | null
          body: string | null
          channel_id: string
          created_at: string
          deleted_at: string | null
          edited_at: string | null
          id: string
          mentions: Json | null
          sender_user_id: string | null
          workspace_id: string
        }
        Insert: {
          agora_event_id: string
          attachment_asset_ids?: string[] | null
          body?: string | null
          channel_id: string
          created_at: string
          deleted_at?: string | null
          edited_at?: string | null
          id: string
          mentions?: Json | null
          sender_user_id?: string | null
          workspace_id: string
        }
        Update: {
          agora_event_id?: string
          attachment_asset_ids?: string[] | null
          body?: string | null
          channel_id?: string
          created_at?: string
          deleted_at?: string | null
          edited_at?: string | null
          id?: string
          mentions?: Json | null
          sender_user_id?: string | null
          workspace_id?: string
        }
        Relationships: []
      }
      chat_messages_2028_11: {
        Row: {
          agora_event_id: string
          attachment_asset_ids: string[] | null
          body: string | null
          channel_id: string
          created_at: string
          deleted_at: string | null
          edited_at: string | null
          id: string
          mentions: Json | null
          sender_user_id: string | null
          workspace_id: string
        }
        Insert: {
          agora_event_id: string
          attachment_asset_ids?: string[] | null
          body?: string | null
          channel_id: string
          created_at: string
          deleted_at?: string | null
          edited_at?: string | null
          id: string
          mentions?: Json | null
          sender_user_id?: string | null
          workspace_id: string
        }
        Update: {
          agora_event_id?: string
          attachment_asset_ids?: string[] | null
          body?: string | null
          channel_id?: string
          created_at?: string
          deleted_at?: string | null
          edited_at?: string | null
          id?: string
          mentions?: Json | null
          sender_user_id?: string | null
          workspace_id?: string
        }
        Relationships: []
      }
      chat_messages_2028_12: {
        Row: {
          agora_event_id: string
          attachment_asset_ids: string[] | null
          body: string | null
          channel_id: string
          created_at: string
          deleted_at: string | null
          edited_at: string | null
          id: string
          mentions: Json | null
          sender_user_id: string | null
          workspace_id: string
        }
        Insert: {
          agora_event_id: string
          attachment_asset_ids?: string[] | null
          body?: string | null
          channel_id: string
          created_at: string
          deleted_at?: string | null
          edited_at?: string | null
          id: string
          mentions?: Json | null
          sender_user_id?: string | null
          workspace_id: string
        }
        Update: {
          agora_event_id?: string
          attachment_asset_ids?: string[] | null
          body?: string | null
          channel_id?: string
          created_at?: string
          deleted_at?: string | null
          edited_at?: string | null
          id?: string
          mentions?: Json | null
          sender_user_id?: string | null
          workspace_id?: string
        }
        Relationships: []
      }
      chat_messages_default: {
        Row: {
          agora_event_id: string
          attachment_asset_ids: string[] | null
          body: string | null
          channel_id: string
          created_at: string
          deleted_at: string | null
          edited_at: string | null
          id: string
          mentions: Json | null
          sender_user_id: string | null
          workspace_id: string
        }
        Insert: {
          agora_event_id: string
          attachment_asset_ids?: string[] | null
          body?: string | null
          channel_id: string
          created_at: string
          deleted_at?: string | null
          edited_at?: string | null
          id: string
          mentions?: Json | null
          sender_user_id?: string | null
          workspace_id: string
        }
        Update: {
          agora_event_id?: string
          attachment_asset_ids?: string[] | null
          body?: string | null
          channel_id?: string
          created_at?: string
          deleted_at?: string | null
          edited_at?: string | null
          id?: string
          mentions?: Json | null
          sender_user_id?: string | null
          workspace_id?: string
        }
        Relationships: []
      }
      cockpit_access_log: {
        Row: {
          accessed_at: string
          id: string
          operator_user_id: string
          route: string
          session_id: string
          trace_id: string
          workspace_id: string | null
        }
        Insert: {
          accessed_at?: string
          id?: string
          operator_user_id: string
          route: string
          session_id: string
          trace_id: string
          workspace_id?: string | null
        }
        Update: {
          accessed_at?: string
          id?: string
          operator_user_id?: string
          route?: string
          session_id?: string
          trace_id?: string
          workspace_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "cockpit_access_log_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      cockpit_procedure_allowlist: {
        Row: {
          added_at: string
          added_by: string | null
          description: string
          procedure_name: string
          risk_tier: string
        }
        Insert: {
          added_at?: string
          added_by?: string | null
          description: string
          procedure_name: string
          risk_tier: string
        }
        Update: {
          added_at?: string
          added_by?: string | null
          description?: string
          procedure_name?: string
          risk_tier?: string
        }
        Relationships: [
          {
            foreignKeyName: "cockpit_procedure_allowlist_added_by_fkey"
            columns: ["added_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      comment_reactions: {
        Row: {
          comment_id: string
          created_at: string
          emoji: string
          user_id: string
          workspace_id: string
        }
        Insert: {
          comment_id: string
          created_at?: string
          emoji: string
          user_id: string
          workspace_id: string
        }
        Update: {
          comment_id?: string
          created_at?: string
          emoji?: string
          user_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "comment_reactions_comment_id_fkey"
            columns: ["comment_id"]
            isOneToOne: false
            referencedRelation: "comments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "comment_reactions_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      comments: {
        Row: {
          accepted_at: string | null
          accepted_by: string | null
          asked_at: string | null
          asked_by: string | null
          attachment_asset_ids: string[] | null
          author_user_id: string
          body: string
          closed_at: string | null
          closed_by: string | null
          created_at: string
          deleted_at: string | null
          edited_at: string | null
          entity_id: string
          entity_type: string
          id: string
          ledger_batch_id: string | null
          ledger_seq: number | null
          legacy_author_email: string | null
          legacy_author_name: string | null
          mentions: Json | null
          parent_comment_id: string | null
          resolution_note: string | null
          resolved_at: string | null
          resolved_by: string | null
          resolved_version_id: string | null
          sent_back_at: string | null
          sent_back_by: string | null
          unaccepted_at: string | null
          unaccepted_by: string | null
          workspace_id: string
        }
        Insert: {
          accepted_at?: string | null
          accepted_by?: string | null
          asked_at?: string | null
          asked_by?: string | null
          attachment_asset_ids?: string[] | null
          author_user_id: string
          body: string
          closed_at?: string | null
          closed_by?: string | null
          created_at?: string
          deleted_at?: string | null
          edited_at?: string | null
          entity_id: string
          entity_type: string
          id?: string
          ledger_batch_id?: string | null
          ledger_seq?: number | null
          legacy_author_email?: string | null
          legacy_author_name?: string | null
          mentions?: Json | null
          parent_comment_id?: string | null
          resolution_note?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          resolved_version_id?: string | null
          sent_back_at?: string | null
          sent_back_by?: string | null
          unaccepted_at?: string | null
          unaccepted_by?: string | null
          workspace_id: string
        }
        Update: {
          accepted_at?: string | null
          accepted_by?: string | null
          asked_at?: string | null
          asked_by?: string | null
          attachment_asset_ids?: string[] | null
          author_user_id?: string
          body?: string
          closed_at?: string | null
          closed_by?: string | null
          created_at?: string
          deleted_at?: string | null
          edited_at?: string | null
          entity_id?: string
          entity_type?: string
          id?: string
          ledger_batch_id?: string | null
          ledger_seq?: number | null
          legacy_author_email?: string | null
          legacy_author_name?: string | null
          mentions?: Json | null
          parent_comment_id?: string | null
          resolution_note?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          resolved_version_id?: string | null
          sent_back_at?: string | null
          sent_back_by?: string | null
          unaccepted_at?: string | null
          unaccepted_by?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "comments_parent_comment_id_fkey"
            columns: ["parent_comment_id"]
            isOneToOne: false
            referencedRelation: "comments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "comments_resolved_by_fkey"
            columns: ["resolved_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "comments_resolved_version_id_fkey"
            columns: ["resolved_version_id"]
            isOneToOne: false
            referencedRelation: "post_versions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "comments_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      delivery_attempts: {
        Row: {
          bounced_at: string | null
          channel: string
          created_at: string
          delivered_at: string | null
          email_thread_id: string | null
          error: string | null
          id: string
          provider: string
          provider_message_id: string | null
          sent_at: string | null
          status: string
          template_key: string
          user_id: string | null
          workspace_id: string | null
        }
        Insert: {
          bounced_at?: string | null
          channel: string
          created_at?: string
          delivered_at?: string | null
          email_thread_id?: string | null
          error?: string | null
          id?: string
          provider: string
          provider_message_id?: string | null
          sent_at?: string | null
          status?: string
          template_key: string
          user_id?: string | null
          workspace_id?: string | null
        }
        Update: {
          bounced_at?: string | null
          channel?: string
          created_at?: string
          delivered_at?: string | null
          email_thread_id?: string | null
          error?: string | null
          id?: string
          provider?: string
          provider_message_id?: string | null
          sent_at?: string | null
          status?: string
          template_key?: string
          user_id?: string | null
          workspace_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "delivery_attempts_email_thread_id_fkey"
            columns: ["email_thread_id"]
            isOneToOne: false
            referencedRelation: "email_threads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "delivery_attempts_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "delivery_attempts_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      email_threads: {
        Row: {
          created_at: string
          id: string
          last_sent_at: string | null
          message_id: string
          root_id: string
          root_type: string
          subject: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          last_sent_at?: string | null
          message_id: string
          root_id: string
          root_type: string
          subject: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          id?: string
          last_sent_at?: string | null
          message_id?: string
          root_id?: string
          root_type?: string
          subject?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "email_threads_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      feature_flags: {
        Row: {
          category: string
          enabled: boolean
          flag_name: string
          id: string
          reason: string | null
          rollout_percentage: number
          tier_min: string | null
          updated_at: string
          updated_by: string | null
          workspace_id: string | null
        }
        Insert: {
          category: string
          enabled?: boolean
          flag_name: string
          id?: string
          reason?: string | null
          rollout_percentage?: number
          tier_min?: string | null
          updated_at?: string
          updated_by?: string | null
          workspace_id?: string | null
        }
        Update: {
          category?: string
          enabled?: boolean
          flag_name?: string
          id?: string
          reason?: string | null
          rollout_percentage?: number
          tier_min?: string | null
          updated_at?: string
          updated_by?: string | null
          workspace_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "feature_flags_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "feature_flags_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      folders: {
        Row: {
          created_at: string
          created_by: string | null
          deleted_at: string | null
          id: string
          name: string
          parent_id: string | null
          updated_at: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          id?: string
          name: string
          parent_id?: string | null
          updated_at?: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          id?: string
          name?: string
          parent_id?: string | null
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "folders_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "folders_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "folders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "folders_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      group_members: {
        Row: {
          group_id: string
          joined_at: string
          user_id: string
          workspace_id: string
        }
        Insert: {
          group_id: string
          joined_at?: string
          user_id: string
          workspace_id: string
        }
        Update: {
          group_id?: string
          joined_at?: string
          user_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "group_members_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "groups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "group_members_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      groups: {
        Row: {
          created_at: string
          created_by: string | null
          deleted_at: string | null
          id: string
          name: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          id?: string
          name: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          id?: string
          name?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "groups_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "groups_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      idempotency_keys: {
        Row: {
          created_at: string
          expires_at: string
          id: string
          key: string
          request_hash: string
          response_body: Json | null
          response_status: number | null
          status: string
          trace_id: string
          user_id: string | null
          workspace_id: string | null
        }
        Insert: {
          created_at?: string
          expires_at: string
          id?: string
          key: string
          request_hash: string
          response_body?: Json | null
          response_status?: number | null
          status?: string
          trace_id: string
          user_id?: string | null
          workspace_id?: string | null
        }
        Update: {
          created_at?: string
          expires_at?: string
          id?: string
          key?: string
          request_hash?: string
          response_body?: Json | null
          response_status?: number | null
          status?: string
          trace_id?: string
          user_id?: string | null
          workspace_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "idempotency_keys_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      inbox_entries: {
        Row: {
          actor_user_id: string | null
          created_at: string
          deleted_at: string | null
          email_sent_at: string | null
          entity_id: string | null
          entity_type: string | null
          event_type: string
          id: string
          payload: Json
          read_at: string | null
          scope: string
          scope_key: string | null
          snoozed_until: string | null
          tier: string
          user_id: string
          workspace_id: string
        }
        Insert: {
          actor_user_id?: string | null
          created_at?: string
          deleted_at?: string | null
          email_sent_at?: string | null
          entity_id?: string | null
          entity_type?: string | null
          event_type: string
          id?: string
          payload?: Json
          read_at?: string | null
          scope: string
          scope_key?: string | null
          snoozed_until?: string | null
          tier?: string
          user_id: string
          workspace_id: string
        }
        Update: {
          actor_user_id?: string | null
          created_at?: string
          deleted_at?: string | null
          email_sent_at?: string | null
          entity_id?: string | null
          entity_type?: string | null
          event_type?: string
          id?: string
          payload?: Json
          read_at?: string | null
          scope?: string
          scope_key?: string | null
          snoozed_until?: string | null
          tier?: string
          user_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "inbox_entries_actor_user_id_fkey"
            columns: ["actor_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inbox_entries_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      inbox_entries_2026_05: {
        Row: {
          actor_user_id: string | null
          created_at: string
          deleted_at: string | null
          email_sent_at: string | null
          entity_id: string | null
          entity_type: string | null
          event_type: string
          id: string
          payload: Json
          read_at: string | null
          scope: string
          scope_key: string | null
          snoozed_until: string | null
          tier: string
          user_id: string
          workspace_id: string
        }
        Insert: {
          actor_user_id?: string | null
          created_at?: string
          deleted_at?: string | null
          email_sent_at?: string | null
          entity_id?: string | null
          entity_type?: string | null
          event_type: string
          id?: string
          payload?: Json
          read_at?: string | null
          scope: string
          scope_key?: string | null
          snoozed_until?: string | null
          tier?: string
          user_id: string
          workspace_id: string
        }
        Update: {
          actor_user_id?: string | null
          created_at?: string
          deleted_at?: string | null
          email_sent_at?: string | null
          entity_id?: string | null
          entity_type?: string | null
          event_type?: string
          id?: string
          payload?: Json
          read_at?: string | null
          scope?: string
          scope_key?: string | null
          snoozed_until?: string | null
          tier?: string
          user_id?: string
          workspace_id?: string
        }
        Relationships: []
      }
      inbox_entries_2026_06: {
        Row: {
          actor_user_id: string | null
          created_at: string
          deleted_at: string | null
          email_sent_at: string | null
          entity_id: string | null
          entity_type: string | null
          event_type: string
          id: string
          payload: Json
          read_at: string | null
          scope: string
          scope_key: string | null
          snoozed_until: string | null
          tier: string
          user_id: string
          workspace_id: string
        }
        Insert: {
          actor_user_id?: string | null
          created_at?: string
          deleted_at?: string | null
          email_sent_at?: string | null
          entity_id?: string | null
          entity_type?: string | null
          event_type: string
          id?: string
          payload?: Json
          read_at?: string | null
          scope: string
          scope_key?: string | null
          snoozed_until?: string | null
          tier?: string
          user_id: string
          workspace_id: string
        }
        Update: {
          actor_user_id?: string | null
          created_at?: string
          deleted_at?: string | null
          email_sent_at?: string | null
          entity_id?: string | null
          entity_type?: string | null
          event_type?: string
          id?: string
          payload?: Json
          read_at?: string | null
          scope?: string
          scope_key?: string | null
          snoozed_until?: string | null
          tier?: string
          user_id?: string
          workspace_id?: string
        }
        Relationships: []
      }
      inbox_entries_2026_07: {
        Row: {
          actor_user_id: string | null
          created_at: string
          deleted_at: string | null
          email_sent_at: string | null
          entity_id: string | null
          entity_type: string | null
          event_type: string
          id: string
          payload: Json
          read_at: string | null
          scope: string
          scope_key: string | null
          snoozed_until: string | null
          tier: string
          user_id: string
          workspace_id: string
        }
        Insert: {
          actor_user_id?: string | null
          created_at?: string
          deleted_at?: string | null
          email_sent_at?: string | null
          entity_id?: string | null
          entity_type?: string | null
          event_type: string
          id?: string
          payload?: Json
          read_at?: string | null
          scope: string
          scope_key?: string | null
          snoozed_until?: string | null
          tier?: string
          user_id: string
          workspace_id: string
        }
        Update: {
          actor_user_id?: string | null
          created_at?: string
          deleted_at?: string | null
          email_sent_at?: string | null
          entity_id?: string | null
          entity_type?: string | null
          event_type?: string
          id?: string
          payload?: Json
          read_at?: string | null
          scope?: string
          scope_key?: string | null
          snoozed_until?: string | null
          tier?: string
          user_id?: string
          workspace_id?: string
        }
        Relationships: []
      }
      inbox_entries_2026_08: {
        Row: {
          actor_user_id: string | null
          created_at: string
          deleted_at: string | null
          email_sent_at: string | null
          entity_id: string | null
          entity_type: string | null
          event_type: string
          id: string
          payload: Json
          read_at: string | null
          scope: string
          scope_key: string | null
          snoozed_until: string | null
          tier: string
          user_id: string
          workspace_id: string
        }
        Insert: {
          actor_user_id?: string | null
          created_at?: string
          deleted_at?: string | null
          email_sent_at?: string | null
          entity_id?: string | null
          entity_type?: string | null
          event_type: string
          id?: string
          payload?: Json
          read_at?: string | null
          scope: string
          scope_key?: string | null
          snoozed_until?: string | null
          tier?: string
          user_id: string
          workspace_id: string
        }
        Update: {
          actor_user_id?: string | null
          created_at?: string
          deleted_at?: string | null
          email_sent_at?: string | null
          entity_id?: string | null
          entity_type?: string | null
          event_type?: string
          id?: string
          payload?: Json
          read_at?: string | null
          scope?: string
          scope_key?: string | null
          snoozed_until?: string | null
          tier?: string
          user_id?: string
          workspace_id?: string
        }
        Relationships: []
      }
      inbox_entries_2026_09: {
        Row: {
          actor_user_id: string | null
          created_at: string
          deleted_at: string | null
          email_sent_at: string | null
          entity_id: string | null
          entity_type: string | null
          event_type: string
          id: string
          payload: Json
          read_at: string | null
          scope: string
          scope_key: string | null
          snoozed_until: string | null
          tier: string
          user_id: string
          workspace_id: string
        }
        Insert: {
          actor_user_id?: string | null
          created_at?: string
          deleted_at?: string | null
          email_sent_at?: string | null
          entity_id?: string | null
          entity_type?: string | null
          event_type: string
          id?: string
          payload?: Json
          read_at?: string | null
          scope: string
          scope_key?: string | null
          snoozed_until?: string | null
          tier?: string
          user_id: string
          workspace_id: string
        }
        Update: {
          actor_user_id?: string | null
          created_at?: string
          deleted_at?: string | null
          email_sent_at?: string | null
          entity_id?: string | null
          entity_type?: string | null
          event_type?: string
          id?: string
          payload?: Json
          read_at?: string | null
          scope?: string
          scope_key?: string | null
          snoozed_until?: string | null
          tier?: string
          user_id?: string
          workspace_id?: string
        }
        Relationships: []
      }
      inbox_entries_2026_10: {
        Row: {
          actor_user_id: string | null
          created_at: string
          deleted_at: string | null
          email_sent_at: string | null
          entity_id: string | null
          entity_type: string | null
          event_type: string
          id: string
          payload: Json
          read_at: string | null
          scope: string
          scope_key: string | null
          snoozed_until: string | null
          tier: string
          user_id: string
          workspace_id: string
        }
        Insert: {
          actor_user_id?: string | null
          created_at?: string
          deleted_at?: string | null
          email_sent_at?: string | null
          entity_id?: string | null
          entity_type?: string | null
          event_type: string
          id?: string
          payload?: Json
          read_at?: string | null
          scope: string
          scope_key?: string | null
          snoozed_until?: string | null
          tier?: string
          user_id: string
          workspace_id: string
        }
        Update: {
          actor_user_id?: string | null
          created_at?: string
          deleted_at?: string | null
          email_sent_at?: string | null
          entity_id?: string | null
          entity_type?: string | null
          event_type?: string
          id?: string
          payload?: Json
          read_at?: string | null
          scope?: string
          scope_key?: string | null
          snoozed_until?: string | null
          tier?: string
          user_id?: string
          workspace_id?: string
        }
        Relationships: []
      }
      inbox_entries_2026_11: {
        Row: {
          actor_user_id: string | null
          created_at: string
          deleted_at: string | null
          email_sent_at: string | null
          entity_id: string | null
          entity_type: string | null
          event_type: string
          id: string
          payload: Json
          read_at: string | null
          scope: string
          scope_key: string | null
          snoozed_until: string | null
          tier: string
          user_id: string
          workspace_id: string
        }
        Insert: {
          actor_user_id?: string | null
          created_at?: string
          deleted_at?: string | null
          email_sent_at?: string | null
          entity_id?: string | null
          entity_type?: string | null
          event_type: string
          id?: string
          payload?: Json
          read_at?: string | null
          scope: string
          scope_key?: string | null
          snoozed_until?: string | null
          tier?: string
          user_id: string
          workspace_id: string
        }
        Update: {
          actor_user_id?: string | null
          created_at?: string
          deleted_at?: string | null
          email_sent_at?: string | null
          entity_id?: string | null
          entity_type?: string | null
          event_type?: string
          id?: string
          payload?: Json
          read_at?: string | null
          scope?: string
          scope_key?: string | null
          snoozed_until?: string | null
          tier?: string
          user_id?: string
          workspace_id?: string
        }
        Relationships: []
      }
      inbox_entries_2026_12: {
        Row: {
          actor_user_id: string | null
          created_at: string
          deleted_at: string | null
          email_sent_at: string | null
          entity_id: string | null
          entity_type: string | null
          event_type: string
          id: string
          payload: Json
          read_at: string | null
          scope: string
          scope_key: string | null
          snoozed_until: string | null
          tier: string
          user_id: string
          workspace_id: string
        }
        Insert: {
          actor_user_id?: string | null
          created_at?: string
          deleted_at?: string | null
          email_sent_at?: string | null
          entity_id?: string | null
          entity_type?: string | null
          event_type: string
          id?: string
          payload?: Json
          read_at?: string | null
          scope: string
          scope_key?: string | null
          snoozed_until?: string | null
          tier?: string
          user_id: string
          workspace_id: string
        }
        Update: {
          actor_user_id?: string | null
          created_at?: string
          deleted_at?: string | null
          email_sent_at?: string | null
          entity_id?: string | null
          entity_type?: string | null
          event_type?: string
          id?: string
          payload?: Json
          read_at?: string | null
          scope?: string
          scope_key?: string | null
          snoozed_until?: string | null
          tier?: string
          user_id?: string
          workspace_id?: string
        }
        Relationships: []
      }
      inbox_entries_2027_01: {
        Row: {
          actor_user_id: string | null
          created_at: string
          deleted_at: string | null
          email_sent_at: string | null
          entity_id: string | null
          entity_type: string | null
          event_type: string
          id: string
          payload: Json
          read_at: string | null
          scope: string
          scope_key: string | null
          snoozed_until: string | null
          tier: string
          user_id: string
          workspace_id: string
        }
        Insert: {
          actor_user_id?: string | null
          created_at?: string
          deleted_at?: string | null
          email_sent_at?: string | null
          entity_id?: string | null
          entity_type?: string | null
          event_type: string
          id?: string
          payload?: Json
          read_at?: string | null
          scope: string
          scope_key?: string | null
          snoozed_until?: string | null
          tier?: string
          user_id: string
          workspace_id: string
        }
        Update: {
          actor_user_id?: string | null
          created_at?: string
          deleted_at?: string | null
          email_sent_at?: string | null
          entity_id?: string | null
          entity_type?: string | null
          event_type?: string
          id?: string
          payload?: Json
          read_at?: string | null
          scope?: string
          scope_key?: string | null
          snoozed_until?: string | null
          tier?: string
          user_id?: string
          workspace_id?: string
        }
        Relationships: []
      }
      inbox_entries_2027_02: {
        Row: {
          actor_user_id: string | null
          created_at: string
          deleted_at: string | null
          email_sent_at: string | null
          entity_id: string | null
          entity_type: string | null
          event_type: string
          id: string
          payload: Json
          read_at: string | null
          scope: string
          scope_key: string | null
          snoozed_until: string | null
          tier: string
          user_id: string
          workspace_id: string
        }
        Insert: {
          actor_user_id?: string | null
          created_at?: string
          deleted_at?: string | null
          email_sent_at?: string | null
          entity_id?: string | null
          entity_type?: string | null
          event_type: string
          id?: string
          payload?: Json
          read_at?: string | null
          scope: string
          scope_key?: string | null
          snoozed_until?: string | null
          tier?: string
          user_id: string
          workspace_id: string
        }
        Update: {
          actor_user_id?: string | null
          created_at?: string
          deleted_at?: string | null
          email_sent_at?: string | null
          entity_id?: string | null
          entity_type?: string | null
          event_type?: string
          id?: string
          payload?: Json
          read_at?: string | null
          scope?: string
          scope_key?: string | null
          snoozed_until?: string | null
          tier?: string
          user_id?: string
          workspace_id?: string
        }
        Relationships: []
      }
      inbox_entries_2027_03: {
        Row: {
          actor_user_id: string | null
          created_at: string
          deleted_at: string | null
          email_sent_at: string | null
          entity_id: string | null
          entity_type: string | null
          event_type: string
          id: string
          payload: Json
          read_at: string | null
          scope: string
          scope_key: string | null
          snoozed_until: string | null
          tier: string
          user_id: string
          workspace_id: string
        }
        Insert: {
          actor_user_id?: string | null
          created_at?: string
          deleted_at?: string | null
          email_sent_at?: string | null
          entity_id?: string | null
          entity_type?: string | null
          event_type: string
          id?: string
          payload?: Json
          read_at?: string | null
          scope: string
          scope_key?: string | null
          snoozed_until?: string | null
          tier?: string
          user_id: string
          workspace_id: string
        }
        Update: {
          actor_user_id?: string | null
          created_at?: string
          deleted_at?: string | null
          email_sent_at?: string | null
          entity_id?: string | null
          entity_type?: string | null
          event_type?: string
          id?: string
          payload?: Json
          read_at?: string | null
          scope?: string
          scope_key?: string | null
          snoozed_until?: string | null
          tier?: string
          user_id?: string
          workspace_id?: string
        }
        Relationships: []
      }
      inbox_entries_2027_04: {
        Row: {
          actor_user_id: string | null
          created_at: string
          deleted_at: string | null
          email_sent_at: string | null
          entity_id: string | null
          entity_type: string | null
          event_type: string
          id: string
          payload: Json
          read_at: string | null
          scope: string
          scope_key: string | null
          snoozed_until: string | null
          tier: string
          user_id: string
          workspace_id: string
        }
        Insert: {
          actor_user_id?: string | null
          created_at?: string
          deleted_at?: string | null
          email_sent_at?: string | null
          entity_id?: string | null
          entity_type?: string | null
          event_type: string
          id?: string
          payload?: Json
          read_at?: string | null
          scope: string
          scope_key?: string | null
          snoozed_until?: string | null
          tier?: string
          user_id: string
          workspace_id: string
        }
        Update: {
          actor_user_id?: string | null
          created_at?: string
          deleted_at?: string | null
          email_sent_at?: string | null
          entity_id?: string | null
          entity_type?: string | null
          event_type?: string
          id?: string
          payload?: Json
          read_at?: string | null
          scope?: string
          scope_key?: string | null
          snoozed_until?: string | null
          tier?: string
          user_id?: string
          workspace_id?: string
        }
        Relationships: []
      }
      inbox_entries_2027_05: {
        Row: {
          actor_user_id: string | null
          created_at: string
          deleted_at: string | null
          email_sent_at: string | null
          entity_id: string | null
          entity_type: string | null
          event_type: string
          id: string
          payload: Json
          read_at: string | null
          scope: string
          scope_key: string | null
          snoozed_until: string | null
          tier: string
          user_id: string
          workspace_id: string
        }
        Insert: {
          actor_user_id?: string | null
          created_at?: string
          deleted_at?: string | null
          email_sent_at?: string | null
          entity_id?: string | null
          entity_type?: string | null
          event_type: string
          id?: string
          payload?: Json
          read_at?: string | null
          scope: string
          scope_key?: string | null
          snoozed_until?: string | null
          tier?: string
          user_id: string
          workspace_id: string
        }
        Update: {
          actor_user_id?: string | null
          created_at?: string
          deleted_at?: string | null
          email_sent_at?: string | null
          entity_id?: string | null
          entity_type?: string | null
          event_type?: string
          id?: string
          payload?: Json
          read_at?: string | null
          scope?: string
          scope_key?: string | null
          snoozed_until?: string | null
          tier?: string
          user_id?: string
          workspace_id?: string
        }
        Relationships: []
      }
      inbox_entries_2027_06: {
        Row: {
          actor_user_id: string | null
          created_at: string
          deleted_at: string | null
          email_sent_at: string | null
          entity_id: string | null
          entity_type: string | null
          event_type: string
          id: string
          payload: Json
          read_at: string | null
          scope: string
          scope_key: string | null
          snoozed_until: string | null
          tier: string
          user_id: string
          workspace_id: string
        }
        Insert: {
          actor_user_id?: string | null
          created_at?: string
          deleted_at?: string | null
          email_sent_at?: string | null
          entity_id?: string | null
          entity_type?: string | null
          event_type: string
          id?: string
          payload?: Json
          read_at?: string | null
          scope: string
          scope_key?: string | null
          snoozed_until?: string | null
          tier?: string
          user_id: string
          workspace_id: string
        }
        Update: {
          actor_user_id?: string | null
          created_at?: string
          deleted_at?: string | null
          email_sent_at?: string | null
          entity_id?: string | null
          entity_type?: string | null
          event_type?: string
          id?: string
          payload?: Json
          read_at?: string | null
          scope?: string
          scope_key?: string | null
          snoozed_until?: string | null
          tier?: string
          user_id?: string
          workspace_id?: string
        }
        Relationships: []
      }
      inbox_entries_2027_07: {
        Row: {
          actor_user_id: string | null
          created_at: string
          deleted_at: string | null
          email_sent_at: string | null
          entity_id: string | null
          entity_type: string | null
          event_type: string
          id: string
          payload: Json
          read_at: string | null
          scope: string
          scope_key: string | null
          snoozed_until: string | null
          tier: string
          user_id: string
          workspace_id: string
        }
        Insert: {
          actor_user_id?: string | null
          created_at?: string
          deleted_at?: string | null
          email_sent_at?: string | null
          entity_id?: string | null
          entity_type?: string | null
          event_type: string
          id?: string
          payload?: Json
          read_at?: string | null
          scope: string
          scope_key?: string | null
          snoozed_until?: string | null
          tier?: string
          user_id: string
          workspace_id: string
        }
        Update: {
          actor_user_id?: string | null
          created_at?: string
          deleted_at?: string | null
          email_sent_at?: string | null
          entity_id?: string | null
          entity_type?: string | null
          event_type?: string
          id?: string
          payload?: Json
          read_at?: string | null
          scope?: string
          scope_key?: string | null
          snoozed_until?: string | null
          tier?: string
          user_id?: string
          workspace_id?: string
        }
        Relationships: []
      }
      inbox_entries_2027_08: {
        Row: {
          actor_user_id: string | null
          created_at: string
          deleted_at: string | null
          email_sent_at: string | null
          entity_id: string | null
          entity_type: string | null
          event_type: string
          id: string
          payload: Json
          read_at: string | null
          scope: string
          scope_key: string | null
          snoozed_until: string | null
          tier: string
          user_id: string
          workspace_id: string
        }
        Insert: {
          actor_user_id?: string | null
          created_at?: string
          deleted_at?: string | null
          email_sent_at?: string | null
          entity_id?: string | null
          entity_type?: string | null
          event_type: string
          id?: string
          payload?: Json
          read_at?: string | null
          scope: string
          scope_key?: string | null
          snoozed_until?: string | null
          tier?: string
          user_id: string
          workspace_id: string
        }
        Update: {
          actor_user_id?: string | null
          created_at?: string
          deleted_at?: string | null
          email_sent_at?: string | null
          entity_id?: string | null
          entity_type?: string | null
          event_type?: string
          id?: string
          payload?: Json
          read_at?: string | null
          scope?: string
          scope_key?: string | null
          snoozed_until?: string | null
          tier?: string
          user_id?: string
          workspace_id?: string
        }
        Relationships: []
      }
      inbox_entries_2027_09: {
        Row: {
          actor_user_id: string | null
          created_at: string
          deleted_at: string | null
          email_sent_at: string | null
          entity_id: string | null
          entity_type: string | null
          event_type: string
          id: string
          payload: Json
          read_at: string | null
          scope: string
          scope_key: string | null
          snoozed_until: string | null
          tier: string
          user_id: string
          workspace_id: string
        }
        Insert: {
          actor_user_id?: string | null
          created_at?: string
          deleted_at?: string | null
          email_sent_at?: string | null
          entity_id?: string | null
          entity_type?: string | null
          event_type: string
          id?: string
          payload?: Json
          read_at?: string | null
          scope: string
          scope_key?: string | null
          snoozed_until?: string | null
          tier?: string
          user_id: string
          workspace_id: string
        }
        Update: {
          actor_user_id?: string | null
          created_at?: string
          deleted_at?: string | null
          email_sent_at?: string | null
          entity_id?: string | null
          entity_type?: string | null
          event_type?: string
          id?: string
          payload?: Json
          read_at?: string | null
          scope?: string
          scope_key?: string | null
          snoozed_until?: string | null
          tier?: string
          user_id?: string
          workspace_id?: string
        }
        Relationships: []
      }
      inbox_entries_2027_10: {
        Row: {
          actor_user_id: string | null
          created_at: string
          deleted_at: string | null
          email_sent_at: string | null
          entity_id: string | null
          entity_type: string | null
          event_type: string
          id: string
          payload: Json
          read_at: string | null
          scope: string
          scope_key: string | null
          snoozed_until: string | null
          tier: string
          user_id: string
          workspace_id: string
        }
        Insert: {
          actor_user_id?: string | null
          created_at?: string
          deleted_at?: string | null
          email_sent_at?: string | null
          entity_id?: string | null
          entity_type?: string | null
          event_type: string
          id?: string
          payload?: Json
          read_at?: string | null
          scope: string
          scope_key?: string | null
          snoozed_until?: string | null
          tier?: string
          user_id: string
          workspace_id: string
        }
        Update: {
          actor_user_id?: string | null
          created_at?: string
          deleted_at?: string | null
          email_sent_at?: string | null
          entity_id?: string | null
          entity_type?: string | null
          event_type?: string
          id?: string
          payload?: Json
          read_at?: string | null
          scope?: string
          scope_key?: string | null
          snoozed_until?: string | null
          tier?: string
          user_id?: string
          workspace_id?: string
        }
        Relationships: []
      }
      inbox_entries_2027_11: {
        Row: {
          actor_user_id: string | null
          created_at: string
          deleted_at: string | null
          email_sent_at: string | null
          entity_id: string | null
          entity_type: string | null
          event_type: string
          id: string
          payload: Json
          read_at: string | null
          scope: string
          scope_key: string | null
          snoozed_until: string | null
          tier: string
          user_id: string
          workspace_id: string
        }
        Insert: {
          actor_user_id?: string | null
          created_at?: string
          deleted_at?: string | null
          email_sent_at?: string | null
          entity_id?: string | null
          entity_type?: string | null
          event_type: string
          id?: string
          payload?: Json
          read_at?: string | null
          scope: string
          scope_key?: string | null
          snoozed_until?: string | null
          tier?: string
          user_id: string
          workspace_id: string
        }
        Update: {
          actor_user_id?: string | null
          created_at?: string
          deleted_at?: string | null
          email_sent_at?: string | null
          entity_id?: string | null
          entity_type?: string | null
          event_type?: string
          id?: string
          payload?: Json
          read_at?: string | null
          scope?: string
          scope_key?: string | null
          snoozed_until?: string | null
          tier?: string
          user_id?: string
          workspace_id?: string
        }
        Relationships: []
      }
      inbox_entries_2027_12: {
        Row: {
          actor_user_id: string | null
          created_at: string
          deleted_at: string | null
          email_sent_at: string | null
          entity_id: string | null
          entity_type: string | null
          event_type: string
          id: string
          payload: Json
          read_at: string | null
          scope: string
          scope_key: string | null
          snoozed_until: string | null
          tier: string
          user_id: string
          workspace_id: string
        }
        Insert: {
          actor_user_id?: string | null
          created_at?: string
          deleted_at?: string | null
          email_sent_at?: string | null
          entity_id?: string | null
          entity_type?: string | null
          event_type: string
          id?: string
          payload?: Json
          read_at?: string | null
          scope: string
          scope_key?: string | null
          snoozed_until?: string | null
          tier?: string
          user_id: string
          workspace_id: string
        }
        Update: {
          actor_user_id?: string | null
          created_at?: string
          deleted_at?: string | null
          email_sent_at?: string | null
          entity_id?: string | null
          entity_type?: string | null
          event_type?: string
          id?: string
          payload?: Json
          read_at?: string | null
          scope?: string
          scope_key?: string | null
          snoozed_until?: string | null
          tier?: string
          user_id?: string
          workspace_id?: string
        }
        Relationships: []
      }
      inbox_entries_2028_01: {
        Row: {
          actor_user_id: string | null
          created_at: string
          deleted_at: string | null
          email_sent_at: string | null
          entity_id: string | null
          entity_type: string | null
          event_type: string
          id: string
          payload: Json
          read_at: string | null
          scope: string
          scope_key: string | null
          snoozed_until: string | null
          tier: string
          user_id: string
          workspace_id: string
        }
        Insert: {
          actor_user_id?: string | null
          created_at?: string
          deleted_at?: string | null
          email_sent_at?: string | null
          entity_id?: string | null
          entity_type?: string | null
          event_type: string
          id?: string
          payload?: Json
          read_at?: string | null
          scope: string
          scope_key?: string | null
          snoozed_until?: string | null
          tier?: string
          user_id: string
          workspace_id: string
        }
        Update: {
          actor_user_id?: string | null
          created_at?: string
          deleted_at?: string | null
          email_sent_at?: string | null
          entity_id?: string | null
          entity_type?: string | null
          event_type?: string
          id?: string
          payload?: Json
          read_at?: string | null
          scope?: string
          scope_key?: string | null
          snoozed_until?: string | null
          tier?: string
          user_id?: string
          workspace_id?: string
        }
        Relationships: []
      }
      inbox_entries_2028_02: {
        Row: {
          actor_user_id: string | null
          created_at: string
          deleted_at: string | null
          email_sent_at: string | null
          entity_id: string | null
          entity_type: string | null
          event_type: string
          id: string
          payload: Json
          read_at: string | null
          scope: string
          scope_key: string | null
          snoozed_until: string | null
          tier: string
          user_id: string
          workspace_id: string
        }
        Insert: {
          actor_user_id?: string | null
          created_at?: string
          deleted_at?: string | null
          email_sent_at?: string | null
          entity_id?: string | null
          entity_type?: string | null
          event_type: string
          id?: string
          payload?: Json
          read_at?: string | null
          scope: string
          scope_key?: string | null
          snoozed_until?: string | null
          tier?: string
          user_id: string
          workspace_id: string
        }
        Update: {
          actor_user_id?: string | null
          created_at?: string
          deleted_at?: string | null
          email_sent_at?: string | null
          entity_id?: string | null
          entity_type?: string | null
          event_type?: string
          id?: string
          payload?: Json
          read_at?: string | null
          scope?: string
          scope_key?: string | null
          snoozed_until?: string | null
          tier?: string
          user_id?: string
          workspace_id?: string
        }
        Relationships: []
      }
      inbox_entries_2028_03: {
        Row: {
          actor_user_id: string | null
          created_at: string
          deleted_at: string | null
          email_sent_at: string | null
          entity_id: string | null
          entity_type: string | null
          event_type: string
          id: string
          payload: Json
          read_at: string | null
          scope: string
          scope_key: string | null
          snoozed_until: string | null
          tier: string
          user_id: string
          workspace_id: string
        }
        Insert: {
          actor_user_id?: string | null
          created_at?: string
          deleted_at?: string | null
          email_sent_at?: string | null
          entity_id?: string | null
          entity_type?: string | null
          event_type: string
          id?: string
          payload?: Json
          read_at?: string | null
          scope: string
          scope_key?: string | null
          snoozed_until?: string | null
          tier?: string
          user_id: string
          workspace_id: string
        }
        Update: {
          actor_user_id?: string | null
          created_at?: string
          deleted_at?: string | null
          email_sent_at?: string | null
          entity_id?: string | null
          entity_type?: string | null
          event_type?: string
          id?: string
          payload?: Json
          read_at?: string | null
          scope?: string
          scope_key?: string | null
          snoozed_until?: string | null
          tier?: string
          user_id?: string
          workspace_id?: string
        }
        Relationships: []
      }
      inbox_entries_2028_04: {
        Row: {
          actor_user_id: string | null
          created_at: string
          deleted_at: string | null
          email_sent_at: string | null
          entity_id: string | null
          entity_type: string | null
          event_type: string
          id: string
          payload: Json
          read_at: string | null
          scope: string
          scope_key: string | null
          snoozed_until: string | null
          tier: string
          user_id: string
          workspace_id: string
        }
        Insert: {
          actor_user_id?: string | null
          created_at?: string
          deleted_at?: string | null
          email_sent_at?: string | null
          entity_id?: string | null
          entity_type?: string | null
          event_type: string
          id?: string
          payload?: Json
          read_at?: string | null
          scope: string
          scope_key?: string | null
          snoozed_until?: string | null
          tier?: string
          user_id: string
          workspace_id: string
        }
        Update: {
          actor_user_id?: string | null
          created_at?: string
          deleted_at?: string | null
          email_sent_at?: string | null
          entity_id?: string | null
          entity_type?: string | null
          event_type?: string
          id?: string
          payload?: Json
          read_at?: string | null
          scope?: string
          scope_key?: string | null
          snoozed_until?: string | null
          tier?: string
          user_id?: string
          workspace_id?: string
        }
        Relationships: []
      }
      inbox_entries_2028_05: {
        Row: {
          actor_user_id: string | null
          created_at: string
          deleted_at: string | null
          email_sent_at: string | null
          entity_id: string | null
          entity_type: string | null
          event_type: string
          id: string
          payload: Json
          read_at: string | null
          scope: string
          scope_key: string | null
          snoozed_until: string | null
          tier: string
          user_id: string
          workspace_id: string
        }
        Insert: {
          actor_user_id?: string | null
          created_at?: string
          deleted_at?: string | null
          email_sent_at?: string | null
          entity_id?: string | null
          entity_type?: string | null
          event_type: string
          id?: string
          payload?: Json
          read_at?: string | null
          scope: string
          scope_key?: string | null
          snoozed_until?: string | null
          tier?: string
          user_id: string
          workspace_id: string
        }
        Update: {
          actor_user_id?: string | null
          created_at?: string
          deleted_at?: string | null
          email_sent_at?: string | null
          entity_id?: string | null
          entity_type?: string | null
          event_type?: string
          id?: string
          payload?: Json
          read_at?: string | null
          scope?: string
          scope_key?: string | null
          snoozed_until?: string | null
          tier?: string
          user_id?: string
          workspace_id?: string
        }
        Relationships: []
      }
      inbox_entries_2028_06: {
        Row: {
          actor_user_id: string | null
          created_at: string
          deleted_at: string | null
          email_sent_at: string | null
          entity_id: string | null
          entity_type: string | null
          event_type: string
          id: string
          payload: Json
          read_at: string | null
          scope: string
          scope_key: string | null
          snoozed_until: string | null
          tier: string
          user_id: string
          workspace_id: string
        }
        Insert: {
          actor_user_id?: string | null
          created_at?: string
          deleted_at?: string | null
          email_sent_at?: string | null
          entity_id?: string | null
          entity_type?: string | null
          event_type: string
          id?: string
          payload?: Json
          read_at?: string | null
          scope: string
          scope_key?: string | null
          snoozed_until?: string | null
          tier?: string
          user_id: string
          workspace_id: string
        }
        Update: {
          actor_user_id?: string | null
          created_at?: string
          deleted_at?: string | null
          email_sent_at?: string | null
          entity_id?: string | null
          entity_type?: string | null
          event_type?: string
          id?: string
          payload?: Json
          read_at?: string | null
          scope?: string
          scope_key?: string | null
          snoozed_until?: string | null
          tier?: string
          user_id?: string
          workspace_id?: string
        }
        Relationships: []
      }
      inbox_entries_2028_07: {
        Row: {
          actor_user_id: string | null
          created_at: string
          deleted_at: string | null
          email_sent_at: string | null
          entity_id: string | null
          entity_type: string | null
          event_type: string
          id: string
          payload: Json
          read_at: string | null
          scope: string
          scope_key: string | null
          snoozed_until: string | null
          tier: string
          user_id: string
          workspace_id: string
        }
        Insert: {
          actor_user_id?: string | null
          created_at?: string
          deleted_at?: string | null
          email_sent_at?: string | null
          entity_id?: string | null
          entity_type?: string | null
          event_type: string
          id?: string
          payload?: Json
          read_at?: string | null
          scope: string
          scope_key?: string | null
          snoozed_until?: string | null
          tier?: string
          user_id: string
          workspace_id: string
        }
        Update: {
          actor_user_id?: string | null
          created_at?: string
          deleted_at?: string | null
          email_sent_at?: string | null
          entity_id?: string | null
          entity_type?: string | null
          event_type?: string
          id?: string
          payload?: Json
          read_at?: string | null
          scope?: string
          scope_key?: string | null
          snoozed_until?: string | null
          tier?: string
          user_id?: string
          workspace_id?: string
        }
        Relationships: []
      }
      inbox_entries_2028_08: {
        Row: {
          actor_user_id: string | null
          created_at: string
          deleted_at: string | null
          email_sent_at: string | null
          entity_id: string | null
          entity_type: string | null
          event_type: string
          id: string
          payload: Json
          read_at: string | null
          scope: string
          scope_key: string | null
          snoozed_until: string | null
          tier: string
          user_id: string
          workspace_id: string
        }
        Insert: {
          actor_user_id?: string | null
          created_at?: string
          deleted_at?: string | null
          email_sent_at?: string | null
          entity_id?: string | null
          entity_type?: string | null
          event_type: string
          id?: string
          payload?: Json
          read_at?: string | null
          scope: string
          scope_key?: string | null
          snoozed_until?: string | null
          tier?: string
          user_id: string
          workspace_id: string
        }
        Update: {
          actor_user_id?: string | null
          created_at?: string
          deleted_at?: string | null
          email_sent_at?: string | null
          entity_id?: string | null
          entity_type?: string | null
          event_type?: string
          id?: string
          payload?: Json
          read_at?: string | null
          scope?: string
          scope_key?: string | null
          snoozed_until?: string | null
          tier?: string
          user_id?: string
          workspace_id?: string
        }
        Relationships: []
      }
      inbox_entries_2028_09: {
        Row: {
          actor_user_id: string | null
          created_at: string
          deleted_at: string | null
          email_sent_at: string | null
          entity_id: string | null
          entity_type: string | null
          event_type: string
          id: string
          payload: Json
          read_at: string | null
          scope: string
          scope_key: string | null
          snoozed_until: string | null
          tier: string
          user_id: string
          workspace_id: string
        }
        Insert: {
          actor_user_id?: string | null
          created_at?: string
          deleted_at?: string | null
          email_sent_at?: string | null
          entity_id?: string | null
          entity_type?: string | null
          event_type: string
          id?: string
          payload?: Json
          read_at?: string | null
          scope: string
          scope_key?: string | null
          snoozed_until?: string | null
          tier?: string
          user_id: string
          workspace_id: string
        }
        Update: {
          actor_user_id?: string | null
          created_at?: string
          deleted_at?: string | null
          email_sent_at?: string | null
          entity_id?: string | null
          entity_type?: string | null
          event_type?: string
          id?: string
          payload?: Json
          read_at?: string | null
          scope?: string
          scope_key?: string | null
          snoozed_until?: string | null
          tier?: string
          user_id?: string
          workspace_id?: string
        }
        Relationships: []
      }
      inbox_entries_2028_10: {
        Row: {
          actor_user_id: string | null
          created_at: string
          deleted_at: string | null
          email_sent_at: string | null
          entity_id: string | null
          entity_type: string | null
          event_type: string
          id: string
          payload: Json
          read_at: string | null
          scope: string
          scope_key: string | null
          snoozed_until: string | null
          tier: string
          user_id: string
          workspace_id: string
        }
        Insert: {
          actor_user_id?: string | null
          created_at?: string
          deleted_at?: string | null
          email_sent_at?: string | null
          entity_id?: string | null
          entity_type?: string | null
          event_type: string
          id?: string
          payload?: Json
          read_at?: string | null
          scope: string
          scope_key?: string | null
          snoozed_until?: string | null
          tier?: string
          user_id: string
          workspace_id: string
        }
        Update: {
          actor_user_id?: string | null
          created_at?: string
          deleted_at?: string | null
          email_sent_at?: string | null
          entity_id?: string | null
          entity_type?: string | null
          event_type?: string
          id?: string
          payload?: Json
          read_at?: string | null
          scope?: string
          scope_key?: string | null
          snoozed_until?: string | null
          tier?: string
          user_id?: string
          workspace_id?: string
        }
        Relationships: []
      }
      inbox_entries_2028_11: {
        Row: {
          actor_user_id: string | null
          created_at: string
          deleted_at: string | null
          email_sent_at: string | null
          entity_id: string | null
          entity_type: string | null
          event_type: string
          id: string
          payload: Json
          read_at: string | null
          scope: string
          scope_key: string | null
          snoozed_until: string | null
          tier: string
          user_id: string
          workspace_id: string
        }
        Insert: {
          actor_user_id?: string | null
          created_at?: string
          deleted_at?: string | null
          email_sent_at?: string | null
          entity_id?: string | null
          entity_type?: string | null
          event_type: string
          id?: string
          payload?: Json
          read_at?: string | null
          scope: string
          scope_key?: string | null
          snoozed_until?: string | null
          tier?: string
          user_id: string
          workspace_id: string
        }
        Update: {
          actor_user_id?: string | null
          created_at?: string
          deleted_at?: string | null
          email_sent_at?: string | null
          entity_id?: string | null
          entity_type?: string | null
          event_type?: string
          id?: string
          payload?: Json
          read_at?: string | null
          scope?: string
          scope_key?: string | null
          snoozed_until?: string | null
          tier?: string
          user_id?: string
          workspace_id?: string
        }
        Relationships: []
      }
      inbox_entries_2028_12: {
        Row: {
          actor_user_id: string | null
          created_at: string
          deleted_at: string | null
          email_sent_at: string | null
          entity_id: string | null
          entity_type: string | null
          event_type: string
          id: string
          payload: Json
          read_at: string | null
          scope: string
          scope_key: string | null
          snoozed_until: string | null
          tier: string
          user_id: string
          workspace_id: string
        }
        Insert: {
          actor_user_id?: string | null
          created_at?: string
          deleted_at?: string | null
          email_sent_at?: string | null
          entity_id?: string | null
          entity_type?: string | null
          event_type: string
          id?: string
          payload?: Json
          read_at?: string | null
          scope: string
          scope_key?: string | null
          snoozed_until?: string | null
          tier?: string
          user_id: string
          workspace_id: string
        }
        Update: {
          actor_user_id?: string | null
          created_at?: string
          deleted_at?: string | null
          email_sent_at?: string | null
          entity_id?: string | null
          entity_type?: string | null
          event_type?: string
          id?: string
          payload?: Json
          read_at?: string | null
          scope?: string
          scope_key?: string | null
          snoozed_until?: string | null
          tier?: string
          user_id?: string
          workspace_id?: string
        }
        Relationships: []
      }
      inbox_entries_default: {
        Row: {
          actor_user_id: string | null
          created_at: string
          deleted_at: string | null
          email_sent_at: string | null
          entity_id: string | null
          entity_type: string | null
          event_type: string
          id: string
          payload: Json
          read_at: string | null
          scope: string
          scope_key: string | null
          snoozed_until: string | null
          tier: string
          user_id: string
          workspace_id: string
        }
        Insert: {
          actor_user_id?: string | null
          created_at?: string
          deleted_at?: string | null
          email_sent_at?: string | null
          entity_id?: string | null
          entity_type?: string | null
          event_type: string
          id?: string
          payload?: Json
          read_at?: string | null
          scope: string
          scope_key?: string | null
          snoozed_until?: string | null
          tier?: string
          user_id: string
          workspace_id: string
        }
        Update: {
          actor_user_id?: string | null
          created_at?: string
          deleted_at?: string | null
          email_sent_at?: string | null
          entity_id?: string | null
          entity_type?: string | null
          event_type?: string
          id?: string
          payload?: Json
          read_at?: string | null
          scope?: string
          scope_key?: string | null
          snoozed_until?: string | null
          tier?: string
          user_id?: string
          workspace_id?: string
        }
        Relationships: []
      }
      intent_ledger: {
        Row: {
          action: string
          committed_at: string | null
          created_at: string
          expires_at: string
          id: string
          operator_user_id: string
          payload: Json
          reason_category: string | null
          reason_text: string | null
          status: string
          target_id: string | null
          target_type: string | null
          ticket_id: string | null
          trace_id: string
        }
        Insert: {
          action: string
          committed_at?: string | null
          created_at?: string
          expires_at?: string
          id?: string
          operator_user_id: string
          payload: Json
          reason_category?: string | null
          reason_text?: string | null
          status?: string
          target_id?: string | null
          target_type?: string | null
          ticket_id?: string | null
          trace_id: string
        }
        Update: {
          action?: string
          committed_at?: string | null
          created_at?: string
          expires_at?: string
          id?: string
          operator_user_id?: string
          payload?: Json
          reason_category?: string | null
          reason_text?: string | null
          status?: string
          target_id?: string | null
          target_type?: string | null
          ticket_id?: string | null
          trace_id?: string
        }
        Relationships: []
      }
      pending_flows: {
        Row: {
          created_at: string
          expires_at: string
          external_ref: string | null
          external_system: string
          flow_type: string
          id: string
          operator_user_id: string
          payload: Json
          resolved_at: string | null
          status: string
        }
        Insert: {
          created_at?: string
          expires_at?: string
          external_ref?: string | null
          external_system: string
          flow_type: string
          id?: string
          operator_user_id: string
          payload: Json
          resolved_at?: string | null
          status?: string
        }
        Update: {
          created_at?: string
          expires_at?: string
          external_ref?: string | null
          external_system?: string
          flow_type?: string
          id?: string
          operator_user_id?: string
          payload?: Json
          resolved_at?: string | null
          status?: string
        }
        Relationships: []
      }
      platform_operators: {
        Row: {
          granted_at: string
          granted_by: string | null
          passkey_credential_id: string | null
          revoked_at: string | null
          user_id: string
        }
        Insert: {
          granted_at?: string
          granted_by?: string | null
          passkey_credential_id?: string | null
          revoked_at?: string | null
          user_id: string
        }
        Update: {
          granted_at?: string
          granted_by?: string | null
          passkey_credential_id?: string | null
          revoked_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "platform_operators_granted_by_fkey"
            columns: ["granted_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      post_annotations: {
        Row: {
          asset_attachment_id: string | null
          caption_end: number | null
          caption_start: number | null
          comment_id: string
          created_at: string
          id: string
          image_x: number | null
          image_y: number | null
          kind: string
          post_id: string
          post_version_id: string
          workspace_id: string
        }
        Insert: {
          asset_attachment_id?: string | null
          caption_end?: number | null
          caption_start?: number | null
          comment_id: string
          created_at?: string
          id?: string
          image_x?: number | null
          image_y?: number | null
          kind: string
          post_id: string
          post_version_id: string
          workspace_id: string
        }
        Update: {
          asset_attachment_id?: string | null
          caption_end?: number | null
          caption_start?: number | null
          comment_id?: string
          created_at?: string
          id?: string
          image_x?: number | null
          image_y?: number | null
          kind?: string
          post_id?: string
          post_version_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "post_annotations_asset_attachment_id_fkey"
            columns: ["asset_attachment_id"]
            isOneToOne: false
            referencedRelation: "asset_attachments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "post_annotations_comment_id_fkey"
            columns: ["comment_id"]
            isOneToOne: false
            referencedRelation: "comments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "post_annotations_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "post_annotations_post_version_id_fkey"
            columns: ["post_version_id"]
            isOneToOne: false
            referencedRelation: "post_versions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "post_annotations_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      post_ready_notifications: {
        Row: {
          checkpoint_count: number
          id: string
          post_id: string
          sent_at: string
          sent_by: string | null
          workspace_id: string
        }
        Insert: {
          checkpoint_count: number
          id?: string
          post_id: string
          sent_at?: string
          sent_by?: string | null
          workspace_id: string
        }
        Update: {
          checkpoint_count?: number
          id?: string
          post_id?: string
          sent_at?: string
          sent_by?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "post_ready_notifications_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "post_ready_notifications_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      post_versions: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          last_edited_at: string | null
          legacy_author_name: string | null
          post_id: string
          snapshot: Json
          version_number: number
          workspace_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          last_edited_at?: string | null
          legacy_author_name?: string | null
          post_id: string
          snapshot: Json
          version_number: number
          workspace_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          last_edited_at?: string | null
          legacy_author_name?: string | null
          post_id?: string
          snapshot?: Json
          version_number?: number
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "post_versions_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "post_versions_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "post_versions_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      posts: {
        Row: {
          brief_id: string | null
          bucket_id: string | null
          caption: string | null
          created_at: string
          created_by: string | null
          deleted_at: string | null
          format: string
          id: string
          legacy_author_name: string | null
          number: number
          origin: string
          owner_user_id: string | null
          platform: string
          row_version: number
          stage: string
          stage_entered_at: string
          target_date: string | null
          title: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          brief_id?: string | null
          bucket_id?: string | null
          caption?: string | null
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          format: string
          id?: string
          legacy_author_name?: string | null
          number: number
          origin?: string
          owner_user_id?: string | null
          platform: string
          row_version?: number
          stage?: string
          stage_entered_at?: string
          target_date?: string | null
          title: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          brief_id?: string | null
          bucket_id?: string | null
          caption?: string | null
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          format?: string
          id?: string
          legacy_author_name?: string | null
          number?: number
          origin?: string
          owner_user_id?: string | null
          platform?: string
          row_version?: number
          stage?: string
          stage_entered_at?: string
          target_date?: string | null
          title?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "posts_brief_id_fkey"
            columns: ["brief_id"]
            isOneToOne: false
            referencedRelation: "briefs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "posts_bucket_id_fkey"
            columns: ["bucket_id"]
            isOneToOne: false
            referencedRelation: "workspace_buckets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "posts_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "posts_owner_user_id_fkey"
            columns: ["owner_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "posts_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      session_devices: {
        Row: {
          created_at: string
          fingerprint_hash: string
          id: string
          ip_subnet: unknown
          last_seen_at: string
          revoked_at: string | null
          user_agent: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          fingerprint_hash: string
          id?: string
          ip_subnet?: unknown
          last_seen_at?: string
          revoked_at?: string | null
          user_agent?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          fingerprint_hash?: string
          id?: string
          ip_subnet?: unknown
          last_seen_at?: string
          revoked_at?: string | null
          user_agent?: string | null
          user_id?: string
        }
        Relationships: []
      }
      users: {
        Row: {
          avatar_url: string | null
          created_at: string
          deleted_at: string | null
          designation: string | null
          display_name: string
          email_opt_in: boolean
          id: string
          profile_completed_at: string | null
          timezone: string | null
          updated_at: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          deleted_at?: string | null
          designation?: string | null
          display_name: string
          email_opt_in?: boolean
          id: string
          profile_completed_at?: string | null
          timezone?: string | null
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          deleted_at?: string | null
          designation?: string | null
          display_name?: string
          email_opt_in?: boolean
          id?: string
          profile_completed_at?: string | null
          timezone?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      webhook_events: {
        Row: {
          event_type: string
          id: string
          raw_payload: Json
          received_at: string
          signature_verified: boolean
          source: string
          source_event_id: string
          workspace_id: string | null
        }
        Insert: {
          event_type: string
          id?: string
          raw_payload: Json
          received_at?: string
          signature_verified: boolean
          source: string
          source_event_id: string
          workspace_id?: string | null
        }
        Update: {
          event_type?: string
          id?: string
          raw_payload?: Json
          received_at?: string
          signature_verified?: boolean
          source?: string
          source_event_id?: string
          workspace_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "webhook_events_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      webhook_processing_attempts: {
        Row: {
          attempt_number: number
          error: string | null
          finished_at: string | null
          id: string
          outcome: string | null
          started_at: string
          trace_id: string
          webhook_event_id: string
        }
        Insert: {
          attempt_number: number
          error?: string | null
          finished_at?: string | null
          id?: string
          outcome?: string | null
          started_at?: string
          trace_id: string
          webhook_event_id: string
        }
        Update: {
          attempt_number?: number
          error?: string | null
          finished_at?: string | null
          id?: string
          outcome?: string | null
          started_at?: string
          trace_id?: string
          webhook_event_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "webhook_processing_attempts_webhook_event_id_fkey"
            columns: ["webhook_event_id"]
            isOneToOne: false
            referencedRelation: "webhook_events"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_buckets: {
        Row: {
          archived: boolean
          color_hex: string
          created_at: string
          id: string
          name: string
          position: number
          target_month: number
          workspace_id: string
        }
        Insert: {
          archived?: boolean
          color_hex: string
          created_at?: string
          id?: string
          name: string
          position?: number
          target_month?: number
          workspace_id: string
        }
        Update: {
          archived?: boolean
          color_hex?: string
          created_at?: string
          id?: string
          name?: string
          position?: number
          target_month?: number
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_buckets_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_counters: {
        Row: {
          next_entity_number: number
          workspace_id: string
        }
        Insert: {
          next_entity_number?: number
          workspace_id: string
        }
        Update: {
          next_entity_number?: number
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_counters_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: true
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_members: {
        Row: {
          accepted_at: string | null
          active: boolean
          id: string
          invited_at: string
          invited_by: string | null
          rejoined_at: string | null
          removed_at: string | null
          role: string
          user_id: string
          workspace_id: string
        }
        Insert: {
          accepted_at?: string | null
          active?: boolean
          id?: string
          invited_at?: string
          invited_by?: string | null
          rejoined_at?: string | null
          removed_at?: string | null
          role: string
          user_id: string
          workspace_id: string
        }
        Update: {
          accepted_at?: string | null
          active?: boolean
          id?: string
          invited_at?: string
          invited_by?: string | null
          rejoined_at?: string | null
          removed_at?: string | null
          role?: string
          user_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_members_invited_by_fkey"
            columns: ["invited_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workspace_members_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_onboarding: {
        Row: {
          auto_hidden_at: string | null
          dismissed_at: string | null
          first_brief_at: string | null
          first_invite_at: string | null
          first_post_at: string | null
          workspace_id: string
        }
        Insert: {
          auto_hidden_at?: string | null
          dismissed_at?: string | null
          first_brief_at?: string | null
          first_invite_at?: string | null
          first_post_at?: string | null
          workspace_id: string
        }
        Update: {
          auto_hidden_at?: string | null
          dismissed_at?: string | null
          first_brief_at?: string | null
          first_invite_at?: string | null
          first_post_at?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_onboarding_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: true
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_role_permissions: {
        Row: {
          allowed: boolean
          capability: string
          role: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          allowed?: boolean
          capability: string
          role: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          allowed?: boolean
          capability?: string
          role?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_role_permissions_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_settings: {
        Row: {
          payload: Json
          updated_at: string
          updated_by: string | null
          workspace_id: string
        }
        Insert: {
          payload?: Json
          updated_at?: string
          updated_by?: string | null
          workspace_id: string
        }
        Update: {
          payload?: Json
          updated_at?: string
          updated_by?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_settings_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workspace_settings_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: true
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspaces: {
        Row: {
          activated_at: string | null
          asset_bucket: string | null
          created_at: string
          deleted_at: string | null
          digest_default_time: string
          id: string
          key: string
          name: string
          owner_user_id: string
          plan_tier: string
          platform: string | null
          row_version: number
          stripe_customer_id: string | null
          stripe_subscription_id: string | null
          subscription_state: string
          subscription_state_expires_at: string | null
          target_distributions: Json | null
          timezone: string
          trial_ends_at: string | null
          updated_at: string
          week_start_day: number
        }
        Insert: {
          activated_at?: string | null
          asset_bucket?: string | null
          created_at?: string
          deleted_at?: string | null
          digest_default_time?: string
          id?: string
          key: string
          name: string
          owner_user_id: string
          plan_tier?: string
          platform?: string | null
          row_version?: number
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          subscription_state?: string
          subscription_state_expires_at?: string | null
          target_distributions?: Json | null
          timezone: string
          trial_ends_at?: string | null
          updated_at?: string
          week_start_day?: number
        }
        Update: {
          activated_at?: string | null
          asset_bucket?: string | null
          created_at?: string
          deleted_at?: string | null
          digest_default_time?: string
          id?: string
          key?: string
          name?: string
          owner_user_id?: string
          plan_tier?: string
          platform?: string | null
          row_version?: number
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          subscription_state?: string
          subscription_state_expires_at?: string | null
          target_distributions?: Json | null
          timezone?: string
          trial_ends_at?: string | null
          updated_at?: string
          week_start_day?: number
        }
        Relationships: [
          {
            foreignKeyName: "workspaces_owner_user_id_fkey"
            columns: ["owner_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      _post_snapshot: { Args: { p_post_id: string }; Returns: Json }
      annotation_create: {
        Args: {
          p_asset_attachment_id: string
          p_caption_end: number
          p_caption_start: number
          p_comment_id: string
          p_image_x: number
          p_image_y: number
          p_kind: string
          p_post_id: string
          p_post_version_id: string
          p_trace_id: string
        }
        Returns: string
      }
      asset_delete: {
        Args: { p_asset_id: string; p_trace_id: string }
        Returns: undefined
      }
      asset_delete_many: {
        Args: { p_asset_ids: string[]; p_trace_id: string }
        Returns: undefined
      }
      audit_log_write: {
        Args: {
          p_action: string
          p_entity_id?: string
          p_entity_type?: string
          p_error_code?: string
          p_impersonation_session_id?: string
          p_ip_subnet?: unknown
          p_on_behalf_of?: string
          p_outcome: string
          p_payload?: Json
          p_trace_id: string
          p_workspace_id?: string
        }
        Returns: string
      }
      brief_close: {
        Args: { p_brief_id: string; p_trace_id: string }
        Returns: undefined
      }
      brief_create: {
        Args: { p_payload: Json; p_trace_id: string; p_workspace_id: string }
        Returns: string
      }
      chat_channel_mark_synced: {
        Args: {
          p_agora_group_id: string
          p_channel_id: string
          p_trace_id: string
        }
        Returns: undefined
      }
      chat_message_save: {
        Args: {
          p_agora_message_id: string
          p_attachment_asset_ids?: string[]
          p_body?: string
          p_channel_id: string
          p_created_at: string
          p_mentions?: Json
          p_trace_id?: string
        }
        Returns: undefined
      }
      chat_webhook_ingest: {
        Args: {
          p_agora_event_id: string
          p_attachment_asset_ids: string[]
          p_body: string
          p_channel_id: string
          p_created_at: string
          p_event_type: string
          p_mentions: Json
          p_message_id: string
          p_raw_payload: Json
          p_sender_user_id: string
          p_signature_verified: boolean
          p_source_event_id: string
          p_trace_id: string
        }
        Returns: Json
      }
      checkpoint_accept: {
        Args: { p_accepted: boolean; p_comment_id: string; p_trace_id: string }
        Returns: undefined
      }
      checkpoint_ask: {
        Args: { p_body: string; p_comment_id: string; p_trace_id: string }
        Returns: string
      }
      checkpoint_send_back: {
        Args: { p_body: string; p_comment_id: string; p_trace_id: string }
        Returns: string
      }
      comment_batch_create: {
        Args: {
          p_points: Json
          p_post_id: string
          p_trace_id: string
          p_workspace_id: string
        }
        Returns: Json
      }
      comment_create: {
        Args: {
          p_attachment_asset_ids: string[]
          p_body: string
          p_entity_id: string
          p_entity_type: string
          p_mentions: Json
          p_parent_comment_id: string
          p_trace_id: string
          p_workspace_id: string
        }
        Returns: string
      }
      comment_delete: {
        Args: { p_comment_id: string; p_trace_id: string }
        Returns: undefined
      }
      comment_edit: {
        Args: { p_body: string; p_comment_id: string; p_trace_id: string }
        Returns: string
      }
      comment_resolve: {
        Args: {
          p_comment_id: string
          p_resolution_note?: string
          p_resolved: boolean
          p_trace_id: string
        }
        Returns: undefined
      }
      comment_soft_delete: {
        Args: { p_comment_id: string; p_trace_id: string }
        Returns: string
      }
      dm_channel_ensure: {
        Args: {
          p_other_user_id: string
          p_trace_id: string
          p_workspace_id: string
        }
        Returns: string
      }
      ensure_future_partitions: {
        Args: { p_months?: number }
        Returns: undefined
      }
      gallery_set: {
        Args: {
          p_asset_version_ids: string[]
          p_post_id: string
          p_trace_id: string
        }
        Returns: string
      }
      group_create: {
        Args: {
          p_member_user_ids: string[]
          p_name: string
          p_trace_id: string
          p_workspace_id: string
        }
        Returns: string
      }
      group_leave: {
        Args: { p_group_id: string; p_trace_id: string }
        Returns: undefined
      }
      group_member_add: {
        Args: { p_group_id: string; p_trace_id: string; p_user_id: string }
        Returns: undefined
      }
      group_member_remove: {
        Args: { p_group_id: string; p_trace_id: string; p_user_id: string }
        Returns: undefined
      }
      group_rename: {
        Args: { p_group_id: string; p_name: string; p_trace_id: string }
        Returns: undefined
      }
      has_capability: { Args: { p_capability: string }; Returns: boolean }
      inbox_entry_create: {
        Args: {
          p_actor_user_id?: string
          p_entity_id: string
          p_entity_type: string
          p_event_type: string
          p_payload: Json
          p_scope: string
          p_scope_key: string
          p_tier: string
          p_trace_id: string
          p_user_id: string
          p_workspace_id: string
        }
        Returns: string
      }
      inbox_mark_all_read: {
        Args: { p_trace_id: string; p_workspace_id: string }
        Returns: undefined
      }
      inbox_mark_read: {
        Args: {
          p_created_at: string
          p_entry_id: string
          p_trace_id: string
          p_workspace_id: string
        }
        Returns: undefined
      }
      inbox_snooze: {
        Args: {
          p_created_at: string
          p_entry_id: string
          p_kind: string
          p_trace_id: string
          p_workspace_id: string
        }
        Returns: undefined
      }
      is_active_workspace_member: {
        Args: { p_workspace_id: string }
        Returns: boolean
      }
      member_accept: {
        Args: { p_invite_id: string; p_trace_id: string }
        Returns: string
      }
      member_invite: {
        Args: {
          p_email: string
          p_role: string
          p_trace_id: string
          p_workspace_id: string
        }
        Returns: string
      }
      member_remove: {
        Args: { p_member_id: string; p_trace_id: string }
        Returns: string
      }
      post_caption_update: {
        Args: { p_caption: string; p_post_id: string; p_trace_id: string }
        Returns: string
      }
      post_create: {
        Args: { p_payload: Json; p_trace_id: string; p_workspace_id: string }
        Returns: string
      }
      post_ready_notify: {
        Args: { p_post_id: string; p_trace_id: string }
        Returns: undefined
      }
      post_soft_delete: {
        Args: { p_post_id: string; p_trace_id: string }
        Returns: string
      }
      post_update: {
        Args: { p_payload: Json; p_post_id: string; p_trace_id: string }
        Returns: string
      }
      post_version_create: {
        Args: { p_post_id: string; p_snapshot: Json; p_trace_id: string }
        Returns: string
      }
      proc_capability: {
        Args: { p_capability: string; p_workspace_id: string }
        Returns: boolean
      }
      show_limit: { Args: never; Returns: number }
      show_trgm: { Args: { "": string }; Returns: string[] }
      slugify_workspace: { Args: { p: string }; Returns: string }
      stage_transition: {
        Args: { p_post_id: string; p_to_stage: string; p_trace_id: string }
        Returns: string
      }
      user_profile_update: {
        Args: {
          p_avatar_url: string
          p_designation: string
          p_display_name: string
          p_email_opt_in: boolean
          p_trace_id: string
        }
        Returns: string
      }
      uuidv7: { Args: never; Returns: string }
      workspace_create: {
        Args: { p_payload: Json; p_trace_id: string }
        Returns: string
      }
      workspace_id: { Args: never; Returns: string }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
