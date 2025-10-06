import http from 'node:http';

// Start HTTP server immediately - this is all Render needs
const port = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Discord bot is running');
});

server.listen(port, () => {
  console.log(`HTTP server listening on port ${port}`);
});

// Keep the process alive
process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down gracefully');
  server.close(() => {
    process.exit(0);
  });
});

// Start Discord bot after HTTP server is running
setTimeout(async () => {
  try {
    const { Client, Collection, GatewayIntentBits, Partials, Events, EmbedBuilder } = await import('discord.js');

const client = new Client({
      intents: [GatewayIntentBits.Guilds],
  partials: [Partials.Channel, Partials.GuildMember, Partials.Message, Partials.Reaction, Partials.User]
});

client.commands = new Collection();

    // Load commands
    const fs = await import('fs');
    const path = await import('path');
    
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
              console.log(`Loaded command: ${command.default.data.name}`);
            }
          } catch (err) {
            console.error(`Failed to load command ${file}:`, err);
          }
        }
      }
    } catch (err) {
      console.error('Failed to load commands:', err);
    }

client.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const command = client.commands.get(interaction.commandName);
          if (!command) {
            console.log(`Command not found: ${interaction.commandName}`);
            return;
          }
          console.log(`Executing command: ${interaction.commandName}`);
      await command.execute(interaction);
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

    await client.login(process.env.DISCORD_TOKEN);
  } catch (error) {
    console.error('Discord bot failed to start:', error);
  }
}, 1000);
