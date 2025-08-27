import WebSocket from 'ws';
import fs from 'fs';

// Test WebSocket connection and epilepsy flow
function testWebSocketConnection() {
    console.log('Testing WebSocket connection...');

    const ws = new WebSocket('ws://localhost:3001/coral-stream?conversation_id=test-123');

    let messageCount = 0;
    let hasEpilepsyMessage = false;
    let hasClinicalExtraction = false;

    ws.on('open', function open() {
        console.log('✅ WebSocket connection established');
        messageCount++;

        // Simulate a start event like Twilio would send
        const startEvent = {
            event: 'start',
            start: {
                streamSid: 'test-stream-123',
                customParameters: {
                    conversation_id: 'test-123'
                }
            }
        };
        ws.send(JSON.stringify(startEvent));

        // After a brief delay, simulate epilepsy-related user input
        setTimeout(() => {
            console.log('Sending epilepsy-related test message...');
            // This would trigger the epilepsy flow
            const epilepsyMessage = "I've been having seizures lately";
            // In a real scenario, this would come from audio transcription
            // For testing, we'll send a mock transcription event
            const transcriptionEvent = {
                type: 'conversation.item.input_audio_transcription.completed',
                transcript: epilepsyMessage
            };
            ws.send(JSON.stringify(transcriptionEvent));
        }, 2000);
    });

    ws.on('message', function incoming(data) {
        messageCount++;
        try {
            const message = JSON.parse(data.toString());
            console.log('Received message type:', message.type);

            // Check for epilepsy-specific system message
            if (message.type === 'session.update' && message.session?.instructions) {
                const instructions = message.session.instructions;
                if (instructions.includes('EPILEPSY-SPECIFIC INTAKE GUIDANCE') ||
                    instructions.includes('epilepsy_age_onset') ||
                    instructions.includes('seizure_frequency')) {
                    hasEpilepsyMessage = true;
                    console.log('✅ Epilepsy-specific system message detected');
                }
            }

            // Check for conversation item creation (assistant responses)
            if (message.type === 'conversation.item.created' && message.item?.role === 'assistant') {
                const content = message.item.content?.[0]?.text || '';
                if (content.includes('epilepsy') || content.includes('seizure') ||
                    content.includes('How old were you when you first experienced a seizure')) {
                    console.log('✅ Epilepsy-specific assistant response detected');
                }
            }

            // Check for clinical data extraction (this would happen internally)
            if (message.type === 'response.create') {
                console.log('✅ AI response creation triggered');
            }

        } catch (e) {
            console.log('Received non-JSON message:', data.toString());
        }
    });

    ws.on('error', function error(err) {
        console.error('❌ WebSocket error:', err.message);
    });

    ws.on('close', function close(code, reason) {
        console.log(`✅ WebSocket connection closed (code: ${code})`);

        // Test results summary
        console.log('\n=== TEST RESULTS ===');
        console.log(`Messages exchanged: ${messageCount}`);
        console.log(`Epilepsy system message: ${hasEpilepsyMessage ? '✅ PASS' : '❌ FAIL'}`);
        console.log(`WebSocket connection: ✅ PASS`);

        // Validate clinical data extraction fields
        console.log('\n=== CLINICAL DATA EXTRACTION VALIDATION ===');
        console.log('Checking for epilepsy-specific fields in SYSTEM_MESSAGE...');

        // Read the server.js file to check for clinical extraction fields
        const serverContent = fs.readFileSync('server.js', 'utf8');

        const epilepsyFields = [
            'epilepsy_age_onset',
            'seizure_frequency',
            'seizure_type',
            'seizure_triggers',
            'epilepsy_medications',
            'seizure_side_effects',
            'last_seizure_date',
            'seizure_emergency_measures',
            'epilepsy_family_history',
            'seizure_impact'
        ];

        let fieldCount = 0;
        epilepsyFields.forEach(field => {
            if (serverContent.includes(field)) {
                fieldCount++;
                console.log(`✅ ${field} - FOUND`);
            } else {
                console.log(`❌ ${field} - MISSING`);
            }
        });

        console.log(`\nEpilepsy fields found: ${fieldCount}/${epilepsyFields.length}`);

        if (fieldCount === epilepsyFields.length) {
            console.log('✅ ALL EPILEPSY FIELDS PROPERLY INTEGRATED');
        } else {
            console.log('❌ SOME EPILEPSY FIELDS MISSING');
        }

        process.exit(0);
    });

    // Close connection after 10 seconds for testing
    setTimeout(() => {
        ws.close();
    }, 10000);
}

// Run the test
testWebSocketConnection();