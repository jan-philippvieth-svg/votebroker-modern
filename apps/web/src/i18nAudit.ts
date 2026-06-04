/**
 * i18n Audit Tool
 * ===============
 * Run in browser console to find hardcoded strings that escaped translation.
 *
 * Usage (browser console):
 *   import('/i18nAudit.js').then(m => m.runAudit())
 *
 * Or: window.__i18nAudit?.()  (if exported via window)
 */

// Common German words that indicate untranslated content
const GERMAN_INDICATORS = [
  'Klicke', 'klicke', 'Kein', 'kein', 'keine', 'Keine', 'Plan', 'Regen',
  'Autoren', 'Strategie', 'Empfohlen', 'Votes', 'voten', 'scannen',
  'Analyse', 'Ergebnis', 'Durchlauf', 'Heute', 'Gesamt', 'Verfügbar',
  'Lädt', 'laden', 'Fehler', 'Warnung', 'Bereit', 'Aktiv', 'Inaktiv',
  'Gewicht', 'Zeitfenster', 'Nachhaltigkeit', 'Beziehungen', 'Einstellungen',
  'Zurücksetzen', 'Schließen', 'Öffnen', 'Hinzufügen', 'Entfernen',
  'Generieren', 'Regenerieren', 'Prüfen', 'Bestätigen', 'Widerrufen',
  'Anpassen', 'Bearbeiten', 'Speichern', 'Abbrechen', 'Weiter', 'Zurück',
];

// English strings that should be translated in non-EN locales
const ENGLISH_INDICATORS = [
  'Click', 'Loading', 'Error', 'Warning', 'Ready', 'Active', 'Inactive',
  'Total', 'Runs', 'Authors', 'Strategy', 'Plan', 'Generate', 'Scan',
  'Settings', 'Reset', 'Close', 'Open', 'Add', 'Remove', 'Edit', 'Save',
  'Cancel', 'Next', 'Back', 'Confirm', 'Revoke', 'Adjust',
  'Regular Curator', 'Balanced curation', 'No plan', 'Regeneration',
];

interface AuditResult {
  element: string;
  text: string;
  language: 'de' | 'en' | 'unknown';
  path: string;
}

function getElementPath(el: Element): string {
  const parts: string[] = [];
  let current: Element | null = el;
  while (current && parts.length < 5) {
    const id = current.id ? `#${current.id}` : '';
    const cls = current.className && typeof current.className === 'string'
      ? `.${current.className.split(' ')[0]}`
      : '';
    parts.unshift(`${current.tagName.toLowerCase()}${id}${cls}`);
    current = current.parentElement;
  }
  return parts.join(' > ');
}

export function runAudit(currentLocale: string = 'es'): void {
  const results: AuditResult[] = [];
  const isNonEN = currentLocale !== 'en' && currentLocale !== 'de';

  // Walk all text nodes in the DOM
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        const text = node.textContent?.trim() ?? '';
        if (text.length < 3) return NodeFilter.FILTER_REJECT;
        // Skip script/style/code content
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        const tag = parent.tagName.toLowerCase();
        if (['script', 'style', 'code', 'pre'].includes(tag)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    }
  );

  const seen = new Set<string>();
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = node.textContent?.trim() ?? '';
    if (!text || seen.has(text)) continue;
    seen.add(text);

    const isGerman = GERMAN_INDICATORS.some(w => text.includes(w));
    const isEnglish = isNonEN && ENGLISH_INDICATORS.some(w => text.includes(w));

    if (isGerman || isEnglish) {
      results.push({
        element: node.parentElement?.tagName ?? '?',
        text: text.slice(0, 80),
        language: isGerman ? 'de' : 'en',
        path: getElementPath(node.parentElement!),
      });
    }
  }

  console.group(`🔍 i18n Audit — locale: ${currentLocale}`);
  console.log(`Found ${results.length} potentially untranslated strings:\n`);

  const byLang = { de: results.filter(r => r.language === 'de'), en: results.filter(r => r.language === 'en') };

  if (byLang.de.length) {
    console.group(`🇩🇪 German strings (${byLang.de.length})`);
    byLang.de.forEach(r => console.log(`  "${r.text}"\n    → ${r.path}`));
    console.groupEnd();
  }
  if (byLang.en.length) {
    console.group(`🇬🇧 English strings in ${currentLocale} (${byLang.en.length})`);
    byLang.en.forEach(r => console.log(`  "${r.text}"\n    → ${r.path}`));
    console.groupEnd();
  }

  console.log(`\n✅ Coverage estimate: ${Math.max(0, 100 - results.length * 2).toFixed(0)}% (rough)`);
  console.groupEnd();
}

// Auto-export to window for easy console access
if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__i18nAudit = runAudit;
  console.info('i18n audit available: window.__i18nAudit("es")');
}
