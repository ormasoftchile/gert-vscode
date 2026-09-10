import { createHighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import sql from 'shiki/langs/sql.mjs';
import kusto from 'shiki/langs/kusto.mjs';
import powershell from 'shiki/langs/powershell.mjs';
import light from 'shiki/themes/github-light.mjs';
import dark from 'shiki/themes/github-dark.mjs';
import type { ThemeRegistration } from 'shiki';
import { MAX_CODE_UNITS, supportedDescriptor, type Descriptor } from '../../src/presentationProtocol';
import type { ColoredSpan } from '../../src/presentationScalar';

export type Palette = 'light' | 'dark' | 'hc' | 'hc-light';
const contrast = (isLight: boolean): ThemeRegistration => ({
  name: isLight ? 'gert-hc-light' : 'gert-hc', type: isLight ? 'light' : 'dark',
  colors: { 'editor.background': isLight ? '#FFFFFF' : '#000000', 'editor.foreground': isLight ? '#000000' : '#FFFFFF' },
  tokenColors: [
    { scope: ['comment'], settings: { foreground: isLight ? '#006400' : '#00FF00' } },
    { scope: ['keyword', 'storage'], settings: { foreground: isLight ? '#000080' : '#FFFF00' } },
    { scope: ['string'], settings: { foreground: isLight ? '#800000' : '#00FFFF' } },
    { scope: ['variable'], settings: { foreground: isLight ? '#800080' : '#FFAAFF' } },
    { scope: ['constant.numeric'], settings: { foreground: isLight ? '#000000' : '#FFFFFF' } },
  ],
});
const themes: Record<Palette, string> = { light: 'github-light', dark: 'github-dark', hc: 'gert-hc', 'hc-light': 'gert-hc-light' };
let highlighter: ReturnType<typeof createHighlighterCore> | undefined;
export function warmup() {
  return highlighter ??= createHighlighterCore({ langs: [sql, kusto, powershell],
    themes: [light, dark, contrast(false), contrast(true)], engine: createJavaScriptRegexEngine() });
}
export function interpolationSpans(text: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < text.length;) {
    if (text.startsWith('\\${', i)) { i += 3; continue; }
    if (text.startsWith('$${', i)) throw new Error('invalid-interpolation');
    if (text[i] === '\\') { i += Math.min(2, text.length - i); continue; }
    if (!text.startsWith('${', i)) { i++; continue; }
    const start = i;
    i += 2;
    let depth = 0, closed = false;
    for (; i < text.length; i++) {
      const char = text[i];
      if (char === '"' || char === "'") {
        const quote = char;
        let quoteClosed = false;
        for (i++; i < text.length; i++) {
          if (text[i] === '\\') { i++; continue; }
          if (text[i] === quote) { quoteClosed = true; break; }
        }
        if (!quoteClosed) break;
      } else if (char === '(' || char === '[') depth++;
      else if ((char === ')' || char === ']') && depth) depth--;
      else if (char === '}' && !depth) { closed = true; break; }
    }
    if (!closed || !text.slice(start + 2, i).trim()) throw new Error('incomplete-interpolation');
    spans.push({ start, end: ++i });
  }
  return spans;
}
export async function tokenize(text: string, descriptor: Descriptor, palette: Palette, legacyMacros = true): Promise<ColoredSpan[]> {
  if (text.length > MAX_CODE_UNITS) throw new Error('limit-exceeded');
  if (!supportedDescriptor(descriptor)) throw new Error('unsupported-language');
  const engine = await warmup();
  let macros: Array<{ start: number; end: number }> = [];
  if (legacyMacros) {
    try { macros = interpolationSpans(text); } catch { /* Invalid GIS must not suppress host language colors. */ }
  }
  const lang = descriptor.language === 'kql' ? 'kusto' : descriptor.language;
  const tokens = engine.codeToTokensBase(text, { lang, theme: themes[palette] ?? themes.dark });
  const output: ColoredSpan[] = [];
  for (const token of tokens.flat()) {
    if (!token.content.length) continue;
    const end = token.offset + token.content.length;
    const cuts = [...new Set([token.offset, end, ...macros.flatMap(m => [m.start, m.end]).filter(p => p > token.offset && p < end)])].sort((a, b) => a - b);
    for (let i = 0; i + 1 < cuts.length; i++) {
      const start = cuts[i], stop = cuts[i + 1], macro = macros.some(m => start >= m.start && stop <= m.end);
      const color = macro ? palette === 'light' || palette === 'hc-light' ? '#6F42C1' : '#FFAB70' : token.color ?? '#808080';
      output.push({ start, end: stop, color, ...(macro ? { macro: true } : {}) });
    }
  }
  return output;
}
