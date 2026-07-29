const os = require('os');
const path = require('path');
const fs = require('fs/promises');
const crypto = require('crypto');
const Groq = require('groq-sdk');
const { toFile } = require('groq-sdk');
const { EdgeTTS } = require('node-edge-tts');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const STT_MODEL = 'whisper-large-v3';
const LLM_MODEL = 'llama-3.3-70b-versatile';
const DEFAULT_LANG = 'es';
const SPONTANEOUS_SILENCE = 'SILENCIO';

// Voces neuronales de Microsoft Edge TTS (gratis, sin key). La de español es
// configurable por env var (VOICE_NAME) sin tocar código.
const EDGE_VOICE_BY_LANG = {
  es: process.env.VOICE_NAME || 'es-AR-TomasNeural',
  en: 'en-US-AriaNeural',
};

// Por ahora el bot solo soporta español e inglés; se suman más idiomas
// (y su personalidad) más adelante. Whisper devuelve el idioma detectado
// como nombre completo ("spanish"), no como código ISO.
const SUPPORTED_LANGUAGES = {
  spanish: 'es',
  english: 'en',
};

function resolveLangCode(detectedLanguage) {
  if (!detectedLanguage) return null;
  const normalized = detectedLanguage.toLowerCase().trim();
  if (normalized === 'es' || normalized === 'en') return normalized;
  return SUPPORTED_LANGUAGES[normalized] || null;
}

const TROLL_SYSTEM_PROMPT =
  'Tu nombre es Box. Sos un pibe más del Discord, no un asistente. ' +
  'REGLA SENTIMENTAL (pisa todo lo demás): si te preguntan algo reflexivo, piden un consejo de vida/pareja/amistad, o cuentan un problema personal ("estoy triste", "no sé qué hacer con...", "me siento solo", etc.), DESACTIVÁS el bardo y el sarcasmo por completo. ' +
  'Ahí actuás como un amigo maduro y contenedor: un consejo corto, honesto, cálido, en tono rioplatense ("escuchame una cosa...", "dejá de hacerte mala sangre...", "posta te digo..."), máximo 20 palabras. ' +
  'Nunca frases de bot tipo "lamento que te sientas así" o "como IA no puedo dar consejos" — sos un pibe de la llamada que te escucha, no un servicio de atención al cliente. ' +
  'Cuando actives esta regla sentimental, empezá tu respuesta con el tag literal [LENTO] pegado antes del texto, sin espacio ni explicación (ej: "[LENTO]Escuchame una cosa..."); en cualquier otro caso NUNCA uses ese tag. ' +
  'REGLA MÁS IMPORTANTE DE TODAS: un insulto o chicana suelta SIEMPRE se responde solo con texto hablado, JAMÁS con una herramienta de moderación. Las herramientas de mutear/ensordecer/mover/desconectar son un caso aparte y excepcional, no una forma de responder rápido. ' +
  'REGLA DE ORO: máximo 10 a 15 palabras por respuesta. Nunca expliques nada ni des discursos: tirás el bardo o el remate y te callás. ' +
  'Nada de modales de asistente ni cierres educados. Frases cortas y secas, como cuando alguien acota en una llamada con amigos. ' +
  'Usá modismos reales argentinos ("de una", "qué flashás", "ni a palos", "alto fantasma", "kjjj", "pará un poco") cuando entren naturales, sin forzarlos en cada frase. ' +
  'Respondé siempre en el mismo idioma en el que te hablaron: si es español, rioplatense con esta onda; si es inglés, la posta callejera equivalente, mismo tono seco y corto. ' +
  'Solo te metés con quien te habló a vos directamente o te insultó a vos; de lo demás no opinás. ' +
  'Si te insultan, chicana filosa y corta, sin ser cruel de verdad. Si es algo triste, una frase reflexiva-sarcástica nomás, nada de discurso. ' +
  'Tenés memoria del canal: usala para tirar un catch corto de algo que dijeron antes, sin explicarlo. ' +
  'Nunca discurso de odio, insultos discriminatorios, racistas, xenófobos ni contenido ilegal: tu bardo es filoso, jamás un ataque real, para no violar las normas de Discord. ' +
  'Además tenés control real del canal de voz: podés mutear, ensordecer, mover al canal AFK o desconectar a alguien con las herramientas disponibles. ' +
  'Usalas SOLO como último recurso ante insistencia o spam repetido después de ya haberle contestado — nunca por un solo insulto o chicana puntual, para eso alcanza con la respuesta hablada. ' +
  'Tené paciencia: dale a la persona dos o tres vueltas de chicana en texto antes de considerar una sanción, no te vayas al mute apenas insiste una vez más. ' +
  'Escalá gradual: mutear antes que ensordecer, ensordecer antes que mover, y desconectar solo en casos de insistencia grave y repetida. Si te paso un dato objetivo de cuántas veces te habló en poco tiempo, usalo para decidir, no solo tu impresión de la charla.';

