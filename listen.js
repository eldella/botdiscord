const prism = require('prism-media');
const wav = require('wav');
const { Readable } = require('stream');
const {
  EndBehaviorType,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  StreamType,
} = require('@discordjs/voice');
const {
  transcribeAudio,
  getTrollReply,
  getToolResultReply,
  evaluateSpontaneousReply,
  synthesizeSpeech,
  SPONTANEOUS_SILENCE,
} = require('./ai');
const { SPONTANEOUS_EVENTS } = require('./spontaneous_events');

const MIN_AUDIO_BYTES = 48000 * 2 * 2 * 0.5; // ~0.5s de audio estéreo 16-bit 48kHz
const MIN_RMS = 150; // piso de ruido: por debajo de esto se descarta como silencio/ruido de fondo
const SILENCE_MS = 1500; // corta el turno tras 1.5s de silencio real (así se define el fin de una intervención)
const MAX_SPEECH_MS = 60_000; // red de seguridad: no corta la charla normal, solo evita una grabación eterna si nunca hay silencio
const COOLDOWN_MS = 3000; // ignora audio nuevo hasta 3s después de que el bot termina de hablar

const RATE_LIMIT_WINDOW_MS = 10_000; // ventana para contar interpelaciones al bot
const RATE_LIMIT_MAX_HITS = 3; // más de 3 en la ventana dispara el bloqueo
const RATE_LIMIT_BLOCK_MS = 30_000; // bloqueo por usuario tras pasarse de la raya

const HISTORY_MAX_MESSAGES = 20; // memoria del canal: últimas N intervenciones (de cualquiera)
const SPONTANEOUS_CHANCE = 0.2; // 20% de evaluar una intervención espontánea cuando no le hablan directo
const CANNED_EVENT_CHANCE = 0.5; // dentro de la espontánea: 50% evento de relleno (gratis), 50% vía LLM
const FOLLOWUP_WINDOW_MS = 8000; // ventana tras hablarle a alguien: su próxima frase cuenta como dirigida a él sin repetir el nombre

const PUNISHMENT_DURATION_MS = 30_000; // cuánto dura un mute/ensordecer de castigo antes de revertirse solo
const MODERATION_COOLDOWN_MS = 3 * 60_000; // cooldown compartido entre las 4 herramientas, por usuario

const BRAKE_LINES = [
  'Pará un cachito, no doy abasto con tanta cháchara tuya.',
  'Bajá un cambio, después seguimos la joda.',
  'Dejame respirar, ya te va a tocar de nuevo en un rato.',
];

