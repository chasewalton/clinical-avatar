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
const SYSTEM_MESSAGE = 'You are a helpful clinical assistant conducting a pre-appointment medical history interview for MUSC. Ask about current symptoms, medications, allergies, family history, and other relevant medical information. Be conversational and empathetic. Start by introducing yourself and explaining the purpose of the call.';
const VOICE = 'alloy';

// Root Route
fastify.get('/', async (request, reply) => {
    reply.send({ message: 'Clinical Avatar Server is running!' });
});

// Route for Twilio to handle incoming calls
fastify.all('/webhook/voice', async (request, reply) => {
    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
                          <Response>
                              <Say>Please wait while we connect your call to the clinical assistant.</Say>
                              <Pause length="1"/>
                              <Say>You can start talking!</Say>
                              <Connect>
                                  <Stream url="wss://${request.headers.host}/media-stream" />
                              </Connect>
                          </Response>`;
    
    // Create conversation in Supabase
    try {
        const callSid = request.body.CallSid || `test-${Date.now()}`;
        const from = request.body.From || 'unknown';
        
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
        }
    } catch (error) {
        console.error('Error setting up call:', error);
    }
    
    reply.type('text/xml').send(twimlResponse);
});

// WebSocket route for media-stream
fastify.register(async (fastify) => {
    fastify.get('/media-stream', { websocket: true }, (connection, req) => {
        console.log('Client connected');
        
        const openAiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01', {
            headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`,
                "OpenAI-Beta": "realtime=v1"
            }
        });
        
        let streamSid = null;
        
        const sendSessionUpdate = () => {
            const sessionUpdate = {
                type: 'session.update',
                session: {
                    turn_detection: { type: 'server_vad' },
                    input_audio_format: 'g711_ulaw',
                    output_audio_format: 'g711_ulaw',
                    voice: VOICE,
                    instructions: SYSTEM_MESSAGE,
                    modalities: ["text", "audio"],
                    temperature: 0.8,
                }
            };
            console.log('Sending session update');
            openAiWs.send(JSON.stringify(sessionUpdate));
        };

        // Open event for OpenAI WebSocket
        openAiWs.on('open', () => {
            console.log('Connected to the OpenAI Realtime API');
            setTimeout(sendSessionUpdate, 250);
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
                    
                    // Save message to Supabase
                    if (response.transcript) {
                        supabase
                            .from('messages')
                            .insert({
                                id: uuidv4(),
                                conversation_id: streamSid, // Using streamSid as conversation reference
                                role: 'user',
                                content: response.transcript,
                                created_at: new Date().toISOString()
                            })
                            .then(({ error }) => {
                                if (error) console.error('Error saving user message:', error);
                            });
                    }
                }
                
                if (response.type === 'response.done') {
                    console.log('AI response completed');
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
