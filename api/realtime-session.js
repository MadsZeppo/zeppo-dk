import { GODTFOLK_INSTRUCTIONS } from './_godtfolk-prompt.js';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'OPENAI_API_KEY not configured' });
  }

  try {
    const response = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 'realtime',
        model: 'gpt-realtime',
        output_modalities: ['text'],
        audio: {
          input: {
            transcription: { model: 'whisper-1', language: 'da' },
            turn_detection: {
              type: 'semantic_vad',
              eagerness: 'low',
              create_response: true,
              interrupt_response: false,
            },
          },
        },
        instructions: GODTFOLK_INSTRUCTIONS,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('OpenAI session error:', err);
      return res.status(response.status).json({ error: 'Failed to create session', detail: err });
    }

    const data = await response.json();
    return res.status(200).json(data);
  } catch (error) {
    console.error('Session creation error:', error.message);
    return res.status(500).json({ error: error.message });
  }
}
