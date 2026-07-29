# Bot de Discord con personalidad e IA de voz

Bot de Discord en Node.js que se une a un canal de voz, escucha a todos los participantes en simultáneo, y responde con voz sintetizada usando una personalidad sarcástica y competitiva estilo Rioplatense. Incluye memoria de canal, intervenciones espontáneas y moderación de voz controlada por IA.

## Stack

- **[discord.js](https://discord.js.org/)** + **[@discordjs/voice](https://github.com/discordjs/voice)** — conexión y captura de audio del canal de voz.
- **[Groq](https://groq.com/)** (`whisper-large-v3` + `llama-3.3-70b-versatile`) — transcripción de voz y generación de respuestas, con function calling para moderación.
- **[Edge TTS](https://www.npmjs.com/package/node-edge-tts)** — síntesis de voz gratuita con voces neuronales de Microsoft.
- **[prism-media](https://www.npmjs.com/package/prism-media)** + **[opusscript](https://www.npmjs.com/package/opusscript)** — decodificación de audio Opus a PCM.

## Funcionalidad

- **Escucha en paralelo**: cada persona en el canal tiene su propia captura de audio independiente; el bot no necesita "turnos" para escuchar a todos.
- **Wake word**: responde cuando lo llaman por nombre, con reconocimiento fonético tolerante a errores de transcripción.
- **Memoria de canal**: recuerda los últimos mensajes de la conversación (se lo hablen a él o no) para hacer callbacks y mantener contexto.
- **Intervenciones espontáneas**: probabilidad configurable de opinar sin que lo llamen, combinando un banco de ~100 frases de relleno con generación vía LLM.
- **Modo sentimental**: detecta cuando alguien pide un consejo genuino o cuenta un problema personal y responde con empatía en vez de sarcasmo.
- **Moderación por voz**: puede mutear, ensordecer, mover o desconectar a un usuario ante insistencia/spam repetido, vía function calling — nunca por un insulto puntual. Incluye cooldowns y reversión automática de sanciones.
- **Multilenguaje**: detección automática de español/inglés en la transcripción y en la voz de salida.

## Setup

```bash
npm install
cp .env.example .env   # completar con tus credenciales
node deploy-commands.js  # registra los slash commands
npm start
```

### Variables de entorno

| Variable | Descripción |
| --- | --- |
| `DISCORD_TOKEN` | Token del bot en el [Developer Portal](https://discord.com/developers/applications). |
| `CLIENT_ID` | ID de la aplicación de Discord. |
| `GUILD_ID` | ID del servidor (opcional, para registrar comandos solo ahí durante desarrollo). |
| `GROQ_API_KEY` | API key de [Groq](https://console.groq.com/). |
| `VOICE_NAME` | Voz de Edge TTS a usar (opcional, default `es-AR-TomasNeural`). |

El bot necesita permisos de **Ver canales, Conectar, Hablar, Silenciar, Ensordecer y Mover miembros** al invitarlo, además de los scopes `bot` y `applications.commands`.

## Comandos

- `/join` — se conecta al canal de voz del usuario.
- `/leave` — se desconecta.
- `/ping` — comando de prueba.

## Licencia

[MIT](./LICENSE)
