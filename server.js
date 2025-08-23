import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import twilio from 'twilio';
import { createClient } from '@supabase/supabase-js';
import { v4 as uuidv4 } from 'uuid';

// Load environment variables
dotenv.config();

// Retrieve API keys
const { OPENAI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;

if (!OPENAI_API_KEY) {
    console.error('Missing OpenAI API key. Please set it in the .env file.');
    process.exit(1);
}

// Initialize Fastify
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const PORT = process.env.PORT || 3001;

// Initialize Supabase client
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Constants
const INTRO_VOICE = 'ballad';
const QUESTIONS_VOICE = 'echo';
const SYSTEM_MESSAGE = `You are a warm, empathetic AI medical intake assistant for MUSC Clinics.

Flow at start of call:
1) After the call connects, immediately greet the caller with: "Hi, I am connecting you to MUSC's Clinical Assistant. Say \"Yes\" when you are ready to begin."
2) Wait for the caller to consent by saying "Yes".
3) Once consent is detected, begin intake: Introduce yourself as the MUSC Clinics AI assistant and proceed with natural, conversational intake questions. Be caring, professional, and easy to understand. Speak at a comfortable pace. Start with, "Can you tell me what symptoms or concerns led you to make this appointment?"
4) If the caller does not say "Yes", do not proceed with intake. If asked questions before consent, gently remind them: "Please say \"Yes\" when you are ready to begin."

Comprehensive intake topics to cover naturally (do not read as a checklist; weave them into conversation based on context):
- Chief complaint onset, duration, severity, triggers/relievers, associated symptoms
- Past medical history: chronic conditions (e.g., hypertension, diabetes, asthma), prior hospitalizations, major illnesses
- Past surgical history and dates
- Medications: prescription, OTC, supplements; dosages and adherence
- Allergies: medications, foods, environmental; reactions
- Family history: major conditions in first-degree relatives (cardiac disease, cancer, diabetes, stroke, mental health)
- Social history: tobacco/vaping, alcohol, recreational drugs; occupation; living situation; exercise; diet
- Gynecologic/OB history when appropriate: LMP, pregnancy status, contraception, relevant screenings
- Immunizations and preventive care: recent vaccines, screenings (colonoscopy, mammogram, Pap)
- Review of systems: brief screen guided by the chief complaint

Before closing, ask: "Is there anything else you'd like your provider to know before your visit?"
Keep responses concise, compassionate, and easy to understand.`;

// Root Route
fastify.get('/', async (request, reply) => {
    reply.send({ message: 'Clinical Avatar Server is running!' });
});

// Route for Twilio to handle incoming calls with OpenAI Coral
fastify.all('/webhook/voice', async (request, reply) => {
    const callSid = request.body.CallSid || `test-${Date.now()}`;
    const from = request.body.From || 'unknown';
    
    // Create conversation in Supabase
    let conversationId = null;
    try {
        const { data: conversation, error } = await supabase
            .from('conversations')
            .insert({
                id: uuidv4(),
                call_sid: callSid,
                caller_number: from,
                status: 'active',
                created_at: new Date().toISOString()
            })
            .select()
            .single();

        if (error) {
            console.error('Error creating conversation:', error);
        } else {
            console.log('Created conversation:', conversation.id);
            conversationId = conversation.id;
        }
    } catch (error) {
        console.error('Error setting up call:', error);
    }
    
    // TwiML response for direct OpenAI Coral integration
    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
                          <Response>
                              <Connect>
                                  <Stream url="wss://${request.headers.host}/coral-stream?conversation_id=${conversationId}" />
                              </Connect>
                          </Response>`;
    
    reply.type('text/xml').send(twimlResponse);
});

// WebSocket route for OpenAI Coral integration
fastify.register(async (fastify) => {
    fastify.get('/coral-stream', { websocket: true }, (connection, req) => {
        console.log('Client connected');
        
        const openAiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01', {
            headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`,
                "OpenAI-Beta": "realtime=v1"
            }
        });
        
        let streamSid = null;
        let isIntroPhase = true;
        
        openAiWs.on('open', () => {
            console.log('Connected to OpenAI Realtime API');
            
            // Configure the session with intro voice
            const sessionUpdate = {
                type: 'session.update',
                session: {
                    modalities: ['text', 'audio'],
                    instructions: SYSTEM_MESSAGE,
                    voice: INTRO_VOICE,
                    input_audio_format: 'g711_ulaw',
                    output_audio_format: 'g711_ulaw',
                    input_audio_transcription: {
                        model: 'whisper-1'
                    }
                }
            };
            
            openAiWs.send(JSON.stringify(sessionUpdate));
            
            // Send initial greeting immediately
            const initialGreeting = {
                type: 'response.create',
                response: {
                    modalities: ['audio'],
                    instructions: `Say exactly: "Hi, I am connecting you to MUSC's Clinical Assistant. Say 'Yes' when you are ready to begin."`
                }
            };
            
            openAiWs.send(JSON.stringify(initialGreeting));
        });

        // Listen for messages from the OpenAI WebSocket
        openAiWs.on('message', (data) => {
            try {
                const response = JSON.parse(data);
                
                if (response.type === 'session.updated') {
                    console.log('Session updated successfully');
                }
                
                if (response.type === 'response.audio.delta' && response.delta) {
                    const audioDelta = {
                        event: 'media',
                        streamSid: streamSid,
                        media: { payload: Buffer.from(response.delta, 'base64').toString('base64') }
                    };
                    connection.send(JSON.stringify(audioDelta));
                }
                
                if (response.type === 'conversation.item.input_audio_transcription.completed') {
                    console.log('User said:', response.transcript);
                    
                    // Switch to questions voice after first user input
                    if (isIntroPhase) {
                        isIntroPhase = false;
                        const voiceUpdate = {
                            type: 'session.update',
                            session: {
                                voice: QUESTIONS_VOICE
                            }
                        };
                        openAiWs.send(JSON.stringify(voiceUpdate));
                        console.log(`Switched to questions voice: ${QUESTIONS_VOICE}`);
                    }
                    
                    // Get conversation ID from URL params
                    const conversationId = req.query.conversation_id;
                    
                    // Save user message via API endpoint
                    if (response.transcript && conversationId) {
                        fetch(`http://localhost:${PORT}/api/messages`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                conversation_id: conversationId,
                                role: 'user',
                                content: response.transcript,
                                metadata: {
                                    audio_duration: response.audio_end_ms - response.audio_start_ms,
                                    timestamp: new Date().toISOString()
                                }
                            })
                        }).catch(err => console.error('Error saving user message:', err));
                        
                        // Extract clinical data from user response
                        fetch(`http://localhost:${PORT}/api/extract-clinical-data`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                conversation_id: conversationId,
                                text: response.transcript
                            })
                        }).catch(err => console.error('Error extracting clinical data:', err));
                    }
                }
                
                if (response.type === 'response.done' && response.response) {
                    console.log('AI response completed');
                    
                    // Get conversation ID from URL params
                    const conversationId = req.query.conversation_id;
                    
                    // Save AI response via API endpoint
                    if (conversationId) {
                        const aiContent = response.response.output?.[0]?.content?.[0]?.transcript || 'AI response';
                        fetch(`http://localhost:${PORT}/api/messages`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                conversation_id: conversationId,
                                role: 'assistant',
                                content: aiContent,
                                metadata: {
                                    response_id: response.response.id,
                                    voice_used: isIntroPhase ? INTRO_VOICE : QUESTIONS_VOICE,
                                    timestamp: new Date().toISOString()
                                }
                            })
                        }).catch(err => console.error('Error saving AI message:', err));
                    }
                }
                
                // Handle conversation item creation for better message tracking
                if (response.type === 'conversation.item.created' && response.item) {
                    const conversationId = req.query.conversation_id;
                    const item = response.item;
                    
                    if (item.type === 'message' && item.role === 'assistant' && conversationId) {
                        const content = item.content?.[0]?.transcript || item.content?.[0]?.text || 'Assistant message';
                        console.log('Assistant message created:', content);
                        
                        // Save assistant message
                        fetch(`http://localhost:${PORT}/api/messages`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                conversation_id: conversationId,
                                role: 'assistant',
                                content: content,
                                metadata: {
                                    item_id: item.id,
                                    voice_used: isIntroPhase ? INTRO_VOICE : QUESTIONS_VOICE
                                }
                            })
                        }).catch(err => console.error('Error saving assistant message:', err));
                    }
                }
                
                
            } catch (error) {
                console.error('Error processing OpenAI message:', error);
            }
        });

        // Handle incoming messages from Twilio
        connection.on('message', (message) => {
            try {
                const data = JSON.parse(message);
                
                switch (data.event) {
                    case 'media':
                        if (openAiWs.readyState === WebSocket.OPEN) {
                            const audioAppend = {
                                type: 'input_audio_buffer.append',
                                audio: data.media.payload
                            };
                            openAiWs.send(JSON.stringify(audioAppend));
                        }
                        break;
                    case 'start':
                        streamSid = data.start.streamSid;
                        console.log('Incoming stream has started', streamSid);
                        break;
                    default:
                        console.log('Received non-media event:', data.event);
                        break;
                }
            } catch (error) {
                console.error('Error parsing message:', error);
            }
        });

        // Handle connection close
        connection.on('close', () => {
            if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
            console.log('Client disconnected');
        });

        // Handle WebSocket close and errors
        openAiWs.on('close', () => {
            console.log('Disconnected from the OpenAI Realtime API');
        });
        
        openAiWs.on('error', (error) => {
            console.error('Error in the OpenAI WebSocket:', error);
        });
    });
});

