# Clinical Avatar Setup Guide

## 1. Supabase Database Setup

### Step 1: Run the SQL Schema
1. Go to your Supabase project dashboard: https://supabase.com/dashboard
2. Navigate to the SQL Editor
3. Copy and paste the contents of `schema.sql` into the editor
4. Click "Run" to create the tables and policies

### Step 2: Verify Tables Created
Check that these tables were created:
- `conversations` - Stores call session data
- `messages` - Stores conversation history
- `clinical_extractions` - Stores structured medical data

## 2. Local Development Setup

### Step 1: Install ngrok (for Twilio webhooks)
```bash
# Install ngrok
brew install ngrok

# Or download from https://ngrok.com/download
```

### Step 2: Start ngrok tunnel
```bash
# In a new terminal window
ngrok http 3001
```

This will give you a public URL like: `https://abc123.ngrok.io`

### Step 3: Configure Twilio Webhook
1. Go to Twilio Console: https://console.twilio.com/
2. Navigate to Phone Numbers > Manage > Active numbers
3. Click on your phone number: +18435485788
4. Set the webhook URL to: `https://your-ngrok-url.ngrok.io/webhook/voice`
5. Set HTTP method to POST
6. Save configuration

## 3. Testing the System

### Step 1: Start the server
```bash
npm start
```

### Step 2: Call the Twilio number
Call +18435485788 from any phone

### Expected Flow:
1. 2-second pause
2. "Connecting you to your clinical assistant. Say 'Yes' when you are ready."
3. After saying "Yes": AI introduces itself with alloy voice
4. Clinical interview begins

### Step 3: Monitor logs
Watch the console for:
- Incoming call notifications
- WebSocket connections
- OpenAI API interactions
- Database operations

## 4. Production Deployment

### Option 1: Railway/Render/Heroku
1. Deploy the application to your preferred platform
2. Set environment variables
3. Update Twilio webhook URL to production domain

### Option 2: VPS/Cloud Server
1. Set up HTTPS with SSL certificate
2. Configure reverse proxy (nginx)
3. Set up process manager (PM2)
4. Update Twilio webhook URL

## 5. Troubleshooting

### Common Issues:

**Port conflicts:**
- Change PORT in .env file
- Restart the server

**Twilio webhook errors:**
- Ensure ngrok is running
- Check webhook URL in Twilio console
- Verify server is accessible

**OpenAI API errors:**
- Check API key validity
- Monitor rate limits
- Verify WebSocket connection

**Supabase connection issues:**
- Verify database URL and keys
- Check RLS policies
- Ensure tables exist

### Debug Commands:
```bash
# Check if server is running
curl http://localhost:3001/health

# Test Twilio webhook locally
curl -X POST http://localhost:3001/webhook/voice \
  -d "CallSid=test123&From=+1234567890"
```

## 6. Environment Variables Reference

Required variables in `.env`:
- `TWILIO_ACCOUNT_SID` - Your Twilio Account SID
- `TWILIO_AUTH_TOKEN` - Your Twilio Auth Token  
- `TWILIO_PHONE_NUMBER` - Your Twilio phone number
- `OPENAI_API_KEY` - Your OpenAI API key
- `SUPABASE_URL` - Your Supabase project URL
- `SUPABASE_ANON_KEY` - Supabase anonymous key
- `SUPABASE_SERVICE_ROLE_KEY` - Supabase service role key
- `PORT` - Server port (default: 3001)
- `NODE_ENV` - Environment (development/production)
