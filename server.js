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
const INTRO_VOICE = 'alloy';
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
                                content: response.transcript
                            })
                        }).catch(err => console.error('Error saving user message:', err));
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
                                content: aiContent
                            })
                        }).catch(err => console.error('Error saving AI message:', err));
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
