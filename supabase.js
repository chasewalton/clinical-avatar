const { createClient } = require('@supabase/supabase-js');

// Initialize Supabase client
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Database operations for clinical conversations
class ClinicalDatabase {
    
    // Create a new conversation session
    async createConversation(callSid, phoneNumber) {
        try {
            const { data, error } = await supabase
                .from('conversations')
                .insert([
                    {
                        call_sid: callSid,
                        phone_number: phoneNumber,
                        status: 'active',
                        started_at: new Date().toISOString(),
                        metadata: {}
                    }
                ])
                .select()
                .single();
            
            if (error) throw error;
            return data;
        } catch (error) {
            console.error('Error creating conversation:', error);
            throw error;
        }
    }
    
    // Add a message to the conversation
    async addMessage(conversationId, role, content, audioData = null) {
        try {
            const { data, error } = await supabase
                .from('messages')
                .insert([
                    {
                        conversation_id: conversationId,
                        role: role, // 'user' or 'assistant'
                        content: content,
                        audio_data: audioData,
                        timestamp: new Date().toISOString()
                    }
                ])
                .select()
                .single();
            
            if (error) throw error;
            return data;
        } catch (error) {
            console.error('Error adding message:', error);
            throw error;
        }
    }
    
    // Update conversation with clinical data
    async updateClinicalData(conversationId, clinicalData) {
        try {
            const { data, error } = await supabase
                .from('conversations')
                .update({
                    clinical_data: clinicalData,
                    updated_at: new Date().toISOString()
                })
                .eq('id', conversationId)
                .select()
                .single();
            
            if (error) throw error;
            return data;
        } catch (error) {
            console.error('Error updating clinical data:', error);
            throw error;
        }
    }
    
    // End conversation
    async endConversation(conversationId, summary = null) {
        try {
            const { data, error } = await supabase
                .from('conversations')
                .update({
                    status: 'completed',
                    ended_at: new Date().toISOString(),
                    summary: summary
                })
                .eq('id', conversationId)
                .select()
                .single();
            
            if (error) throw error;
            return data;
        } catch (error) {
            console.error('Error ending conversation:', error);
            throw error;
        }
    }
    
    // Get conversation by call SID
    async getConversationByCallSid(callSid) {
        try {
            const { data, error } = await supabase
                .from('conversations')
                .select('*')
                .eq('call_sid', callSid)
                .single();
            
            if (error) throw error;
            return data;
        } catch (error) {
            console.error('Error getting conversation:', error);
            return null;
        }
    }
    
    // Get all messages for a conversation
    async getConversationMessages(conversationId) {
        try {
            const { data, error } = await supabase
                .from('messages')
                .select('*')
                .eq('conversation_id', conversationId)
                .order('timestamp', { ascending: true });
            
            if (error) throw error;
            return data;
        } catch (error) {
            console.error('Error getting messages:', error);
            return [];
        }
    }
}

module.exports = { ClinicalDatabase, supabase };
