import OpenAI from 'openai';
import {
  safe,
  withTimeout,
} from './_vvs-shared.js';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function isKnown(value) {
  const cleaned = safe(value);
  return cleaned !== 'Ikke oplyst' && cleaned !== 'ukendt' && cleaned !== 'ikke relevant';
}

function normalizePhone(value) {
  if (!value) return null;
  const raw = String(value).trim();
  const match = raw.match(/(?:\+45\s*)?(?:\d[\s-]*){8}|\+\d[\d\s-]{7,18}/);
  if (!match) return null;

  const cleaned = match[0].replace(/[^\d+]/g, '');
  if (/^\+45\d{8}$/.test(cleaned)) return cleaned;
  if (/^\d{8}$/.test(cleaned)) return `+45${cleaned}`;
  if (/^\+\d{8,18}$/.test(cleaned)) return cleaned;
  return null;
}

function getAlternativePhoneFromTranscript(transcript, callerPhone) {
  const caller = normalizePhone(callerPhone);
  const matches = String(transcript || '').match(/(?:\+45\s*)?(?:\d[\s-]*){8}|\+\d[\d\s-]{7,18}/g) || [];
  const phones = matches.map(normalizePhone).filter(Boolean);
  return phones.find((phone) => phone !== caller) || null;
}

export function defaultLaasesmedInfo(customerPhone) {
  return {
    navn: 'Ikke oplyst',
    telefon: customerPhone || 'Ikke oplyst',
    adresse: 'Ikke oplyst',
    by: 'Ikke oplyst',
    boligtype: 'Ikke oplyst',
    etage_dør: 'Ikke oplyst',
    adgang: 'Ikke oplyst',
    problem: 'Ikke oplyst',
    kategori: 'andet',
    nøgle: 'Ikke oplyst',
    låsemærke: 'Ikke oplyst',
    låsetype: 'Ikke oplyst',
    prioritet: 'GUL',
    person_inde: 'Ikke oplyst',
    politi_status: 'Ikke oplyst',
    id_klar: 'Ikke oplyst',
    ekstra_noter: 'Ikke oplyst',
  };
}

export async function extractLaasesmedInfo(transcript, customerPhone) {
  const response = await withTimeout(
    openai.chat.completions.create({
      model: 'gpt-4o',
      temperature: 0,
      max_tokens: 900,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `
Du udtrækker låsesmed-info fra danske telefonopkald til Dansk Låseservice.
Returner KUN gyldig JSON. Ingen markdown. Ingen forklaring.

Du må ikke gætte. Hvis noget ikke tydeligt fremgår, brug "Ikke oplyst".

Felter:
- navn = kundens navn, hvis kunden selv siger det. Ellers "Ikke oplyst".
- telefon = ${customerPhone || 'Ikke oplyst'} som standard. Hvis kunden nævner et andet callback-nummer, brug det.
- adresse = vejnavn og husnummer, eventuelt postnummer hvis oplyst. Medtag ikke by her hvis den tydeligt er separat.
- by = by hvis oplyst.
- boligtype = hus, lejlighed, erhverv eller "Ikke oplyst". Gæt aldrig. Hvis kunden kun siger en almindelig adresse, brug "Ikke oplyst".
- etage_dør = kun hvis kunden tydeligt siger lejlighed, opgang, etage, sal, dør, tv, th eller lignende. Ellers "Ikke oplyst".
- adgang = kun port, opgang, baggård, adgangskode, boligforening, erhverv eller særlige adgangsforhold hvis oplyst. Ellers "Ikke oplyst".
- problem = kundens problem i korte, konkrete ord.
- kategori = en af: udelåst, mistet_nøgle, indbrud, knækket_nøgle, defekt_lås, toilet_inde, nye_låse, sikring, erhverv, andet.
- nøgle = mistet, ligger inde eller ukendt. Hvis kunden har mistet nøglen, brug "mistet". Hvis nøglen ligger indenfor, brug "ligger inde". Ellers "ukendt".
- låsemærke = kun hvis kunden selv nævner Ruko, Assa, Dorma, EVVA, Yale, Abus eller andet mærke på lås/nøgle. Ellers "ukendt".
- låsetype = kun hvis kunden selv nævner smæklås, cylinder, trepunktslås eller anden type. Ellers "Ikke oplyst".
- prioritet = RØD, GUL eller GRØN.
- person_inde = børn, dyr, ældre, person i fare, nej, eller "Ikke oplyst".
- politi_status = kun relevant ved indbrud. Fx "kontaktet", "ikke kontaktet", "på vej", "færdige" eller "Ikke oplyst".
- id_klar = ja, nej, ligger indenfor, anden dokumentation, eller "Ikke oplyst".
- ekstra_noter = vigtige korte noter til låsesmeden, ellers "Ikke oplyst".

Prioritet:
- RØD: låst ude, indbrud, nøgle mistet sammen med adresse, dør kan ikke lukke, person/barn/dyr i akut fare.
- GUL: defekt lås, knækket nøgle uden akut fare, toilet inde uden akut fare, erhverv der er påvirket.
- GRØN: nye låse, sikring, tilbud og planlagte opgaver.

Vigtigt:
- Spørgsmål og samtalestil er ikke din opgave her. Du skal kun udtrække data fra transcript.
- Brug ikke placeholder-navne. Brug kun navn hvis kunden selv sagde det.
`
        },
        {
          role: 'user',
          content: `Transcript:\n${transcript}\n\nReturner JSON med præcis disse felter:\n{
  "navn": "",
  "telefon": "",
  "adresse": "",
  "by": "",
  "boligtype": "",
  "etage_dør": "",
  "adgang": "",
  "problem": "",
  "kategori": "",
  "nøgle": "",
  "låsemærke": "",
  "låsetype": "",
  "prioritet": "",
  "person_inde": "",
  "politi_status": "",
  "id_klar": "",
  "ekstra_noter": ""
}`
        },
      ],
    }),
    12000,
    'laasesmed extraction'
  );

  const parsed = JSON.parse(response.choices[0]?.message?.content || '{}');
  const info = { ...defaultLaasesmedInfo(customerPhone), ...parsed };
  const alternativePhone = getAlternativePhoneFromTranscript(transcript, customerPhone);

  info.navn = safe(info.navn);
  info.telefon = normalizePhone(info.telefon) || alternativePhone || customerPhone || 'Ikke oplyst';
  info.adresse = safe(info.adresse);
  info.by = safe(info.by);
  info.boligtype = safe(info.boligtype);
  info.etage_dør = safe(info.etage_dør);
  info.adgang = safe(info.adgang);
  info.problem = safe(info.problem);
  info.kategori = safe(info.kategori, 'andet');
  info.nøgle = safe(info.nøgle, 'ukendt');
  info.låsemærke = safe(info.låsemærke, 'ukendt');
  info.låsetype = safe(info.låsetype);
  info.prioritet = safe(info.prioritet, 'GUL').toUpperCase();
  info.person_inde = safe(info.person_inde);
  info.politi_status = safe(info.politi_status);
  info.id_klar = safe(info.id_klar);
  info.ekstra_noter = safe(info.ekstra_noter);

  return info;
}

