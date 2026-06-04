import OpenAI from 'openai';
import {
  safe,
  validerAdresseMedDawa,
  withTimeout,
} from './_vvs-shared.js';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function cleanKnown(value) {
  const cleaned = safe(value);
  return cleaned === 'Ikke oplyst' ? '' : cleaned;
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

function parseAddressParts(address) {
  const text = cleanKnown(address);
  if (!text) {
    return { vejnavn: 'Ikke oplyst', husnummer: 'Ikke oplyst', postnummer: 'Ikke oplyst' };
  }

  const postnummer = text.match(/\b[1-9]\d{3}\b/)?.[0] || 'Ikke oplyst';
  const beforePostnummer = postnummer !== 'Ikke oplyst' ? text.split(postnummer)[0] : text;
  const match = beforePostnummer.match(/([A-ZÆØÅa-zæøå][A-ZÆØÅa-zæøå0-9 .'-]*?)\s+(\d{1,4}[A-Za-z]?)(?:\s|,|$)/);

  return {
    vejnavn: match?.[1]?.trim() || 'Ikke oplyst',
    husnummer: match?.[2]?.trim() || 'Ikke oplyst',
    postnummer,
  };
}

async function validateFlytteAddress(rawAddress, parts, transcript) {
  const parsed = parseAddressParts(rawAddress);
  const prepared = {
    adresse_raw: safe(rawAddress),
    adresse: safe(rawAddress),
    vejnavn: safe(parts?.vejnavn, parsed.vejnavn),
    husnummer: safe(parts?.husnummer, parsed.husnummer),
    postnummer: safe(parts?.postnummer, parsed.postnummer),
    adresse_status: 'ikke_valideret',
    adresse_note: 'Ikke oplyst',
    adresse_forslag: 'Ikke oplyst',
  };

  const validated = await validerAdresseMedDawa(prepared, transcript);
  if (validated.adresse_status === 'BEKRÆFTET' || validated.adresse_status === 'MULIGT_MATCH') {
    return validated;
  }

  return validateAddressByDawaQuery(rawAddress, validated);
}

async function validateAddressByDawaQuery(rawAddress, fallback) {
  const query = cleanKnown(rawAddress);
  if (!query) return fallback;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const url = new URL('https://api.dataforsyningen.dk/adresser');
    url.searchParams.set('q', query);
    url.searchParams.set('per_side', '5');

    const response = await fetch(url.toString(), {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`DAWA q svarede ${response.status}`);

    const results = await response.json();
    if (Array.isArray(results) && results.length > 0) {
      return {
        ...fallback,
        adresse: results[0].betegnelse || fallback.adresse,
        adresse_status: 'MULIGT_MATCH',
        adresse_note: 'Fundet via DAWA fritekstsøgning',
        adresse_forslag: results[0].betegnelse || 'Ikke oplyst',
      };
    }
  } catch (err) {
    console.error('DAWA fritekstsøgning fejlede:', err.message);
  } finally {
    clearTimeout(timer);
  }

  return fallback;
}

async function validateMoveAddresses(info, transcript) {
  try {
    const fraValideret = await validateFlytteAddress(
      info.flytte_fra,
      {
        vejnavn: info.flytte_fra_vejnavn,
        husnummer: info.flytte_fra_husnummer,
        postnummer: info.flytte_fra_postnummer,
      },
      transcript
    );

    info.flytte_fra = fraValideret.adresse || info.flytte_fra;
    info.flytte_fra_status = fraValideret.adresse_status || 'USIKKER';
    info.flytte_fra_forslag = fraValideret.adresse_forslag || 'Ikke oplyst';
  } catch (err) {
    console.error('DAWA flytte_fra fejlede:', err.message);
    info.flytte_fra_status = 'USIKKER';
    info.flytte_fra_forslag = 'Ikke oplyst';
  }

  try {
    const tilValideret = await validateFlytteAddress(
      info.flytte_til,
      {
        vejnavn: info.flytte_til_vejnavn,
        husnummer: info.flytte_til_husnummer,
        postnummer: info.flytte_til_postnummer,
      },
      transcript
    );

    info.flytte_til = tilValideret.adresse || info.flytte_til;
    info.flytte_til_status = tilValideret.adresse_status || 'USIKKER';
    info.flytte_til_forslag = tilValideret.adresse_forslag || 'Ikke oplyst';
  } catch (err) {
    console.error('DAWA flytte_til fejlede:', err.message);
    info.flytte_til_status = 'USIKKER';
    info.flytte_til_forslag = 'Ikke oplyst';
  }

  return info;
}

export function defaultFlytteInfo(customerPhone) {
  return {
    navn: 'Ikke oplyst',
    telefon: customerPhone || 'Ikke oplyst',
    flytte_fra: 'Ikke oplyst',
    flytte_til: 'Ikke oplyst',
    flytte_fra_status: 'USIKKER',
    flytte_fra_forslag: 'Ikke oplyst',
    flytte_til_status: 'USIKKER',
    flytte_til_forslag: 'Ikke oplyst',
    boligtype: 'Ikke oplyst',
    boligtype_fra: 'ukendt',
    boligtype_til: 'ukendt',
    kvadratmeter_fra: 'Ikke oplyst',
    etage_fra: 'ukendt',
    etage_til: 'ukendt',
    elevator_fra: 'ukendt',
    elevator_til: 'ukendt',
    trapper_fra: 'ukendt',
    trapper_til: 'ukendt',
    kaelder_fra: 'ukendt',
    kaelder_til: 'ukendt',
    parkering: 'ukendt',
    parkering_detalje: 'Ikke oplyst',
    pakning: 'ukendt',
    hvornaar: 'Ikke oplyst',
    tungt: 'ukendt',
    tungt_detalje: 'Ikke oplyst',
    kunde_tone: 'standard',
    ekstra_noter: 'Ikke oplyst',
  };
}

export async function extractFlytteInfo(transcript, customerPhone) {
  const response = await withTimeout(
    openai.chat.completions.create({
      model: 'gpt-4o',
      temperature: 0,
      max_tokens: 1100,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `
Du udtrækker flytteopgave-info fra danske telefonopkald.
Returner KUN gyldig JSON. Ingen markdown. Ingen forklaring.

FELTER:
- navn = kundens navn eller Ikke oplyst
- telefon = ${customerPhone || 'Ikke oplyst'} som standard. Hvis kunden nævner et andet callback-nummer højt, skal telefon være det nye nummer.
- flytte_fra = fuld adresse kunden flytter fra. Medtag vej, nummer, etage/dør, postnummer og by hvis oplyst.
- flytte_til = fuld adresse kunden flytter til. Medtag vej, nummer, etage/dør, postnummer og by hvis oplyst.
- boligtype_fra = lejlighed, hus, rækkehus, sommerhus eller ukendt
- boligtype_til = lejlighed, hus, rækkehus, sommerhus eller ukendt
- kvadratmeter_fra = antal kvadratmeter i fra-boligen hvis oplyst, fx "85", ellers Ikke oplyst
- etage_fra = etage som tal, "stueniveau", "kælder", "1. sal" eller ukendt
- etage_til = etage som tal, "stueniveau", "kælder", "1. sal" eller ukendt
- elevator_fra = ja, nej, ikke relevant ved hus eller ukendt
- elevator_til = ja, nej, ikke relevant ved hus eller ukendt
- trapper_fra = ja, nej eller ukendt
- trapper_til = ja, nej eller ukendt
- kaelder_fra = ja, nej eller ukendt
- kaelder_til = ja, nej eller ukendt
- parkering = god, besværlig eller ukendt
- parkering_detalje = fritekst beskrivelse af parkeringsforhold hvis besværlig, ellers "Ikke oplyst"
- pakning = selv, hjælp eller ukendt
- hvornaar = ønsket dato eller periode
- tungt = ja, nej eller ukendt. Sæt ja hvis kunden nævner noget ekstra tungt.
- tungt_detalje = hvad det tunge er, fx klaver, piano, pengeskab eller stor reol. Ellers Ikke oplyst.
- kunde_tone = standard, stresset, travl eller sørgende
- ekstra_noter = vigtige praktiske detaljer, fx etage, adgang, parkering, bæreafstand, kælder, loft, depot, demontering eller Ikke oplyst

ADRESSE-DELE TIL DAWA:
Udfyld også vejnavn, husnummer og postnummer for både fra- og til-adressen hvis sikkert.
Hvis postnummer ikke er sagt, men byen er sagt, må postnummer være Ikke oplyst.
Danske postnumre er fire cifre og starter ikke med 0.
          `.trim(),
        },
        {
          role: 'user',
          content: `
Transskript:
${transcript}

Returner præcis dette JSON-objekt:
{
  "navn": "kundens navn eller Ikke oplyst",
  "telefon": "${customerPhone || 'Ikke oplyst'}",
  "flytte_fra": "fuld fra-adresse eller Ikke oplyst",
  "flytte_fra_vejnavn": "fra-vejnavn eller Ikke oplyst",
  "flytte_fra_husnummer": "fra-husnummer eller Ikke oplyst",
  "flytte_fra_postnummer": "fra-postnummer eller Ikke oplyst",
  "flytte_til": "fuld til-adresse eller Ikke oplyst",
  "flytte_til_vejnavn": "til-vejnavn eller Ikke oplyst",
  "flytte_til_husnummer": "til-husnummer eller Ikke oplyst",
  "flytte_til_postnummer": "til-postnummer eller Ikke oplyst",
  "boligtype_fra": "lejlighed, hus, rækkehus, sommerhus eller ukendt",
  "boligtype_til": "lejlighed, hus, rækkehus, sommerhus eller ukendt",
  "kvadratmeter_fra": "antal kvadratmeter i fra-boligen som tal eller Ikke oplyst",
  "etage_fra": "etage som tal, stueniveau, kælder, 1. sal eller ukendt",
  "etage_til": "etage som tal, stueniveau, kælder, 1. sal eller ukendt",
  "elevator_fra": "ja, nej, ikke relevant eller ukendt",
  "elevator_til": "ja, nej, ikke relevant eller ukendt",
  "trapper_fra": "ja, nej eller ukendt",
  "trapper_til": "ja, nej eller ukendt",
  "kaelder_fra": "ja, nej eller ukendt",
  "kaelder_til": "ja, nej eller ukendt",
  "parkering": "god, besværlig eller ukendt",
  "parkering_detalje": "fritekst beskrivelse af parkeringsforhold hvis besværlig, ellers Ikke oplyst",
  "pakning": "selv, hjælp eller ukendt",
  "hvornaar": "ønsket dato/periode eller Ikke oplyst",
  "tungt": "ja, nej eller ukendt",
  "tungt_detalje": "hvad det tunge er, ellers Ikke oplyst",
  "kunde_tone": "standard, stresset, travl eller sørgende",
  "ekstra_noter": "vigtige praktiske detaljer eller Ikke oplyst"
}
          `.trim(),
        },
      ],
    }),
    25000,
    'OpenAI flytte-extraction'
  );

  try {
    const info = JSON.parse(response.choices[0].message.content.trim());
    const callerPhone = normalizePhone(customerPhone);
    const spokenAlternativePhone = getAlternativePhoneFromTranscript(transcript, callerPhone);
    const modelPhone = normalizePhone(info.telefon);

    info.navn = safe(info.navn);
    info.telefon = spokenAlternativePhone || (modelPhone && modelPhone !== callerPhone ? modelPhone : callerPhone) || 'Ikke oplyst';
    info.flytte_fra = safe(info.flytte_fra);
    info.flytte_til = safe(info.flytte_til);
    info.flytte_fra_vejnavn = safe(info.flytte_fra_vejnavn);
    info.flytte_fra_husnummer = safe(info.flytte_fra_husnummer);
    info.flytte_fra_postnummer = safe(info.flytte_fra_postnummer);
    info.flytte_til_vejnavn = safe(info.flytte_til_vejnavn);
    info.flytte_til_husnummer = safe(info.flytte_til_husnummer);
    info.flytte_til_postnummer = safe(info.flytte_til_postnummer);
    info.boligtype_fra = safe(info.boligtype_fra, 'ukendt');
    info.boligtype_til = safe(info.boligtype_til, 'ukendt');
    info.boligtype = info.boligtype_fra !== 'ukendt' ? info.boligtype_fra : safe(info.boligtype, 'Ikke oplyst');
    info.kvadratmeter_fra = safe(info.kvadratmeter_fra);
    info.etage_fra = safe(info.etage_fra, 'ukendt');
    info.etage_til = safe(info.etage_til, 'ukendt');
    info.elevator_fra = safe(info.elevator_fra, 'ukendt');
    info.elevator_til = safe(info.elevator_til, 'ukendt');
    info.trapper_fra = safe(info.trapper_fra, 'ukendt');
    info.trapper_til = safe(info.trapper_til, 'ukendt');
    info.kaelder_fra = safe(info.kaelder_fra, 'ukendt');
    info.kaelder_til = safe(info.kaelder_til, 'ukendt');
    info.parkering = safe(info.parkering, 'ukendt');
    info.parkering_detalje = safe(info.parkering_detalje);
    info.pakning = safe(info.pakning, 'ukendt');
    info.hvornaar = safe(info.hvornaar);
    info.tungt = safe(info.tungt, 'ukendt');
    info.tungt_detalje = safe(info.tungt_detalje);
    info.kunde_tone = safe(info.kunde_tone, 'standard');
    info.ekstra_noter = safe(info.ekstra_noter);

    return validateMoveAddresses(info, transcript);
  } catch (err) {
    console.error('Flytte JSON parse fejl:', err.message);
    return defaultFlytteInfo(customerPhone);
  }
}

function formatSquareMeters(value) {
  const sqm = safe(value);
  if (sqm === 'Ikke oplyst') return sqm;
  if (/m2|m²|kvadrat/i.test(sqm)) return sqm;
  return `${sqm} m²`;
}

function isKnown(value) {
  const cleaned = safe(value);
  return cleaned !== 'Ikke oplyst' && cleaned !== 'ukendt';
}

function formatWithDetail(label, value, detail) {
  const main = safe(value);
  const extra = safe(detail);
  if (extra === 'Ikke oplyst') return `${label}: ${main}`;
  return `${label}: ${main} — ${extra}`;
}

function locationDetails(info, prefix) {
  const boligtype = safe(info[`boligtype_${prefix}`], 'ukendt');
  const etage = safe(info[`etage_${prefix}`], 'ukendt');
  const kaelder = safe(info[`kaelder_${prefix}`], 'ukendt');
  const elevator = safe(info[`elevator_${prefix}`], 'ukendt');
  const etageLabel = boligtype === 'hus' ? 'Antal etager' : 'Etage';
  const parts = [];

  if (isKnown(boligtype)) parts.push(`Bolig: ${boligtype}`);
  if (prefix === 'fra' && isKnown(info.kvadratmeter_fra)) parts.push(`Størrelse: ${formatSquareMeters(info.kvadratmeter_fra)}`);
  if (isKnown(etage)) parts.push(`${etageLabel}: ${etage}`);
  if (isKnown(kaelder)) parts.push(`Kælder: ${kaelder}`);
  if (isKnown(elevator)) parts.push(`Elevator: ${elevator}`);

  return parts.length > 0 ? `  ${parts.join(' | ')}` : null;
}

export function buildFlytteSms(info) {
  const linjer = [
    `📦 NY FLYTNING`,
    ``,
    `Navn: ${safe(info.navn)}`,
    `Tlf: ${safe(info.telefon)}`,
  ];

  linjer.push(``);
  linjer.push(`Fra: ${safe(info.flytte_fra)}`);
  const fraDetails = locationDetails(info, 'fra');
  if (fraDetails) linjer.push(fraDetails);

  linjer.push(``);
  linjer.push(`Til: ${safe(info.flytte_til)}`);
  const tilDetails = locationDetails(info, 'til');
  if (tilDetails) linjer.push(tilDetails);

  linjer.push(``);
  if (isKnown(info.parkering)) linjer.push(formatWithDetail('Parkering', info.parkering, info.parkering_detalje));
  if (isKnown(info.pakning)) linjer.push(`Pakning: ${safe(info.pakning)}`);
  if (isKnown(info.hvornaar)) linjer.push(`Hvornår: ${safe(info.hvornaar)}`);
  if (safe(info.tungt) === 'ja' && isKnown(info.tungt_detalje)) linjer.push(`Tungt: ${safe(info.tungt_detalje)}`);
  if (isKnown(info.kunde_tone) && safe(info.kunde_tone) !== 'standard') linjer.push(`Tone: ${safe(info.kunde_tone)}`);
  if (safe(info.ekstra_noter) !== 'Ikke oplyst') linjer.push(`Note: ${safe(info.ekstra_noter)}`);

  return linjer.join('\n');
}

export function buildFlytteCustomerSms(info) {
  const firmanavn = process.env.FIRMA_NAVN || 'flyttefirmaet';
  const navn = safe(info.navn) !== 'Ikke oplyst' ? ` ${safe(info.navn)}` : '';

  return `Hej${navn}

Din henvendelse til ${firmanavn} er modtaget.

Fra: ${safe(info.flytte_fra)}
Til: ${safe(info.flytte_til)}
Hvornår: ${safe(info.hvornaar)}

Vi ringer dig tilbage med et tilbud.

Hvis noget ikke passer — svar på denne SMS.
- ${firmanavn}`;
}
