function clean(value) {
  return String(value || '').trim();
}

function getContentType(outputFormat) {
  if (outputFormat.startsWith('mp3')) return 'audio/mpeg';
  if (outputFormat.startsWith('wav')) return 'audio/wav';
  if (outputFormat.startsWith('pcm')) return 'application/octet-stream';
  return 'audio/mpeg';
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = clean(process.env.ELEVENLABS_API_KEY);
  const voiceId = clean(process.env.ELEVENLABS_VOICE_ID);
  const text = clean(req.body?.text);
  const modelId = clean(process.env.ELEVENLABS_MODEL_ID) || 'eleven_v3';
  const outputFormat = clean(process.env.ELEVENLABS_OUTPUT_FORMAT) || 'mp3_44100_128';

  if (!apiKey) return res.status(500).json({ error: 'ELEVENLABS_API_KEY not configured' });
  if (!voiceId) return res.status(500).json({ error: 'ELEVENLABS_VOICE_ID not configured' });
  if (!text) return res.status(400).json({ error: 'Missing text' });

  try {
    const url = new URL(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`);
    url.searchParams.set('output_format', outputFormat);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        Accept: getContentType(outputFormat),
      },
      body: JSON.stringify({
        text,
        model_id: modelId,
        language_code: 'da',
        voice_settings: {
          stability: 0.35,
          similarity_boost: 0.86,
          style: 0.22,
          use_speaker_boost: true,
          speed: 1.05,
        },
      }),
    });

    const audio = Buffer.from(await response.arrayBuffer());
    if (!response.ok) {
      const detail = audio.toString('utf8');
      console.error('ElevenLabs HTTP TTS error:', detail);
      return res.status(response.status).json({
        error: 'Failed to create ElevenLabs speech',
        detail,
      });
    }

    res.setHeader('Content-Type', getContentType(outputFormat));
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(audio);
  } catch (error) {
    console.error('ElevenLabs HTTP TTS error:', error.message);
    return res.status(500).json({ error: error.message });
  }
}