// Clinical data extraction endpoint
fastify.post('/api/extract-clinical-data', async (request, reply) => {
    try {
        const { conversation_id, text } = request.body;
        
        if (!conversation_id || !text) {
            return reply.status(400).send({ error: 'Missing conversation_id or text' });
        }

        // Use OpenAI to extract clinical information
        const extractionPrompt = `Extract clinical information from this patient response: "${text}"
        
        Identify and extract:
        - Chief complaint
        - Symptoms
        - Medical history
        - Current medications
        - Allergies
        - Pain levels
        - Duration of symptoms
        - Family history
        - Social history
        
        Return as JSON with field_name and field_value pairs. Only include fields that are mentioned.`;

        const openaiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${OPENAI_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'gpt-4',
                messages: [{ role: 'user', content: extractionPrompt }],
                temperature: 0.1
            })
        });

        const aiResult = await openaiResponse.json();
        const extractedData = aiResult.choices[0].message.content;

        try {
            const clinicalFields = JSON.parse(extractedData);
            
            // Save each extracted field to clinical_extractions table
            for (const [fieldName, fieldValue] of Object.entries(clinicalFields)) {
                if (fieldValue && fieldValue.trim()) {
                    await supabase
                        .from('clinical_extractions')
                        .insert({
                            conversation_id,
                            field_name: fieldName,
                            field_value: fieldValue,
                            confidence_score: 0.8
                        });
                }
            }

            // Update conversation with clinical data
            const { data: existingConversation } = await supabase
                .from('conversations')
                .select('clinical_data')
                .eq('id', conversation_id)
                .single();

            const updatedClinicalData = {
                ...existingConversation?.clinical_data || {},
                ...clinicalFields
            };

            await supabase
                .from('conversations')
                .update({ 
                    clinical_data: updatedClinicalData,
                    updated_at: new Date().toISOString()
                })
                .eq('id', conversation_id);

        } catch (parseError) {
            console.log('Could not parse clinical data as JSON, saving as text:', extractedData);
        }

        reply.send({ success: true, extracted_data: extractedData });
    } catch (error) {
        console.error('Error extracting clinical data:', error);
        reply.status(500).send({ error: 'Failed to extract clinical data' });
    }
});

