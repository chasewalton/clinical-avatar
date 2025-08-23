require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

// Test Supabase connection
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function testConnection() {
    try {
        console.log('Testing Supabase connection...');
        console.log('URL:', process.env.SUPABASE_URL);
        console.log('Service Role Key (first 20 chars):', process.env.SUPABASE_SERVICE_ROLE_KEY?.substring(0, 20) + '...');
        
        // Test basic connection
        const { data, error } = await supabase
            .from('conversations')
            .select('count')
            .limit(1);
            
        if (error) {
            console.error('Supabase error:', error);
        } else {
            console.log('✅ Supabase connection successful!');
            console.log('Data:', data);
        }
    } catch (error) {
        console.error('❌ Connection failed:', error.message);
    }
}

testConnection();
