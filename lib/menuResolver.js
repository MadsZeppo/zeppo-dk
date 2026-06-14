export const MENU = [
  {
    canonicalName: 'Pepperoni',
    wooProductId: 123,
    aliases: [
      'pepperoni',
      'peberoni',
      'paperoni',
      'pepperony',
      'pepperon',
      'peperoni',
      'pepperonni',
      'pepperonie',
      'pebberoni',
      'peperonni',
      'pepperrone',
      'papperoni',
      'papeoni',
      'piperoni',
      'pepperonz',
      'peppronz',
      'pepperone',
      'peperone',
      'piperrone',
      'pepperonne',
      'peppironi',
      'pepperroni',
      'peperroni',
      'pipperoni',
      'pepperoin',
      'pepperoini',
      'pepperonii',
    ],
  },
  {
    canonicalName: 'Margherita',
    wooProductId: 124,
    aliases: [
      'margherita',
      'margarita',
      'margerita',
      'margrita',
      'markerita',
      'makarita',
      'makkerita',
      'margherite',
      'makherita',
      'markherita',
      'margeritta',
      'margheritta',
      'margheritah',
      'margerite',
      'marghrita',
      'margarida',
      'margereta',
      'margheritha',
      'margaritha',
      'makeritha',
      'makeritta',
      'markereta',
      'markeritta',
      'margareta',
      'margharita',
      'margharitta',
      'margheretha',
      'markeritha',
      'makaritha',
      'makaritta',
      'makareta',
      'macarita',
      'macaritta',
      'macarella',
      'macaretta',
      'makkarella',
      'maccarella',
      'macarela',
      'maccarita',
    ],
  },
  {
    canonicalName: 'Kebab Durum',
    wooProductId: 125,
    aliases: [
      'kebab durum',
      'kebabdurum',
      'keba durum',
      'kabab durum',
      'kebap durum',
      'kebab durrum',
      'durrum',
      'kebab doorum',
      'kebab dorom',
      'kebap dorom',
      'keba doroom',
      'kebabb durum',
      'kebbab durum',
      'keba duurum',
      'kebab duurum',
      'kebap duurum',
      'kebbap durum',
      'kabap durum',
      'kebab durrom',
      'kebab dorem',
      'kebab doreme',
      'kebab dorim',
    ],
  },
  {
    canonicalName: 'Pepsi Max',
    wooProductId: 126,
    aliases: [
      'pepsi max',
      'pepsimax',
      'pepsi maks',
      'pepzi max',
      'pepzimax',
      'pepsimaks',
      'pepsi maqs',
      'pepsimaqs',
      'pepsi macks',
      'pepsi maz',
      'pepsi macs',
      'pepsi makz',
      'pepsy max',
      'pepsy maks',
      'pepsymax',
      'pepsymaks',
      'pepzymax',
      'pepsi maxt',
      'pepsi maxs',
      'pepsi maxx',
      'pps max',
      'pps maks',
    ],
  },
];

const NORMALIZED_MENU = MENU.map((item) => ({
  ...item,
  normalizedCanonicalName: normalizeText(item.canonicalName),
  normalizedAliases: item.aliases.map(normalizeText),
}));

export function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .trim()
    .replace(/[-_]/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a, b) {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  const current = new Array(b.length + 1);

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + cost
      );
    }
    previous.splice(0, previous.length, ...current);
  }

  return previous[b.length];
}

function fuzzyMatch(spoken) {
  if (spoken.length < 5 || /^\d+$/.test(spoken)) return null;

  let best = null;
  for (const item of NORMALIZED_MENU) {
    for (const alias of [item.normalizedCanonicalName, ...item.normalizedAliases]) {
      const distance = levenshtein(spoken, alias);
      const longest = Math.max(spoken.length, alias.length);
      const confidence = longest === 0 ? 0 : 1 - (distance / longest);
      const closeEnough = distance <= (longest <= 8 ? 1 : 2) && confidence >= 0.82;
      if (!closeEnough) continue;
      if (!best || confidence > best.confidence) {
        best = { item, confidence };
      }
    }
  }

  return best;
}

export function resolveMenuItem(spokenProduct) {
  const spoken = normalizeText(spokenProduct);
  if (!spoken) {
    return { ok: false, spokenProduct, reason: 'NO_MENU_MATCH' };
  }

  for (const item of NORMALIZED_MENU) {
    if (spoken === item.normalizedCanonicalName || item.normalizedAliases.includes(spoken)) {
      return {
        ok: true,
        productId: item.wooProductId,
        canonicalName: item.canonicalName,
        confidence: 1,
        method: 'alias_exact',
      };
    }
  }

  const fuzzy = fuzzyMatch(spoken);
  if (fuzzy) {
    return {
      ok: true,
      productId: fuzzy.item.wooProductId,
      canonicalName: fuzzy.item.canonicalName,
      confidence: Number(fuzzy.confidence.toFixed(2)),
      method: 'alias_fuzzy',
    };
  }

  return { ok: false, spokenProduct, reason: 'NO_MENU_MATCH' };
}

export function resolveOrderItems(items) {
  return items.map((item) => {
    const resolved = resolveMenuItem(item.product);
    return {
      ...resolved,
      spokenProduct: item.product,
      quantity: item.quantity,
    };
  });
}
