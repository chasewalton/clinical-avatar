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
const { OPENAI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, PUBLIC_BASE_URL } = process.env;

if (!OPENAI_API_KEY) {
    console.error('Missing OpenAI API key. Please set it in the .env file.');
    process.exit(1);
}

// Initialize Fastify
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const PORT = process.env.PORT || 10000;

// Initialize Supabase client
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.warn('Supabase credentials are not fully set. Database operations may fail.');
}

// Constants
const INTRO_VOICE = 'alloy';
const QUESTIONS_VOICE = 'alloy';
const SYSTEM_MESSAGE = `You are a warm, empathetic AI medical intake assistant for M.U.S.C. Clinics.
IMPORTANT: As soon as the call connects, immediately greet the caller without waiting. Start with: "Hi, at M.U.S.C. we want to provide you with the best care at your upcoming appointment with Neurology. As M.U.S.C.'s Clinical Assistant, I'd like to collect some basic information before your upcoming appointment so that you can spend more time talking to your specialist about what's important to you. If that's alright, say \"Yes\" when you are ready to begin."
Flow at start of call:
1) Wait for the caller to consent by saying "Yes".
2) Once consent is detected, begin intake: Be caring, professional, and easy to understand. Speak at a comfortable pace. Start with, "Can you tell me what symptoms or concerns led you to make this appointment?"
3) If the caller does not say "Yes", do not proceed with intake. If asked questions before consent, gently remind them: "Please say \"Yes\" when you are ready to begin."

Critical dialog rule:
- Ask exactly ONE question per turn.
- Never bundle multiple questions in the same message (e.g., do not ask about severity and duration and history together).
- Keep each question short and let the caller answer before asking the next question.

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

// Build full transcript and update conversations.summary
fastify.post('/api/conversations/:id/summary', async (request, reply) => {
    try {
        const conversationId = request.params.id;
        const { mode } = request.body || {}; // optional: 'transcript' (default) | 'ai'

        // Fetch messages ordered by timestamp
        const { data: messages, error: msgError } = await supabase
            .from('messages')
            .select('role, content, timestamp')
            .eq('conversation_id', conversationId)
            .order('timestamp', { ascending: true });

        if (msgError) {
            console.error('Failed to fetch messages for summary:', msgError);
            return reply.status(500).send({ error: 'Failed to fetch messages' });
        }

        if (!messages || messages.length === 0) {
            return reply.status(400).send({ error: 'No messages to summarize' });
        }

        // Default: full transcript text (User/Assistant lines)
        const transcript = messages
            .map(m => `${m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : 'System'}: ${m.content}`)
            .join('\n');

        // Update conversations.summary
        const { data: updated, error: updError } = await supabase
            .from('conversations')
            .update({ summary: transcript, updated_at: new Date().toISOString() })
            .eq('id', conversationId)
            .select('id, summary')
            .single();

        if (updError) {
            console.error('Failed to update conversation summary:', updError);
            return reply.status(500).send({ error: 'Failed to update summary' });
        }

        console.log('Conversation summary updated', { id: conversationId, chars: transcript.length });
        reply.send({ success: true, id: updated.id, summary_length: transcript.length });
    } catch (error) {
        console.error('Error building/updating summary:', error);
        reply.status(500).send({ error: 'Unexpected error' });
    }
});

// Persist messages endpoint
fastify.post('/api/messages', async (request, reply) => {
    try {
        const { conversation_id, role, content, metadata } = request.body || {};

        if (!conversation_id || !role || !content) {
            return reply.status(400).send({ error: 'Missing conversation_id, role, or content' });
        }

        const { data, error } = await supabase
            .from('messages')
            .insert({
                conversation_id,
                role,
                content,
                metadata: metadata || {},
                timestamp: new Date().toISOString()
            })
            .select()
            .single();

        if (error) {
            console.error('Error saving message:', error);
            return reply.status(500).send({ error: 'Failed to save message' });
        }

        console.log('Message saved', { conversation_id, role, len: content.length });
        reply.send({ success: true, message: data });
    } catch (err) {
        console.error('Unexpected error saving message:', err);
        reply.status(500).send({ error: 'Unexpected error' });
    }
});

// Route for Twilio to handle incoming calls with OpenAI Coral
fastify.all('/webhook/voice', async (request, reply) => {
    // Optionally validate Twilio signature if token is set
    try {
        const { TWILIO_AUTH_TOKEN } = process.env;
        const signature = request.headers['x-twilio-signature'];
        if (TWILIO_AUTH_TOKEN && signature) {
            const url = `${request.protocol}://${request.headers.host}${request.raw.url.split('?')[0]}`;
            const isValid = twilio.validateRequest(TWILIO_AUTH_TOKEN, signature, url, request.body || {});
            if (!isValid) {
                console.warn('Invalid Twilio signature; proceeding but marking as unverified');
            }
        }
    } catch (e) {
        console.warn('Twilio signature validation error:', e?.message);
    }

    const body = request.body || {};
    const callSid = body.CallSid || `test-${Date.now()}`;
    const from = body.From || 'unknown';
    const to = body.To || 'unknown';
    const accountSid = body.AccountSid || 'unknown';
    const callStatus = body.CallStatus || 'queued';
    const direction = body.Direction || 'inbound';
    const callerCountry = body.CallerCountry || null;
    const calledCountry = body.CalledCountry || null;
    
    // Create conversation in Supabase
    let conversationId = null;
    try {
        const { data: conversation, error } = await supabase
            .from('conversations')
            .insert({
                id: uuidv4(),
                call_sid: callSid,
                phone_number: from,
                status: 'active',
                started_at: new Date().toISOString(),
                metadata: {
                    from,
                    to,
                    account_sid: accountSid,
                    call_status: callStatus,
                    direction,
                    caller_country: callerCountry,
                    called_country: calledCountry,
                    request_info: {
                        host: request.headers.host,
                        user_agent: request.headers['user-agent'] || null
                    }
                }
            })
            .select()
            .single();

        if (error) {
            console.error('Error creating conversation:', error);
        } else {
            console.log('Conversation created', {
                id: conversation.id,
                callSid,
                from,
                to,
                status: conversation.status,
                direction
            });
            conversationId = conversation.id;
        }
    } catch (error) {
        console.error('Error setting up call:', error);
    }
    
    // TwiML response for direct OpenAI Coral integration
    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
                          <Response>
                              <Connect>
                                  <Stream url="wss://${request.headers.host}/coral-stream">
                                      <Parameter name="conversation_id" value="${conversationId}" />
                                  </Stream>
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
        let streamStarted = false;
        let greetingSent = false;
        let wantGreeting = false;
        let consentGiven = false;
        let endingCall = false;
        let lastAssistantText = null;
        let lastAssistantAt = 0;

        // Normalize conversation_id from the WS URL (avoid 'null' string)
        const qs = req.url.split('?')[1] || '';
        const paramConversationId = new URLSearchParams(qs).get('conversation_id');
        let wsConversationId = (paramConversationId && paramConversationId !== 'null') ? paramConversationId : null;
        console.log('WS conversation_id (query fallback):', wsConversationId);

        const trySendGreeting = () => {
            if (!greetingSent && streamStarted && openAiWs.readyState === WebSocket.OPEN) {
                // Create a conversation item first so the model has queued content
                const greetingItem = {
                    type: 'conversation.item.create',
                    item: {
                        type: 'message',
                        role: 'assistant',
                        content: [
                            {
                                type: 'input_text',
                                text: "Hi, I am connecting you to M.U.S.C.'s Clinical Assistant. Say 'Yes' when you are ready to begin intake."
                            }
                        ]
                    }
                };
                openAiWs.send(JSON.stringify(greetingItem));

                // Then trigger the response to render the item to audio
                const createResponse = { type: 'response.create' };
                openAiWs.send(JSON.stringify(createResponse));

                greetingSent = true;
                console.log('Initial greeting sent');
            }
        };
        
        openAiWs.on('open', () => {
            console.log('Connected to OpenAI Realtime API');
            let openAiReady = true;
            
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
                    },
                    turn_detection: {
                        type: 'server_vad',
                        threshold: 0.5,
                        prefix_padding_ms: 500,
                        silence_duration_ms: 600
                    }
                }
            };
            
            openAiWs.send(JSON.stringify(sessionUpdate));
            
            // Greeting will be sent once sessionReady && streamStarted
            // Fallback: in case one signal is delayed, try after 1.5s too
            setTimeout(() => {
                trySendGreeting();
            }, 1500);
        });

        // Listen for messages from the OpenAI WebSocket
        // helper to persist a message directly to Supabase
        const saveMessage = async (conversationId, role, content, metadata = {}) => {
            if (!conversationId) {
                console.warn('Skipping saveMessage: missing conversationId');
                return;
            }
            if (!content || !content.trim()) {
                console.warn('Skipping saveMessage: empty content');
                return;
            }
            try {
                const { error } = await supabase
                    .from('messages')
                    .insert({
                        conversation_id: conversationId,
                        role,
                        content,
                        metadata,
                        timestamp: new Date().toISOString()
                    });
                if (error) {
                    console.error('Supabase insert error (messages):', error, { role, len: content.length });
                } else {
                    console.log('Message saved', { conversation_id: conversationId, role, len: content.length });
                }
            } catch (e) {
                console.error('Unexpected error saving message:', e);
            }
        };

        openAiWs.on('message', (data) => {
            try {
                const response = JSON.parse(data);
                
                if (response.type === 'session.updated') {
                    console.log('Session updated successfully');
                    wantGreeting = true;
                    setTimeout(() => trySendGreeting(), 100);
                }
                
                if (response.type === 'response.audio.delta' && response.delta) {
                    const audioDelta = {
                        event: 'media',
                        streamSid: streamSid,
                        media: { payload: Buffer.from(response.delta, 'base64').toString('base64') }
                    };
                    connection.send(JSON.stringify(audioDelta));
                }

                // Handle conversation item creation for better message tracking
                if (response.type === 'conversation.item.created' && response.item) {
                    const conversationId = wsConversationId;
                    const item = response.item;
                    if (item.type === 'message' && item.role === 'assistant' && conversationId) {
                        // Normalize content string from possible transcript/text segments
                        let content = '';
                        try {
                            if (Array.isArray(item.content) && item.content.length) {
                                const parts = item.content.map(c => c?.transcript || c?.text || '').filter(Boolean);
                                content = parts.join(' ').replace(/\s+/g, ' ').trim();
                            }
                        } catch {}
                        if (!content) content = 'Assistant message';

                        // Enforce single-question per turn: if multiple '?', cancel and re-emit only first question
                        const qmCount = (content.match(/\?/g) || []).length;
                        if (qmCount > 1) {
                            const firstQ = content.split('?')[0].trim() + '?';
                            console.log('Enforcing single-question output; cancelling multi-question response');
                            try { openAiWs.send(JSON.stringify({ type: 'response.cancel' })); } catch {}
                            const singleItem = {
                                type: 'conversation.item.create',
                                item: {
                                    type: 'message',
                                    role: 'assistant',
                                    content: [{ type: 'input_text', text: firstQ }]
                                }
                            };
                            openAiWs.send(JSON.stringify(singleItem));
                            openAiWs.send(JSON.stringify({ type: 'response.create' }));
                            saveMessage(conversationId, 'assistant', firstQ, { item_id: item.id });
                        } else {
                            saveMessage(conversationId, 'assistant', content, { item_id: item.id });
                        }
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
                        streamStarted = true;
                        // Prefer Twilio customParameters for conversation_id
                        const cp = data.start?.customParameters || {};
                        if (cp.conversation_id && cp.conversation_id !== 'null') {
                            wsConversationId = cp.conversation_id;
                            console.log('WS conversation_id (from customParameters):', wsConversationId);
                        }
                        console.log('Incoming stream has started', streamSid);
                        trySendGreeting();
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
                    const { error: insertErr } = await supabase
                        .from('clinical_extractions')
                        .insert({
                            conversation_id,
                            field_name: fieldName,
                            field_value: fieldValue,
                            confidence_score: 0.8
                        });
                    if (insertErr) {
                        console.error('Error saving clinical extraction:', insertErr, { fieldName });
                    }
                }
            }

            // Update conversation with clinical data
            const { data: existingConversation, error: fetchConvErr } = await supabase
                .from('conversations')
                .select('clinical_data')
                .eq('id', conversation_id)
                .single();
            if (fetchConvErr) {
                console.error('Error fetching conversation for update:', fetchConvErr);
            }

            const updatedClinicalData = {
                ...(existingConversation?.clinical_data || {}),
                ...clinicalFields
            };

            const { error: updateConvErr } = await supabase
                .from('conversations')
                .update({ 
                    clinical_data: updatedClinicalData,
                    updated_at: new Date().toISOString()
                })
                .eq('id', conversation_id);
            if (updateConvErr) {
                console.error('Error updating conversation clinical_data:', updateConvErr);
            }

            console.log('Clinical fields extracted', { conversation_id, fields: Object.keys(clinicalFields) });

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
fastify.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
    if (err) {
        console.error(err);
        process.exit(1);
    }
    const baseUrl = PUBLIC_BASE_URL || `http://localhost:${PORT}`;
    console.log(`Server running on ${baseUrl}`);
    console.log(`WebSocket server running on same origin`);
    console.log(`Twilio webhook URL: ${baseUrl.replace('http', 'https')}/webhook/voice`);
});
