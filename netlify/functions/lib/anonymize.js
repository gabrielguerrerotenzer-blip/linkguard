// Anonimizador de texto libre para cumplimiento de Ley 18.331.
// Detecta y reemplaza datos personales identificables (PII):
//   - Emails (excepto dominios oficiales uruguayos)
//   - Cédulas uruguayas (solo formato canónico con puntos y guion/slash)
//   - Cuentas bancarias / IBAN UY
//   - Tarjetas de crédito/débito
//   - Teléfonos uruguayos (móviles y fijos, con o sin prefijo internacional)
//
// Limitaciones conocidas:
//   - Cédulas "12345678" sin separadores NO se anonimizan (riesgo de falso
//     positivo sobre montos, IDs, fechas concatenadas, etc.)
//   - Teléfonos legítimos de bancos también se anonimizan (no hay forma de
//     distinguir contexto). Aceptable porque la info estructurada del fraude
//     se captura por separado en el flujo de reporte.

// Whitelist de dominios oficiales uruguayos. Match exacto o como sufijo
// (notificaciones@portal.brou.com.uy → oficial por sufijo .brou.com.uy).
const OFFICIAL_DOMAINS = [
  // Bancos
  'brou.com.uy', 'itau.com.uy', 'itau.uy', 'santander.com.uy', 'santander.uy',
  'bbva.com.uy', 'scotiabank.com.uy', 'heritage.com.uy', 'bandes.com.uy',
  'bhu.com.uy', 'bse.com.uy',
  // Fintech / procesadoras
  'oca.com.uy', 'prex.uy', 'midinero.com.uy', 'midinero.uy',
  'abitab.com.uy', 'redpagos.com.uy',
  // Utilities
  'antel.com.uy', 'antel.uy', 'ute.com.uy', 'ose.com.uy',
  // Gobierno, educación, militar (todo el TLD)
  'gub.uy', 'edu.uy', 'mil.uy',
];

function isOfficialDomain(domain) {
  const d = domain.toLowerCase();
  return OFFICIAL_DOMAINS.some(od => d === od || d.endsWith('.' + od));
}

export function anonymize(text) {
  if (typeof text !== 'string' || !text) return text;
  let out = text;

  // Orden importa: más específico → más genérico.

  // 1. EMAILS (con whitelist de dominios oficiales)
  out = out.replace(/\b[\w.+-]+@([\w.-]+\.\w{2,})\b/g, (m, domain) =>
    isOfficialDomain(domain) ? m : '[EMAIL]'
  );

  // 2. CÉDULAS uruguayas formato canónico (puntos + guion o slash)
  out = out.replace(/\b\d{1,3}\.\d{3}\.\d{3}[-/]\d\b/g, '[CÉDULA]');

  // 3. IBAN UY (UY + 24 dígitos, opcionalmente en grupos de 4)
  out = out.replace(/\bUY\d{2}(?:[\s-]?\d{4}){5}[\s-]?\d{4,8}\b/gi, '[CUENTA]');

  // 4. CUENTAS bancarias (18-22 dígitos consecutivos)
  out = out.replace(/\b\d{18,22}\b/g, '[CUENTA]');

  // 5. TARJETAS (13-19 dígitos, en cuartetos con separadores o consecutivos)
  out = out.replace(/\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{1,7}\b/g, '[TARJETA]');
  out = out.replace(/\b\d{13,19}\b/g, '[TARJETA]');

  // 6. TELÉFONOS UY
  // 6a. Móvil con prefijo internacional (+598 9X XXX XXX)
  out = out.replace(/(?:\+598|00598)[\s.-]?9\d[\s.-]?\d{3}[\s.-]?\d{3}\b/g, '[TELÉFONO]');
  // 6b. Móvil local (09X XXX XXX)
  out = out.replace(/\b09\d[\s.-]?\d{3}[\s.-]?\d{3}\b/g, '[TELÉFONO]');
  // 6c. Fijo Montevideo (2 XXX XX XX)
  out = out.replace(/\b2[\s.-]?\d{3}[\s.-]?\d{2}[\s.-]?\d{2}\b/g, '[TELÉFONO]');
  // 6d. Fijo interior (4X XX XX XX)
  out = out.replace(/\b4\d[\s.-]?\d{2}[\s.-]?\d{2}[\s.-]?\d{2}\b/g, '[TELÉFONO]');

  return out;
}