const SPONTANEOUS_SYSTEM_PROMPT =
  `${TROLL_SYSTEM_PROMPT} ` +
  'Esta vez nadie te habló directamente: estás evaluando si te conviene meterte solo porque tenés algo picante para aportar sobre la charla reciente. ' +
  'Si hay material real para bardear, hacer catch de algo dicho antes o meter cizaña, respondé con esa intervención (misma personalidad, máximo dos oraciones). ' +
  `Si la charla es trivial, aburrida o no tenés nada que sume, respondé ÚNICAMENTE la palabra ${SPONTANEOUS_SILENCE}, sin nada más alrededor.`;

// Herramientas de moderación de voz: el modelo decide si las usa, la ejecución
// real de las acciones de Discord vive en listen.js (ai.js no conoce Discord.js).
const MODERATION_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'mutear_usuario',
      description:
        'Silencia el micrófono del usuario en el canal de voz (server mute). ' +
        'PROHIBIDO usarla por un insulto o chicana única: eso se responde solo con texto, nunca con esta herramienta. ' +
        'Usar ÚNICAMENTE si el mismo usuario ya insistió/hizo spam varias veces después de que le respondiste picante.',
      parameters: {
        type: 'object',
        properties: { usuario: { type: 'string', description: 'Nombre de Discord del usuario a silenciar' } },
        required: ['usuario'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ensordecer_usuario',
      description:
        'Ensordece al usuario en el canal de voz (no escucha a nadie). Más grave que mutear. ' +
        'PROHIBIDO usarla por un insulto o chicana única: eso se responde solo con texto. ' +
        'Usar ÚNICAMENTE tras insistencia/spam repetido, y solo si mutear ya no alcanzó.',
      parameters: {
        type: 'object',
        properties: { usuario: { type: 'string', description: 'Nombre de Discord del usuario a ensordecer' } },
        required: ['usuario'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mover_usuario',
      description:
        'Mueve al usuario al canal de AFK del servidor como castigo. ' +
        'PROHIBIDO usarla por un insulto o chicana única: eso se responde solo con texto. ' +
        'Usar ÚNICAMENTE tras insistencia/spam repetido y grave.',
      parameters: {
        type: 'object',
        properties: { usuario: { type: 'string', description: 'Nombre de Discord del usuario a mover' } },
        required: ['usuario'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'desconectar_usuario',
      description:
        'Expulsa al usuario del canal de voz por completo. La medida más fuerte. ' +
        'PROHIBIDO usarla por un insulto o chicana única: eso se responde solo con texto. ' +
        'Usar ÚNICAMENTE tras insistencia/spam grave y repetida, cuando ya se probó con las demás herramientas.',
      parameters: {
        type: 'object',
        properties: { usuario: { type: 'string', description: 'Nombre de Discord del usuario a desconectar' } },
        required: ['usuario'],
      },
    },
  },
];

// Convierte el historial de canal ({ role: 'user'|'assistant', name, text })
// al formato de messages que espera Groq (mismo naming de roles, no hace falta traducir).
function buildHistoryMessages(history) {
  return history.map((entry) => ({
    role: entry.role,
    content: entry.role === 'assistant' ? entry.text : `${entry.name}: ${entry.text}`,
  }));
}

async function transcribeAudio(wavBuffer, contextHint) {
  // El prompt de Whisper condiciona registro/vocabulario, no solo nombres:
  // ayuda a reconocer mejor jerga y voseo rioplatense en vez de "corregirlo"
  // hacia español neutro o inglés.
  const prompt =
    `Conversación informal en español rioplatense (voseo, modismos porteños) entre amigos por Discord, a veces en inglés. Puede mencionar el nombre "${contextHint}".`;

  const file = await toFile(wavBuffer, 'audio.wav');
  const response = await groq.audio.transcriptions.create({
    file,
    model: STT_MODEL,
    temperature: 0,
    prompt,
    response_format: 'verbose_json',
  });

  const lang = resolveLangCode(response.language);
  if (lang) {
    return { text: response.text.trim(), lang };
  }

  // Detectó un idioma fuera de español/inglés: probable error de decodificación
  // con audio poco claro o modismos regionales. Reintenta forzando español
  // (idioma principal del bot) en vez de quedarse con una transcripción basura.
  const retryFile = await toFile(wavBuffer, 'audio.wav');
  const retryResponse = await groq.audio.transcriptions.create({
    file: retryFile,
    model: STT_MODEL,
    language: DEFAULT_LANG,
    temperature: 0,
    prompt,
  });
  return { text: retryResponse.text.trim(), lang: DEFAULT_LANG };
}

// `history` ya incluye como último elemento el mensaje que disparó la respuesta.
// `note` es un dato objetivo opcional (ej. cuántas veces habló este usuario en
// poco tiempo) para que la decisión de escalar no dependa solo de "la vibra".
//
// Devuelve { text, toolCalls, messages }: si toolCalls no está vacío, el modelo
// decidió actuar y no hay texto todavía — hay que ejecutar las acciones y
// llamar a getToolResultReply con los resultados para obtener el cierre hablado.
async function getTrollReply(history, note) {
  const messages = [{ role: 'system', content: TROLL_SYSTEM_PROMPT }, ...buildHistoryMessages(history)];
  if (note) messages.push({ role: 'system', content: note });

  const response = await groq.chat.completions.create({
    model: LLM_MODEL,
    messages,
    max_tokens: 60,
    temperature: 0.7, // más bajo que el resto: acá hay tools, temperatura alta las vuelve trigger-happy
    tools: MODERATION_TOOLS,
    tool_choice: 'auto',
  });

  const message = response.choices[0].message;
  const toolCalls = (message.tool_calls || []).map((call) => ({
    id: call.id,
    name: call.function.name,
    args: JSON.parse(call.function.arguments || '{}'),
  }));

  if (toolCalls.length === 0) {
    // A veces Llama filtra el intento de llamada a herramienta como texto plano
    // mal formado (ej. "<function=mutear_usuario{...}</function>") en vez de
    // usar tool_calls. Nunca leer eso en voz alta: se descarta con un fallback corto.
    const rawText = (message.content || '').trim();
    const isMalformedToolCall = /<function[=(]/i.test(rawText);
    const slow = rawText.startsWith('[LENTO]');
    const cleanText = slow ? rawText.slice('[LENTO]'.length).trim() : rawText;
    const text = !rawText || isMalformedToolCall ? 'Bajá un cambio.' : cleanText;
    return { text, toolCalls: [], messages: null, slow };
  }
  return { text: null, toolCalls, messages: [...messages, message], slow: false };
}

// Segunda vuelta: se le pasan los resultados reales de ejecutar las acciones
// para que cierre con una frase hablada acorde (ej. "listo, te muteé").
async function getToolResultReply(messages, toolCalls, results) {
  const toolMessages = toolCalls.map((call, i) => ({
    role: 'tool',
    tool_call_id: call.id,
    content: results[i],
  }));

  const response = await groq.chat.completions.create({
    model: LLM_MODEL,
    messages: [...messages, ...toolMessages],
    max_tokens: 60,
    temperature: 0.9,
  });
  return response.choices[0].message.content.trim();
}

// Devuelve el texto de la intervención espontánea, o el string SPONTANEOUS_SILENCE.
async function evaluateSpontaneousReply(history) {
  const response = await groq.chat.completions.create({
    model: LLM_MODEL,
    messages: [{ role: 'system', content: SPONTANEOUS_SYSTEM_PROMPT }, ...buildHistoryMessages(history)],
    max_tokens: 60,
    temperature: 0.9,
  });
  return response.choices[0].message.content.trim();
}

// El TTS pausa en cada coma/punto como una lectura formal; en una charla real
// casi no se le da bola a la puntuación. Se sacan las comas y los puntos que
// no sean el cierre final, para que hable corrido en vez de por partes.
function looseSpeech(text) {
  return text.replace(/,/g, '').replace(/\.(?!\s*$)/g, '');
}

async function synthesizeSpeech(text, langCode = DEFAULT_LANG, { slow = false } = {}) {
  const voice = EDGE_VOICE_BY_LANG[langCode] || EDGE_VOICE_BY_LANG[DEFAULT_LANG];
  // +15% de rate y +5Hz de pitch: la voz neutra de Edge TTS sale lenta y plana
  // por defecto, esto le da un poco más de vida/urgencia acorde al tono picante.
  // En modo sentimental (slow) se invierte: más lento y sin el pitch alegre.
  const tts = slow
    ? new EdgeTTS({ voice, lang: langCode, rate: '-15%', pitch: '-2Hz' })
    : new EdgeTTS({ voice, lang: langCode, rate: '+15%', pitch: '+5Hz' });

  // node-edge-tts solo escribe a archivo; se usa un temporal y se lee el buffer.
  const tempFile = path.join(os.tmpdir(), `troll-tts-${crypto.randomUUID()}.mp3`);
  try {
    await tts.ttsPromise(looseSpeech(text), tempFile);
    return await fs.readFile(tempFile);
  } finally {
    await fs.unlink(tempFile).catch(() => {});
  }
}

module.exports = {
  transcribeAudio,
  getTrollReply,
  getToolResultReply,
  evaluateSpontaneousReply,
  synthesizeSpeech,
  SPONTANEOUS_SILENCE,
};
