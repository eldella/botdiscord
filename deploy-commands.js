require('dotenv').config();

const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const commands = [
  new SlashCommandBuilder().setName('ping').setDescription('Responde con Pong!'),
  new SlashCommandBuilder().setName('join').setDescription('Entra a tu canal de voz actual'),
  new SlashCommandBuilder().setName('leave').setDescription('Sale del canal de voz'),
].map((command) => command.toJSON());

const rest = new REST().setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    const route = process.env.GUILD_ID
      ? Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID)
      : Routes.applicationCommands(process.env.CLIENT_ID);

    await rest.put(route, { body: commands });
    console.log('Comandos registrados correctamente.');
  } catch (error) {
    console.error(error);
  }
})();
