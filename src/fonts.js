// CSS family + weight + style -> the PostScript name After Effects needs.
// AE only finds fonts installed on the machine; web fonts must be installed
// as OTF/TTF first (see README "Fonts").

const KNOWN = {
  'TeXGyreHeros|700|normal': 'TeXGyreHeros-Bold',
  'TeXGyreHeros|400|normal': 'TeXGyreHeros-Regular',
  'TeXGyreHeros|700|italic': 'TeXGyreHeros-BoldItalic',
  'TeXGyreHeros|400|italic': 'TeXGyreHeros-Italic',
  'Instrument Serif|400|normal': 'InstrumentSerif-Regular',
  'Instrument Serif|400|italic': 'InstrumentSerif-Italic',
  'Inter|400|normal': 'Inter-Regular',
  'Inter|700|normal': 'Inter-Bold',
  'Inter|800|normal': 'Inter-ExtraBold',
  'Inter|900|normal': 'Inter-Black',
  'Anton|400|normal': 'Anton-Regular',
  'Playfair Display|400|italic': 'PlayfairDisplay-Italic',
};

const WEIGHTS = { 100: 'Thin', 200: 'ExtraLight', 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'SemiBold', 700: 'Bold', 800: 'ExtraBold', 900: 'Black' };

export function psName({ family, weight, style }) {
  const w = String(weight === 'bold' ? 700 : weight === 'normal' ? 400 : weight);
  const s = style === 'italic' || style === 'oblique' ? 'italic' : 'normal';
  const key = `${family}|${w}|${s}`;
  if (KNOWN[key]) return { name: KNOWN[key], known: true };
  let suffix = WEIGHTS[w] || 'Regular';
  if (s === 'italic') suffix = suffix === 'Regular' ? 'Italic' : `${suffix}Italic`;
  return { name: `${family.replace(/\s+/g, '')}-${suffix}`, known: false };
}
