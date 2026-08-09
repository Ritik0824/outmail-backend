const PLACEHOLDER_PATTERN = /{{\s*([a-zA-Z0-9_ .-]+)\s*}}/g;

export function normalizePlaceholderName(value) {
  return value == null ? '' : String(value).trim().toLowerCase();
}

export function extractPlaceholders(...templates) {
  const placeholders = new Set();

  for (const template of templates) {
    if (!template) continue;
    for (const match of template.matchAll(PLACEHOLDER_PATTERN)) {
      placeholders.add(normalizePlaceholderName(match[1]));
    }
  }

  return [...placeholders];
}

export function fillPlaceholders(template, values) {
  if (!template) return '';
  const normalizedValues = Object.fromEntries(
    Object.entries(values || {}).map(([key, value]) => [
      normalizePlaceholderName(key),
      value == null ? '' : String(value),
    ]),
  );

  return template.replace(PLACEHOLDER_PATTERN, (_match, key) => (
    normalizedValues[normalizePlaceholderName(key)] ?? ''
  ));
}
