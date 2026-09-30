// Generated from the live Supabase schema (Supabase MCP generate_typescript_types).
// Do not edit by hand. Regenerate after every migration.

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
    PostgrestVersion: "14.18"
  }
  public: {
    Tables: {
      answers: {
        Row: {
          answer: string
          category: string | null
          created_at: string
          id: string
          key: string | null
          last_used_at: string | null
          metadata: Json
          question: string
          source: string
          status: string
          tags: string[]
          times_used: number
          updated_at: string
          user_id: string
        }
        Insert: {
          answer: string
          category?: string | null
          created_at?: string
          id?: string
          key?: string | null
          last_used_at?: string | null
          metadata?: Json
          question: string
          source?: string
          status?: string
          tags?: string[]
          times_used?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          answer?: string
          category?: string | null
          created_at?: string
          id?: string
          key?: string | null
          last_used_at?: string | null
          metadata?: Json
          question?: string
          source?: string
          status?: string
          tags?: string[]
          times_used?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      application_events: {
        Row: {
          action_done: boolean
          action_due_at: string | null
          action_required: boolean
          application_id: string | null
          company_name: string | null
          created_at: string
          detail: string | null
          external_ref: string | null
          id: string
          metadata: Json
          occurred_at: string
          source: string
          subject: string | null
          type: string
          updated_at: string
          user_id: string
        }
        Insert: {
          action_done?: boolean
          action_due_at?: string | null
          action_required?: boolean
          application_id?: string | null
          company_name?: string | null
          created_at?: string
          detail?: string | null
          external_ref?: string | null
          id?: string
          metadata?: Json
          occurred_at?: string
          source?: string
          subject?: string | null
          type: string
          updated_at?: string
          user_id: string
        }
        Update: {
          action_done?: boolean
          action_due_at?: string | null
          action_required?: boolean
          application_id?: string | null
          company_name?: string | null
          created_at?: string
          detail?: string | null
          external_ref?: string | null
          id?: string
          metadata?: Json
          occurred_at?: string
          source?: string
          subject?: string | null
          type?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "application_events_application_id_user_id_fkey"
            columns: ["application_id", "user_id"]
            isOneToOne: false
            referencedRelation: "applications"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      application_questions: {
        Row: {
          answer: string | null
          answer_id: string | null
          application_id: string
          created_at: string
          field_type: string | null
          id: string
          metadata: Json
          options: Json | null
          question: string
          user_id: string
        }
        Insert: {
          answer?: string | null
          answer_id?: string | null
          application_id: string
          created_at?: string
          field_type?: string | null
          id?: string
          metadata?: Json
          options?: Json | null
          question: string
          user_id: string
        }
        Update: {
          answer?: string | null
          answer_id?: string | null
          application_id?: string
          created_at?: string
          field_type?: string | null
          id?: string
          metadata?: Json
          options?: Json | null
          question?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "application_questions_answer_id_user_id_fkey"
            columns: ["answer_id", "user_id"]
            isOneToOne: false
            referencedRelation: "answers"
            referencedColumns: ["id", "user_id"]
          },
          {
            foreignKeyName: "application_questions_application_id_user_id_fkey"
            columns: ["application_id", "user_id"]
            isOneToOne: false
            referencedRelation: "applications"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      applications: {
        Row: {
          applied_at: string | null
          company_name: string
          cover_note: string | null
          created_at: string
          employment_type: string | null
          experience_max_years: number | null
          experience_min_years: number | null
          external_id: string | null
          id: string
          job_description: string | null
          job_title: string
          job_url: string | null
          location: string | null
          match_score: number | null
          metadata: Json
          notes: string | null
          platform: string
          posted_at: string | null
          resume_id: string | null
          run_id: string | null
          salary_currency: string | null
          salary_max: number | null
          salary_min: number | null
          salary_period: string | null
          salary_text: string | null
          source: string | null
          stage: string
          status: string
          status_reason: string | null
          updated_at: string
          user_id: string
          work_mode: string | null
        }
        Insert: {
          applied_at?: string | null
          company_name: string
          cover_note?: string | null
          created_at?: string
          employment_type?: string | null
          experience_max_years?: number | null
          experience_min_years?: number | null
          external_id?: string | null
          id?: string
          job_description?: string | null
          job_title: string
          job_url?: string | null
          location?: string | null
          match_score?: number | null
          metadata?: Json
          notes?: string | null
          platform: string
          posted_at?: string | null
          resume_id?: string | null
          run_id?: string | null
          salary_currency?: string | null
          salary_max?: number | null
          salary_min?: number | null
          salary_period?: string | null
          salary_text?: string | null
          source?: string | null
          stage?: string
          status?: string
          status_reason?: string | null
          updated_at?: string
          user_id: string
          work_mode?: string | null
        }
        Update: {
          applied_at?: string | null
          company_name?: string
          cover_note?: string | null
          created_at?: string
          employment_type?: string | null
          experience_max_years?: number | null
          experience_min_years?: number | null
          external_id?: string | null
          id?: string
          job_description?: string | null
          job_title?: string
          job_url?: string | null
          location?: string | null
          match_score?: number | null
          metadata?: Json
          notes?: string | null
          platform?: string
          posted_at?: string | null
          resume_id?: string | null
          run_id?: string | null
          salary_currency?: string | null
          salary_max?: number | null
          salary_min?: number | null
          salary_period?: string | null
          salary_text?: string | null
          source?: string | null
          stage?: string
          status?: string
          status_reason?: string | null
          updated_at?: string
          user_id?: string
          work_mode?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "applications_resume_id_user_id_fkey"
            columns: ["resume_id", "user_id"]
            isOneToOne: false
            referencedRelation: "resumes"
            referencedColumns: ["id", "user_id"]
          },
          {
            foreignKeyName: "applications_run_id_user_id_fkey"
            columns: ["run_id", "user_id"]
            isOneToOne: false
            referencedRelation: "runs"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      educations: {
        Row: {
          created_at: string
          degree: string | null
          description: string | null
          end_date: string | null
          field_of_study: string | null
          grade: string | null
          grade_scale: string | null
          id: string
          institution: string
          metadata: Json
          sort_order: number
          start_date: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          degree?: string | null
          description?: string | null
          end_date?: string | null
          field_of_study?: string | null
          grade?: string | null
          grade_scale?: string | null
          id?: string
          institution: string
          metadata?: Json
          sort_order?: number
          start_date?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          degree?: string | null
          description?: string | null
          end_date?: string | null
          field_of_study?: string | null
          grade?: string | null
          grade_scale?: string | null
          id?: string
          institution?: string
          metadata?: Json
          sort_order?: number
          start_date?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      oauth_authorization_codes: {
        Row: {
          client_id: string
          code_challenge: string
          code_hash: string
          consumed_at: string | null
          created_at: string
          expires_at: string
          grant_id: string | null
          redirect_uri: string
          resource: string | null
          scopes: string[]
          user_id: string
        }
        Insert: {
          client_id: string
          code_challenge: string
          code_hash: string
          consumed_at?: string | null
          created_at?: string
          expires_at: string
          grant_id?: string | null
          redirect_uri: string
          resource?: string | null
          scopes?: string[]
          user_id: string
        }
        Update: {
          client_id?: string
          code_challenge?: string
          code_hash?: string
          consumed_at?: string | null
          created_at?: string
          expires_at?: string
          grant_id?: string | null
          redirect_uri?: string
          resource?: string | null
          scopes?: string[]
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "oauth_authorization_codes_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "oauth_clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "oauth_authorization_codes_grant_id_fkey"
            columns: ["grant_id"]
            isOneToOne: false
            referencedRelation: "oauth_grants"
            referencedColumns: ["id"]
          },
        ]
      }
      oauth_clients: {
        Row: {
          client_id_issued_at: number
          client_name: string | null
          client_secret: string | null
          client_secret_expires_at: number | null
          created_at: string
          id: string
          metadata: Json
          redirect_uris: string[]
          token_endpoint_auth_method: string
          updated_at: string
        }
        Insert: {
          client_id_issued_at: number
          client_name?: string | null
          client_secret?: string | null
          client_secret_expires_at?: number | null
          created_at?: string
          id: string
          metadata?: Json
          redirect_uris: string[]
          token_endpoint_auth_method?: string
          updated_at?: string
        }
        Update: {
          client_id_issued_at?: number
          client_name?: string | null
          client_secret?: string | null
          client_secret_expires_at?: number | null
          created_at?: string
          id?: string
          metadata?: Json
          redirect_uris?: string[]
          token_endpoint_auth_method?: string
          updated_at?: string
        }
        Relationships: []
      }
      oauth_grants: {
        Row: {
          client_id: string
          created_at: string
          id: string
          last_used_at: string | null
          metadata: Json
          refresh_token_expires_at: string | null
          refresh_token_hash: string | null
          resource: string | null
          revoked_at: string | null
          scopes: string[]
          updated_at: string
          user_id: string
        }
        Insert: {
          client_id: string
          created_at?: string
          id?: string
          last_used_at?: string | null
          metadata?: Json
          refresh_token_expires_at?: string | null
          refresh_token_hash?: string | null
          resource?: string | null
          revoked_at?: string | null
          scopes?: string[]
          updated_at?: string
          user_id: string
        }
        Update: {
          client_id?: string
          created_at?: string
          id?: string
          last_used_at?: string | null
          metadata?: Json
          refresh_token_expires_at?: string | null
          refresh_token_hash?: string | null
          resource?: string | null
          revoked_at?: string | null
          scopes?: string[]
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "oauth_grants_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "oauth_clients"
            referencedColumns: ["id"]
          },
        ]
      }
      preferences: {
        Row: {
          created_at: string
          daily_application_limit: number | null
          desired_locations: string[]
          desired_roles: string[]
          employment_types: string[]
          exclude_keywords: string[]
          excluded_companies: string[]
          expected_salary: number | null
          include_keywords: string[]
          max_posting_age_hours: number | null
          max_years_required: number | null
          min_salary: number | null
          notes: string | null
          platforms: string[]
          preferred_companies: string[]
          rules: Json
          salary_currency: string | null
          salary_period: string
          seniority_levels: string[]
          updated_at: string
          user_id: string
          willing_to_relocate: boolean | null
          work_modes: string[]
        }
        Insert: {
          created_at?: string
          daily_application_limit?: number | null
          desired_locations?: string[]
          desired_roles?: string[]
          employment_types?: string[]
          exclude_keywords?: string[]
          excluded_companies?: string[]
          expected_salary?: number | null
          include_keywords?: string[]
          max_posting_age_hours?: number | null
          max_years_required?: number | null
          min_salary?: number | null
          notes?: string | null
          platforms?: string[]
          preferred_companies?: string[]
          rules?: Json
          salary_currency?: string | null
          salary_period?: string
          seniority_levels?: string[]
          updated_at?: string
          user_id: string
          willing_to_relocate?: boolean | null
          work_modes?: string[]
        }
        Update: {
          created_at?: string
          daily_application_limit?: number | null
          desired_locations?: string[]
          desired_roles?: string[]
          employment_types?: string[]
          exclude_keywords?: string[]
          excluded_companies?: string[]
          expected_salary?: number | null
          include_keywords?: string[]
          max_posting_age_hours?: number | null
          max_years_required?: number | null
          min_salary?: number | null
          notes?: string | null
          platforms?: string[]
          preferred_companies?: string[]
          rules?: Json
          salary_currency?: string | null
          salary_period?: string
          seniority_levels?: string[]
          updated_at?: string
          user_id?: string
          willing_to_relocate?: boolean | null
          work_modes?: string[]
        }
        Relationships: []
      }
      profiles: {
        Row: {
          created_at: string
          current_company: string | null
          current_salary: number | null
          current_salary_currency: string | null
          current_salary_period: string
          current_title: string | null
          earliest_start_date: string | null
          email: string | null
          full_name: string | null
          headline: string | null
          id: string
          languages: string[]
          links: Json
          location_city: string | null
          location_country: string | null
          location_region: string | null
          metadata: Json
          notice_period_days: number | null
          onboarded_at: string | null
          phone: string | null
          preferred_name: string | null
          skills: string[]
          summary: string | null
          timezone: string | null
          updated_at: string
          years_experience: number | null
        }
        Insert: {
          created_at?: string
          current_company?: string | null
          current_salary?: number | null
          current_salary_currency?: string | null
          current_salary_period?: string
          current_title?: string | null
          earliest_start_date?: string | null
          email?: string | null
          full_name?: string | null
          headline?: string | null
          id: string
          languages?: string[]
          links?: Json
          location_city?: string | null
          location_country?: string | null
          location_region?: string | null
          metadata?: Json
          notice_period_days?: number | null
          onboarded_at?: string | null
          phone?: string | null
          preferred_name?: string | null
          skills?: string[]
          summary?: string | null
          timezone?: string | null
          updated_at?: string
          years_experience?: number | null
        }
        Update: {
          created_at?: string
          current_company?: string | null
          current_salary?: number | null
          current_salary_currency?: string | null
          current_salary_period?: string
          current_title?: string | null
          earliest_start_date?: string | null
          email?: string | null
          full_name?: string | null
          headline?: string | null
          id?: string
          languages?: string[]
          links?: Json
          location_city?: string | null
          location_country?: string | null
          location_region?: string | null
          metadata?: Json
          notice_period_days?: number | null
          onboarded_at?: string | null
          phone?: string | null
          preferred_name?: string | null
          skills?: string[]
          summary?: string | null
          timezone?: string | null
          updated_at?: string
          years_experience?: number | null
        }
        Relationships: []
      }
      resumes: {
        Row: {
          archived_at: string | null
          content: string | null
          created_at: string
          file_name: string | null
          file_path: string | null
          file_size_bytes: number | null
          id: string
          is_default: boolean
          label: string
          metadata: Json
          mime_type: string | null
          structured: Json | null
          updated_at: string
          user_id: string
        }
        Insert: {
          archived_at?: string | null
          content?: string | null
          created_at?: string
          file_name?: string | null
          file_path?: string | null
          file_size_bytes?: number | null
          id?: string
          is_default?: boolean
          label?: string
          metadata?: Json
          mime_type?: string | null
          structured?: Json | null
          updated_at?: string
          user_id: string
        }
        Update: {
          archived_at?: string | null
          content?: string | null
          created_at?: string
          file_name?: string | null
          file_path?: string | null
          file_size_bytes?: number | null
          id?: string
          is_default?: boolean
          label?: string
          metadata?: Json
          mime_type?: string | null
          structured?: Json | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      runs: {
        Row: {
          client: string | null
          created_at: string
          ended_at: string | null
          id: string
          metadata: Json
          started_at: string
          stats: Json
          summary: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          client?: string | null
          created_at?: string
          ended_at?: string | null
          id?: string
          metadata?: Json
          started_at?: string
          stats?: Json
          summary?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          client?: string | null
          created_at?: string
          ended_at?: string | null
          id?: string
          metadata?: Json
          started_at?: string
          stats?: Json
          summary?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      subscriptions: {
        Row: {
          cancel_at_period_end: boolean
          created_at: string
          current_period_end: string | null
          id: string
          metadata: Json
          status: string
          stripe_customer_id: string | null
          stripe_price_id: string | null
          stripe_subscription_id: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          cancel_at_period_end?: boolean
          created_at?: string
          current_period_end?: string | null
          id?: string
          metadata?: Json
          status?: string
          stripe_customer_id?: string | null
          stripe_price_id?: string | null
          stripe_subscription_id?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          cancel_at_period_end?: boolean
          created_at?: string
          current_period_end?: string | null
          id?: string
          metadata?: Json
          status?: string
          stripe_customer_id?: string | null
          stripe_price_id?: string | null
          stripe_subscription_id?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      work_experiences: {
        Row: {
          company: string
          created_at: string
          description: string | null
          employment_type: string | null
          end_date: string | null
          highlights: string[]
          id: string
          is_current: boolean
          location: string | null
          metadata: Json
          skills: string[]
          sort_order: number
          start_date: string | null
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          company: string
          created_at?: string
          description?: string | null
          employment_type?: string | null
          end_date?: string | null
          highlights?: string[]
          id?: string
          is_current?: boolean
          location?: string | null
          metadata?: Json
          skills?: string[]
          sort_order?: number
          start_date?: string | null
          title: string
          updated_at?: string
          user_id: string
        }
        Update: {
          company?: string
          created_at?: string
          description?: string | null
          employment_type?: string | null
          end_date?: string | null
          highlights?: string[]
          id?: string
          is_current?: boolean
          location?: string | null
          metadata?: Json
          skills?: string[]
          sort_order?: number
          start_date?: string | null
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      application_stats: {
        Args: { p_tz?: string; p_user_id: string }
        Returns: Json
      }
      check_existing_applications: {
        Args: {
          p_companies: string[]
          p_external_ids: string[]
          p_platform: string
          p_user_id: string
        }
        Returns: Json
      }
      find_similar_answers: {
        Args: {
          p_limit?: number
          p_min_score?: number
          p_query: string
          p_user_id: string
        }
        Returns: {
          answer: string
          company_name: string
          id: string
          job_title: string
          key: string
          last_used_at: string
          question: string
          score: number
          source: string
          status: string
        }[]
      }
      mark_answers_used: {
        Args: { p_answer_ids: string[]; p_user_id: string }
        Returns: undefined
      }
      recompute_application_stage: {
        Args: { p_application_id: string }
        Returns: undefined
      }
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
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
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
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
