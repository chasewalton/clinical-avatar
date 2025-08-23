-- Clinical Avatar Database Schema for Supabase

-- Conversations table to track phone call sessions
create table IF NOT EXISTS public.conversations (
  id uuid not null default gen_random_uuid (),
  call_sid text not null,
  phone_number text null,
  status text null default 'active'::text,
  started_at timestamp with time zone null default now(),
  ended_at timestamp with time zone null,
  updated_at timestamp with time zone null default now(),
  clinical_data jsonb null default '{}'::jsonb,
  summary text null,
  metadata jsonb null default '{}'::jsonb,
  constraint conversations_pkey primary key (id),
  constraint conversations_call_sid_key unique (call_sid),
  constraint conversations_status_check check (
    (
      status = any (
        array['active'::text, 'completed'::text, 'failed'::text]
      )
    )
  )
) TABLESPACE pg_default;

-- Messages table to store AI questions and user responses
create table IF NOT EXISTS public.messages (
  id uuid not null default gen_random_uuid (),
  conversation_id uuid not null,
  role text not null,
  content text not null,
  audio_data text null,
  timestamp timestamp with time zone null default now(),
  metadata jsonb null default '{}'::jsonb,
  constraint messages_pkey primary key (id),
  constraint messages_conversation_id_fkey foreign key (conversation_id) references conversations (id) on delete cascade,
  constraint messages_role_check check (
    (
      role = any (
        array['user'::text, 'assistant'::text, 'system'::text]
      )
    )
  )
) TABLESPACE pg_default;

-- Clinical data extraction table for structured medical information
CREATE TABLE IF NOT EXISTS clinical_extractions (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
    field_name TEXT NOT NULL, -- e.g., 'chief_complaint', 'symptoms', 'medications'
    field_value TEXT NOT NULL,
    confidence_score DECIMAL(3,2), -- 0.00 to 1.00
    extracted_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    metadata JSONB DEFAULT '{}'
);

-- Indexes for better performance
create index IF not exists idx_conversations_call_sid on public.conversations using btree (call_sid) TABLESPACE pg_default;
create index IF not exists idx_conversations_status on public.conversations using btree (status) TABLESPACE pg_default;
create index IF not exists idx_conversations_started_at on public.conversations using btree (started_at) TABLESPACE pg_default;
create index IF not exists idx_messages_conversation_id on public.messages using btree (conversation_id) TABLESPACE pg_default;
create index IF not exists idx_messages_timestamp on public.messages using btree (timestamp) TABLESPACE pg_default;
create index IF not exists idx_clinical_extractions_conversation_id on public.clinical_extractions using btree (conversation_id) TABLESPACE pg_default;
create index IF not exists idx_clinical_extractions_field_name on public.clinical_extractions using btree (field_name) TABLESPACE pg_default;

-- Row Level Security (RLS) policies
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinical_extractions ENABLE ROW LEVEL SECURITY;

-- Allow service role to access all data
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'conversations' AND policyname = 'Service role can access all conversations') THEN
        CREATE POLICY "Service role can access all conversations" ON conversations
            FOR ALL USING (auth.role() = 'service_role');
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'messages' AND policyname = 'Service role can access all messages') THEN
        CREATE POLICY "Service role can access all messages" ON messages
            FOR ALL USING (auth.role() = 'service_role');
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'clinical_extractions' AND policyname = 'Service role can access all clinical extractions') THEN
        CREATE POLICY "Service role can access all clinical extractions" ON clinical_extractions
            FOR ALL USING (auth.role() = 'service_role');
    END IF;
END $$;

-- Functions for automatic timestamp updates
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Trigger to automatically update updated_at
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_conversations_updated_at') THEN
        CREATE TRIGGER update_conversations_updated_at BEFORE
        UPDATE ON conversations FOR EACH ROW
        EXECUTE FUNCTION update_updated_at_column ();
    END IF;
END $$;