export function buildLaasesmedSms(info) {
  const prioritet = safe(info.prioritet, 'GUL').toUpperCase();
  const emoji = prioritet === 'RØD' ? '🚨' : prioritet === 'GUL' ? '⚠️' : '🔐';
  const kategori = safe(info.kategori, 'andet').replaceAll('_', ' ');
  const boligtype = safe(info.boligtype);
  const isLejlighed = boligtype.toLowerCase() === 'lejlighed';
  const laasemaerke = isKnown(info.låsemærke) ? safe(info.låsemærke) : 'ukendt';

  const linjer = [
    `${emoji} NY LÅSESMED-SAG`,
    ``,
    `${emoji} ${prioritet} · ${kategori.toUpperCase()}`,
    ``,
    `Navn: ${safe(info.navn)}`,
    `Telefon: ${safe(info.telefon)}`,
  ];

  linjer.push(`Adresse: ${safe(info.adresse)}`);
  linjer.push(`By: ${safe(info.by)}`);
  linjer.push(`Boligtype: ${isKnown(info.boligtype) ? safe(info.boligtype) : 'ukendt'}`);

  if (isLejlighed && isKnown(info.etage_dør)) linjer.push(`Etage/side: ${safe(info.etage_dør)}`);
  if (isKnown(info.adgang)) linjer.push(`Adgang: ${safe(info.adgang)}`);

  linjer.push(``);
  linjer.push(`Problem: ${safe(info.problem)}`);
  linjer.push(`Nøgle: ${isKnown(info.nøgle) ? safe(info.nøgle) : 'ukendt'}`);
  linjer.push(`Børn/dyr inde: ${isKnown(info.person_inde) ? safe(info.person_inde) : 'ukendt'}`);
  linjer.push(`ID: ${isKnown(info.id_klar) ? safe(info.id_klar) : 'ukendt'}`);
  linjer.push(`Låsemærke: ${laasemaerke}`);
  linjer.push(`Pris aftalt: Nej`);

  if (isKnown(info.låsetype)) linjer.push(`Låsetype: ${safe(info.låsetype)}`);
  if (isKnown(info.politi_status)) linjer.push(`Politi: ${safe(info.politi_status)}`);
  if (isKnown(info.ekstra_noter)) linjer.push(`Note: ${safe(info.ekstra_noter)}`);

  return linjer.join('\n');
}

export function buildLaasesmedCustomerSms(info) {
  const navn = isKnown(info.navn) ? ` ${safe(info.navn)}` : '';
  const adresse = [safe(info.adresse), safe(info.by)].filter(isKnown).join(', ');

  return `Hej${navn}

Din henvendelse til Dansk Låseservice er modtaget.

Adresse: ${adresse || 'Ikke oplyst'}
Problem: ${safe(info.problem)}

Låsesmeden kontakter dig, hvis han mangler noget.
- Dansk Låseservice`;
}
