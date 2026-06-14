import { GODTFOLK_INSTRUCTIONS } from './_godtfolk-prompt.js';

const REALTIME_MODEL = 'gpt-realtime';

function readRequestBody(req) {
  if (typeof req.body === 'string') return Promise.resolve(req.body);
  if (Buffer.isBuffer(req.body)) return Promise.resolve(req.body.toString('utf8'));

  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'OPENAI_API_KEY not configured' });
  }

  try {
    const requestUrl = new URL(req.url || '/api/realtime/call', 'http://localhost');
    const useOpenAiVoice = requestUrl.searchParams.get('voice') === 'openai';
    const sdp = await readRequestBody(req);
    if (!sdp || !sdp.includes('v=0')) {
      return res.status(400).json({ error: 'Missing SDP offer' });
    }

    const sessionConfig = {
      type: 'realtime',
      model: REALTIME_MODEL,
      instructions: GODTFOLK_INSTRUCTIONS,
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
    };

    if (useOpenAiVoice) {
      sessionConfig.audio.output = { voice: 'cedar' };
    } else {
      sessionConfig.output_modalities = ['text'];
    }

    const session = JSON.stringify(sessionConfig);

    const form = new FormData();
    form.set('sdp', sdp);
    form.set('session', session);

    const response = await fetch('https://api.openai.com/v1/realtime/calls', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: form,
    });

    const text = await response.text();
    if (!response.ok) {
      console.error('OpenAI realtime call error:', text);
      return res.status(response.status).json({
        error: 'Failed to connect realtime call',
        detail: text,
      });
    }

    res.setHeader('Content-Type', 'application/sdp');
    return res.status(200).send(text);
  } catch (error) {
    console.error('Realtime call error:', error.message);
    return res.status(500).json({ error: error.message });
  }
}
