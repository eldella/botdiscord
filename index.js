require('dotenv').config();

const { Client, GatewayIntentBits } = require('discord.js');
const {
  joinVoiceChannel,
  getVoiceConnection,
  VoiceConnectionStatus,
  entersState,
} = require('@discordjs/voice');
const { attachListener } = require('./listen');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once('clientReady', () => {
  console.log(`Bot conectado como ${client.user.tag}`);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'ping') {
    await interaction.reply('Pong!');
  }

  if (interaction.commandName === 'join') {
    const member = await interaction.guild.members.fetch(interaction.user.id);
    const channel = member.voice.channel;

    if (!channel) {
      await interaction.reply({ content: 'Tenés que estar en un canal de voz.', ephemeral: true });
      return;
    }

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: interaction.guildId,
      adapterCreator: interaction.guild.voiceAdapterCreator,
      selfDeaf: false,
    });

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 10_000);
    } catch (error) {
      connection.destroy();
      await interaction.reply({ content: 'No pude conectarme al canal de voz.', ephemeral: true });
      return;
    }

    attachListener(connection, client);

    await interaction.reply(`Conectado a **${channel.name}**.`);
  }

  if (interaction.commandName === 'leave') {
    const connection = getVoiceConnection(interaction.guildId);

    if (!connection) {
      await interaction.reply({ content: 'No estoy conectado a ningún canal de voz.', ephemeral: true });
      return;
    }

    connection.destroy();
    await interaction.reply('Desconectado del canal de voz.');
  }
});

client.login(process.env.DISCORD_TOKEN);
