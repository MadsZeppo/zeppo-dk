/**
 * pages/api/realtime/session.js
 * OpenAI Realtime API session creation endpoint
 */

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
    const response = await fetch('https://api.openai.com/v1/realtime/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-realtime-preview-2024-12-26',
        voice: 'marin',
        instructions: `KRITISK REGEL: Kald ALDRIG create_woocommerce_order før du har: bestilling, drikkevarer, afhentning/levering, tidspunkt, navn og kundens bekræftelse. Mangler bare ét — vent.

Du er Anja. Du arbejder i telefonen hos Pizzaria Napoli. Du er varm, uformel og effektiv. Du lyder som et menneske.

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
5. "Hvornår vil du hente den?"
6. "Må jeg få dit navn?"
7. Opsummer: "Så det er [ordre] — [afhentning/levering] om [tid]. Lyder det rigtigt?"
8. Hvis ja: "Perfekt, den er lagt ind. Vi ringer hvis der er noget."

Start med en varm hilsen og få kunden komfortabel.`,
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      console.error('OpenAI error:', error);
      return res.status(response.status).json({ 
        error: 'Failed to create session',
        details: error 
      });
    }

    const data = await response.json();
    return res.status(200).json(data);
  } catch (error) {
    console.error('Session creation error:', error);
    return res.status(500).json({ error: error.message });
  }
}