-- Clinical Avatar Database Schema for Supabase

-- Conversations table to track phone call sessions
CREATE TABLE conversations (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    call_sid TEXT UNIQUE NOT NULL,
    phone_number TEXT,
    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'completed', 'failed')),
    started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    ended_at TIMESTAMP WITH TIME ZONE,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    clinical_data JSONB DEFAULT '{}',
    summary TEXT,
    metadata JSONB DEFAULT '{}'
);

-- Messages table to store conversation history
CREATE TABLE messages (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    content TEXT NOT NULL,
    audio_data TEXT, -- Base64 encoded audio data if needed
    timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    metadata JSONB DEFAULT '{}'
);

-- Clinical data extraction table for structured medical information
CREATE TABLE clinical_extractions (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
    field_name TEXT NOT NULL, -- e.g., 'chief_complaint', 'symptoms', 'medications'
    field_value TEXT NOT NULL,
    confidence_score DECIMAL(3,2), -- 0.00 to 1.00
    extracted_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    metadata JSONB DEFAULT '{}'
);

-- Indexes for better performance
CREATE INDEX idx_conversations_call_sid ON conversations(call_sid);
CREATE INDEX idx_conversations_status ON conversations(status);
CREATE INDEX idx_conversations_started_at ON conversations(started_at);
CREATE INDEX idx_messages_conversation_id ON messages(conversation_id);
CREATE INDEX idx_messages_timestamp ON messages(timestamp);
CREATE INDEX idx_clinical_extractions_conversation_id ON clinical_extractions(conversation_id);
CREATE INDEX idx_clinical_extractions_field_name ON clinical_extractions(field_name);

-- Row Level Security (RLS) policies
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinical_extractions ENABLE ROW LEVEL SECURITY;

-- Allow service role to access all data
CREATE POLICY "Service role can access all conversations" ON conversations
    FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Service role can access all messages" ON messages
    FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Service role can access all clinical extractions" ON clinical_extractions
    FOR ALL USING (auth.role() = 'service_role');

-- Functions for automatic timestamp updates
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Trigger to automatically update updated_at
CREATE TRIGGER update_conversations_updated_at 
    BEFORE UPDATE ON conversations 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
