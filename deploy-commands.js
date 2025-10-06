import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { REST, Routes } from 'discord.js';

// Load commands from the correct folder in this project layout
const commandsPath = path.join(process.cwd(), 'commands');
const commandFiles = fs.existsSync(commandsPath) ? fs.readdirSync(commandsPath).filter(f => f.endsWith('.js')) : [];
const commands = [];
for (const file of commandFiles) {
  const module = await import(pathToFileURL(path.join(commandsPath, file)).href);
  const command = module.default;
  if (command?.data) commands.push(command.data.toJSON());
}

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

const applicationId = process.env.DISCORD_CLIENT_ID || process.env.CLIENT_ID; // allow either var name
if (!applicationId) {
  console.error('Missing DISCORD_CLIENT_ID in environment.');
  process.exit(1);
}

try {
  if (process.env.DEV_GUILD_ID) {
    const data = await rest.put(Routes.applicationGuildCommands(applicationId, process.env.DEV_GUILD_ID), { body: commands });
    console.log(`Registered ${data.length} guild commands.`);
  } else {
    const data = await rest.put(Routes.applicationCommands(applicationId), { body: commands });
    console.log(`Registered ${data.length} global commands.`);
  }
} catch (err) {
  console.error('Failed to deploy commands:', err);
  process.exit(1);
}

function pathToFileURL(p) {
  const url = new URL('file://');
  const pathname = path.resolve(p).replace(/\\/g, '/');
  url.pathname = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return url;
}


