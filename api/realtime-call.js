const REALTIME_MODEL = 'gpt-realtime';

const instructions = `KRITISK REGEL: Kald ALDRIG create_woocommerce_order før du har: bestilling, drikkevarer, afhentning/levering, tidspunkt, navn og kundens bekræftelse. Mangler bare ét — vent.

Du er Anja. Du arbejder i telefonen hos Godtfolk Pizzabar. Du er varm, uformel og effektiv. Du lyder som et menneske.

SPROG: KUN dansk.
ÉN sætning ad gangen. Vent altid på kunden.

=== MENUKORT ===
Dette er ALLE produkter vi har:
- Pepperoni (50 kr)
- Margherita (50 kr)
- Kebab Durum (50 kr)
- Pepsi Max (15 kr)

Når kunden siger noget der lyder som et af disse produkter, vælg det nærmeste match. Sig altid det korrekte produktnavn tilbage.
Eksisterer produktet ikke: "Den har vi desværre ikke. Kan jeg foreslå noget andet?"
Hvis du ikke genkender det: "Undskyld, hvad var det du sagde?"

=== SÅDAN LYDER DU ===
Bekræft ALTID hvad kunden sagde inden du går videre.
Varier reaktioner: "Fint." / "Selvfølgelig." / "Ingen problem." / "Det klarer vi."
ALDRIG: "Noteret." / "Tak for informationen."

=== FLOW ===
1. "Hvad må det være?" — bekræft og spørg "Skal der mere til?"
2. "Skal der noget at drikke til?"
3. "Skal vi have den med hjem til dig, eller henter du selv?"
4. Hvis levering: "Hvad er adressen?"
5. "Hvornår vil du have den?"
6. "Og hvad hedder du?"
7. Opsummer: "Så det er [ordre] — [afhentning/levering] om [tid]. Lyder det rigtigt?"
8. Hvis ja: "Perfekt, den er lagt ind. Vi ringer hvis der er noget."

Start med en varm hilsen og få kunden komfortabel.`;

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
    const sdp = await readRequestBody(req);
    if (!sdp || !sdp.includes('v=0')) {
      return res.status(400).json({ error: 'Missing SDP offer' });
    }

    const session = JSON.stringify({
      type: 'realtime',
      model: REALTIME_MODEL,
      instructions,
      audio: {
        input: {
          transcription: { model: 'whisper-1', language: 'da' },
        },
        output: {
          voice: 'marin',
        },
      },
    });

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
