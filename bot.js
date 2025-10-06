import 'dotenv/config';
import { Client, Collection, GatewayIntentBits, Partials, Events, PermissionFlagsBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, ModalBuilder, TextInputBuilder, TextInputStyle, PermissionsBitField } from 'discord.js';
import { ensureDatabase } from './db.js';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

// Start HTTP server FIRST - this keeps Render happy
const port = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Discord bot is running');
});

server.listen(port, () => {
  console.log(`HTTP server listening on port ${port}`);
});

// Basic env validation
function validateEnv() {
  const token = process.env.DISCORD_TOKEN || '';
  const appId = process.env.DISCORD_CLIENT_ID || process.env.CLIENT_ID || '';
  
  if (!token) {
    console.error('Missing DISCORD_TOKEN in environment.');
    return false;
  }
  
  const looksLikeToken = token.split('.').length === 3 && !token.startsWith('Bot ');
  if (!looksLikeToken) {
    console.error('DISCORD_TOKEN does not look like a valid bot token.');
    return false;
  }
  
  if (!appId) {
    console.error('Missing DISCORD_CLIENT_ID (Application ID) in environment.');
    return false;
  }
  
  return true;
}

// Embed helper
function createBrandEmbed(title, description) {
  const BRAND_COLOR = 0xF1C40F;
  const BOT_DISPLAY_NAME = 'Light Services Ticket-bot';
  const embed = new EmbedBuilder()
    .setColor(BRAND_COLOR)
    .setTitle(title || BOT_DISPLAY_NAME)
    .setDescription(description || null)
    .setFooter({ text: BOT_DISPLAY_NAME });
  return embed;
}

// Initialize database
ensureDatabase();

// Create Discord client
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  partials: [Partials.Channel, Partials.GuildMember, Partials.Message, Partials.Reaction, Partials.User]
});

client.commands = new Collection();

// Load commands function
async function loadCommands() {
  try {
const commandsPath = path.join(process.cwd(), 'commands');
if (fs.existsSync(commandsPath)) {
  const commandFiles = fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'));
  for (const file of commandFiles) {
        try {
    const filePath = path.join(commandsPath, file);
          const command = await import(new URL(filePath, import.meta.url).href);
          if (command.default?.data?.name) {
            client.commands.set(command.default.data.name, command.default);
          }
        } catch (err) {
          console.error(`Failed to load command ${file}:`, err);
        }
      }
    }
  } catch (err) {
    console.error('Failed to load commands:', err);
  }
}

// Start the bot
async function startBot() {
  if (!validateEnv()) {
    console.log('Environment validation failed, but HTTP server is running');
    return;
  }

  try {
    await loadCommands();
    await client.login(process.env.DISCORD_TOKEN);
  } catch (error) {
    console.error('Bot startup failed:', error);
  }
}

// Event handlers
client.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag}`);
  try { 
    c.user.setPresence({ 
      activities: [{ name: 'Light Services tickets', type: 3 }], 
      status: 'online' 
    }); 
  } catch {}
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const command = client.commands.get(interaction.commandName);
      if (!command) return;
      await command.execute(interaction);
      return;
    }

    if (interaction.isButton()) {
      const [scope, action, arg] = interaction.customId.split(':');
      if (scope !== 'ticket') return;
      
      // Simple button handlers
      if (action === 'open') {
        const modal = new ModalBuilder().setCustomId('ticket:open').setTitle('Open a Ticket');
        const reasonInput = new TextInputBuilder()
          .setCustomId('reason')
          .setLabel('Briefly describe your issue')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(1000);
        modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
        await interaction.showModal(modal);
      }
      
      return;
    }

    if (interaction.isModalSubmit()) {
      const [scope, action, arg] = interaction.customId.split(':');
      if (scope !== 'ticket') return;
      
      if (action === 'open') {
        const reason = interaction.fields.getTextInputValue('reason');
        await interaction.reply({ content: `Ticket request received: ${reason}`, ephemeral: true });
      }
      
      return;
    }
  } catch (error) {
    console.error('Interaction error:', error);
    if (interaction.isRepliable()) {
      const content = 'Something went wrong. Please try again or contact staff.';
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({ content, ephemeral: true }).catch(() => {});
      } else {
        await interaction.reply({ content, ephemeral: true }).catch(() => {});
      }
    }
  }
});

// Start the bot
startBot();