// Export conversation data endpoint
fastify.get('/api/conversations/:id/export', async (request, reply) => {
    try {
        const conversationId = request.params.id;

        // Get conversation details
        const { data: conversation, error: convError } = await supabase
            .from('conversations')
            .select('*')
            .eq('id', conversationId)
            .single();

        if (convError) {
            return reply.status(404).send({ error: 'Conversation not found' });
        }

        // Get all messages for this conversation
        const { data: messages, error: msgError } = await supabase
            .from('messages')
            .select('*')
            .eq('conversation_id', conversationId)
            .order('timestamp', { ascending: true });

        if (msgError) {
            return reply.status(500).send({ error: 'Failed to fetch messages' });
        }

        // Get clinical extractions
        const { data: clinicalExtractions, error: clinError } = await supabase
            .from('clinical_extractions')
            .select('*')
            .eq('conversation_id', conversationId)
            .order('extracted_at', { ascending: true });

        const exportData = {
            conversation,
            messages,
            clinical_extractions: clinicalExtractions || [],
            export_timestamp: new Date().toISOString()
        };

        reply.send(exportData);
    } catch (error) {
        console.error('Error exporting conversation:', error);
        reply.status(500).send({ error: 'Failed to export conversation' });
    }
});

// Export all conversations endpoint
fastify.get('/api/conversations/export', async (request, reply) => {
    try {
        // Get all conversations with their messages and clinical data
        const { data: conversations, error: convError } = await supabase
            .from('conversations')
            .select(`
                *,
                messages (*),
                clinical_extractions (*)
            `)
            .order('started_at', { ascending: false });

        if (convError) {
            return reply.status(500).send({ error: 'Failed to fetch conversations' });
        }

        const exportData = {
            conversations,
            total_count: conversations.length,
            export_timestamp: new Date().toISOString()
        };

        reply.send(exportData);
    } catch (error) {
        console.error('Error exporting all conversations:', error);
        reply.status(500).send({ error: 'Failed to export conversations' });
    }
});

// Health check endpoint
fastify.get('/health', async (request, reply) => {
    reply.send({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Start the server
fastify.listen({ port: PORT }, (err) => {
    if (err) {
        console.error(err);
        process.exit(1);
    }
    console.log(`Server running on port ${PORT}`);
    console.log(`WebSocket server running on same port ${PORT}`);
    console.log('Twilio webhook URL: https://a158ab71fe2a.ngrok.app/webhook/voice');
});