function normalize(str) {
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

// Nombre oficial: Box (coincide con el username real del bot en Discord).
const BOT_NAME_PATTERN = /\bbox\b/i;

function mentionsBot(text) {
  return BOT_NAME_PATTERN.test(normalize(text));
}

function computeRms(pcmBuffer) {
  const sampleCount = pcmBuffer.length / 2;
  if (sampleCount === 0) return 0;

  let sumSquares = 0;
  for (let i = 0; i < pcmBuffer.length - 1; i += 2) {
    const sample = pcmBuffer.readInt16LE(i);
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / sampleCount);
}

// El audio de volumen bajo (aunque pase el filtro de silencio) es el que peor
// transcribe Whisper. Se sube la ganancia antes de mandarlo, en vez de
// depender de que la persona hable más fuerte. Gain topeado para no inflar
// ruido de fondo desproporcionadamente.
function normalizeVolume(pcmBuffer, targetPeak = 24000, maxGain = 4) {
  let peak = 1;
  for (let i = 0; i < pcmBuffer.length - 1; i += 2) {
    const sample = Math.abs(pcmBuffer.readInt16LE(i));
    if (sample > peak) peak = sample;
  }

  const gain = Math.min(targetPeak / peak, maxGain);
  if (gain <= 1) return pcmBuffer; // ya está fuerte, no hace falta subir

  const boosted = Buffer.alloc(pcmBuffer.length);
  for (let i = 0; i < pcmBuffer.length - 1; i += 2) {
    const scaled = Math.max(-32768, Math.min(32767, Math.round(pcmBuffer.readInt16LE(i) * gain)));
    boosted.writeInt16LE(scaled, i);
  }
  return boosted;
}

// Elige un evento de relleno al azar y sustituye [Nombre] por alguien de
// recentSpeakers. Si el evento elegido necesita nombre y no hay nadie
// disponible todavía, devuelve null (el llamador cae al camino del LLM).
function pickCannedEvent(recentSpeakers) {
  const event = SPONTANEOUS_EVENTS[Math.floor(Math.random() * SPONTANEOUS_EVENTS.length)];
  if (!event.includes('[Nombre]')) return event;

  const speakers = [...recentSpeakers.keys()];
  if (speakers.length === 0) return null;

  const target = speakers[Math.floor(Math.random() * speakers.length)];
  return event.replace('[Nombre]', target);
}

function pcmToWav(pcmBuffer) {
  return new Promise((resolve) => {
    const writer = new wav.Writer({ sampleRate: 48000, channels: 2, bitDepth: 16 });
    const chunks = [];
    writer.on('data', (chunk) => chunks.push(chunk));
    writer.on('finish', () => resolve(Buffer.concat(chunks)));
    writer.end(pcmBuffer);
  });
}

function attachListener(connection, client) {
  const player = createAudioPlayer();
  connection.subscribe(player);

  // Se escucha a todos en paralelo: cada hablante tiene su propia captura,
  // independiente de las demás. `responding` solo serializa la generación y
  // reproducción de la respuesta del bot (un audio de salida a la vez) — no
  // bloquea la captura/transcripción de nadie más mientras tanto.
  const activeRecordings = new Set(); // userIds con una captura en curso ahora mismo
  let responding = false;
  let cooldownUntil = 0;

  // Sigue una conversación directa sin obligar a repetir el nombre cada vez.
  let lastAddressedUserId = null;
  let lastAddressedUntil = 0;

  // Anti-spam por usuario: cuenta interpelaciones al bot y bloquea si abusa.
  const userHits = new Map(); // userId -> timestamps[]
  const userBlockedUntil = new Map(); // userId -> timestamp

  // Memoria del canal: se registra todo lo que se dice, se haya dirigido o no al bot.
  const channelHistory = [];
  const recentSpeakers = new Map(); // username -> userId, para resolver las herramientas de moderación
  const moderationCooldownUntil = new Map(); // userId -> timestamp, compartido entre las 4 herramientas

  const addToHistory = (role, name, text) => {
    channelHistory.push({ role, name, text });
    if (channelHistory.length > HISTORY_MAX_MESSAGES) channelHistory.shift();
  };

  // Ejecuta la acción de Discord real pedida por el modelo. Devuelve un string
  // describiendo el resultado (éxito, motivo de fallo, o cooldown activo) para
  // pasárselo de vuelta al LLM como resultado de la herramienta.
  const executeModerationTool = async (call) => {
    const targetId = recentSpeakers.get(call.args.usuario);
    if (!targetId) return `No encontré a "${call.args.usuario}" entre los que hablaron hace poco.`;

    const now = Date.now();
    const cooldownUntil = moderationCooldownUntil.get(targetId) ?? 0;
    if (now < cooldownUntil) {
      const remaining = Math.ceil((cooldownUntil - now) / 1000);
      console.log(`[voz] Moderación en cooldown para ${call.args.usuario}: ${remaining}s restantes, se ignora ${call.name}.`);
      return `Herramienta de moderación en cooldown para ${call.args.usuario} (quedan ${remaining}s): no se aplicó ninguna sanción, respondele solo con bardo en texto.`;
    }

    const guild = client.guilds.cache.get(connection.joinConfig.guildId);
    const member = guild && (await guild.members.fetch(targetId).catch(() => null));
    if (!member || !member.voice.channel) return `${call.args.usuario} no está en el canal de voz.`;

    const reason = 'Castigo automático del bot por insistencia/spam';

    const revertLater = (setter, label) => {
      setTimeout(async () => {
        const freshMember = await guild.members.fetch(targetId).catch(() => null);
        if (!freshMember) return;
        await setter(freshMember).catch(() => {});
        console.log(`[voz] Fin del castigo (${label}) para ${call.args.usuario}.`);
      }, PUNISHMENT_DURATION_MS);
    };

    try {
      let outcome;
      switch (call.name) {
        case 'mutear_usuario':
          await member.voice.setMute(true, reason);
          revertLater((m) => m.voice.setMute(false, 'Fin del castigo automático'), 'mute');
          outcome = `Muteaste a ${call.args.usuario} por ${PUNISHMENT_DURATION_MS / 1000}s.`;
          break;
        case 'ensordecer_usuario':
          await member.voice.setDeaf(true, reason);
          revertLater((m) => m.voice.setDeaf(false, 'Fin del castigo automático'), 'ensordecer');
          outcome = `Ensordeciste a ${call.args.usuario} por ${PUNISHMENT_DURATION_MS / 1000}s.`;
          break;
        case 'mover_usuario':
          if (!guild.afkChannelId) return `El servidor no tiene canal AFK configurado, no se pudo mover a ${call.args.usuario}.`;
          await member.voice.setChannel(guild.afkChannelId, reason);
          outcome = `Moviste a ${call.args.usuario} al canal AFK.`;
          break;
        case 'desconectar_usuario':
          await member.voice.disconnect(reason);
          outcome = `Desconectaste a ${call.args.usuario} del canal de voz.`;
          break;
        default:
          return `Acción desconocida: ${call.name}.`;
      }

      const nextCooldown = Date.now() + MODERATION_COOLDOWN_MS;
      moderationCooldownUntil.set(targetId, nextCooldown);
      console.log(`[voz] Moderación aplicada (${call.name}) sobre ${call.args.usuario}, cooldown hasta ${new Date(nextCooldown).toLocaleTimeString()}.`);
      return outcome;
    } catch (error) {
      console.error(`[voz] Error ejecutando ${call.name} sobre ${call.args.usuario}:`, error.message);
      return `No se pudo ejecutar ${call.name} sobre ${call.args.usuario}: falta el permiso de Discord necesario.`;
    }
  };

  const checkRateLimit = (userId) => {
    const now = Date.now();
    const blockedUntil = userBlockedUntil.get(userId) ?? 0;
    if (now < blockedUntil) return 'blocked';

    const hits = (userHits.get(userId) ?? []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    hits.push(now);

    if (hits.length > RATE_LIMIT_MAX_HITS) {
      userBlockedUntil.set(userId, now + RATE_LIMIT_BLOCK_MS);
      userHits.set(userId, []);
      return 'just_blocked';
    }

    userHits.set(userId, hits);
    return 'ok';
  };

  connection.receiver.speaking.on('start', (userId) => {
    if (activeRecordings.has(userId)) return; // ya se está grabando a esta persona
    activeRecordings.add(userId);

    const opusStream = connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: SILENCE_MS },
    });

    const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
    const chunks = [];
    let finished = false;

    // Libera la captura de ESTA persona (para que Discord pueda volver a
    // dispararle 'speaking start' con su próxima frase), independiente de si
    // el bot termina generando o no una respuesta.
    const releaseCapture = () => {
      activeRecordings.delete(userId);
    };

    const finishRecording = async () => {
      if (finished) return;
      finished = true;
      clearTimeout(maxDurationTimer);
      opusStream.destroy();
      releaseCapture();

      const pcm = Buffer.concat(chunks);
      if (pcm.length < MIN_AUDIO_BYTES) return;

      const rms = computeRms(pcm);
      console.log(`[voz] RMS=${rms.toFixed(0)} (${(pcm.length / (48000 * 2 * 2)).toFixed(2)}s)`);
      if (rms < MIN_RMS) return;

      try {
        const wavBuffer = await pcmToWav(normalizeVolume(pcm));
        const { text, lang } = await transcribeAudio(wavBuffer, 'Box');
        if (!text) return;

        const user = await client.users.fetch(userId).catch(() => null);
        const speakerName = user?.username ?? userId;
        console.log(`[voz] ${user?.tag ?? userId} dijo: ${text}`);
        addToHistory('user', speakerName, text);
        recentSpeakers.set(speakerName, userId);

        const isFollowUp = userId === lastAddressedUserId && Date.now() < lastAddressedUntil;
        const directlyAddressed = mentionsBot(text) || isFollowUp;
        const rollsSpontaneous = !directlyAddressed && Math.random() < SPONTANEOUS_CHANCE;
        if (!directlyAddressed && !rollsSpontaneous) return;

        // A partir de acá el bot se enfoca en generar UNA respuesta a la vez;
        // mientras tanto sigue escuchando/transcribiendo a todos los demás.
        if (responding || Date.now() < cooldownUntil) {
          console.log(`[voz] Se ignora a ${speakerName}: el bot ya está respondiendo a otra persona o en cooldown.`);
          return;
        }
        responding = true;

        try {
          let replyText;
          let speakSlow = false;

          if (directlyAddressed) {
            const rateLimitState = checkRateLimit(userId);
            if (rateLimitState === 'blocked') return;

            if (rateLimitState === 'just_blocked') {
              replyText = BRAKE_LINES[Math.floor(Math.random() * BRAKE_LINES.length)];
              console.log(`[voz] ${userId} bloqueado 30s por spam, freno: ${replyText}`);
            } else {
              const recentHits = (userHits.get(userId) ?? []).length;
              const note = recentHits > 2 ? `Dato objetivo: ${speakerName} te habló ${recentHits} veces en los últimos ${RATE_LIMIT_WINDOW_MS / 1000}s.` : undefined;

              const result = await getTrollReply(channelHistory, note);
              if (result.toolCalls.length > 0) {
                const outcomes = await Promise.all(result.toolCalls.map(executeModerationTool));
                outcomes.forEach((o) => console.log(`[voz] Moderación: ${o}`));
                replyText = await getToolResultReply(result.messages, result.toolCalls, outcomes);
              } else {
                replyText = result.text;
                speakSlow = result.slow;
              }
              console.log(`[voz] Bot responde: ${replyText}${speakSlow ? ' (modo lento)' : ''}`);
            }
          } else {
            const cannedEvent = Math.random() < CANNED_EVENT_CHANCE ? pickCannedEvent(recentSpeakers) : null;

            if (cannedEvent) {
              replyText = cannedEvent;
              console.log(`[voz] Evento espontáneo (enlatado): ${replyText}`);
            } else {
              const evaluation = await evaluateSpontaneousReply(channelHistory);
              const isSilence = evaluation.toUpperCase().replace(/[^A-ZÁÉÍÓÚÑ]/g, '') === SPONTANEOUS_SILENCE;
              if (isSilence) {
                console.log('[voz] Intervención espontánea evaluada: SILENCIO');
                return;
              }
              replyText = evaluation;
              console.log(`[voz] Bot interviene espontáneamente (LLM): ${replyText}`);
            }
          }

          if (directlyAddressed) {
            lastAddressedUserId = userId;
            lastAddressedUntil = Date.now() + FOLLOWUP_WINDOW_MS;
          }

          addToHistory('assistant', client.user.username, replyText);

          const speechBuffer = await synthesizeSpeech(replyText, lang, { slow: speakSlow });
          const resource = createAudioResource(Readable.from(speechBuffer), {
            inputType: StreamType.Arbitrary,
          });

          await new Promise((resolve) => {
            player.once(AudioPlayerStatus.Idle, () => {
              cooldownUntil = Date.now() + COOLDOWN_MS;
              resolve();
            });
            player.play(resource);
          });
        } finally {
          responding = false;
        }
      } catch (error) {
        console.error('[voz] Error en el pipeline de audio:', error);
      }
    };

    const maxDurationTimer = setTimeout(finishRecording, MAX_SPEECH_MS);

    opusStream
      .pipe(decoder)
      .on('data', (chunk) => chunks.push(chunk))
      .on('error', () => {
        finished = true;
        clearTimeout(maxDurationTimer);
        releaseCapture();
      })
      .on('end', finishRecording);
  });
}

module.exports = { attachListener };
